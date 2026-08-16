import {
  calculateContextTokens,
  createCustomMessage,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";

import {
  AgentServiceError,
  type AgentEventListener,
  type AgentImage,
  type AgentPrompt,
  type AgentRunEvent,
  type AgentRunResult,
} from "../api.js";
import {
  MEMORY_CITATION_ENTRY_TYPE,
  MemoryCitationStreamFilter,
  MemoryFileAccessTracker,
  stripMemoryCitationBlock,
  validateMemoryCitation,
} from "./memory-citation.js";
import { PiSessionRuntime } from "./session-runtime.js";

const INJECTED_CONTEXT_TYPE = "openscreen.injected-context";

type ActivePrompt = {
  aborted: boolean;
};

export interface PiPromptRunnerOptions {
  runtime: PiSessionRuntime;
  cwd: string;
  normalizeError: (error: unknown) => AgentServiceError;
  onPromptSettled?: (sessionId: string) => void | Promise<void>;
  loadPromptSystemContext?: () => string | undefined | Promise<string | undefined>;
  memoryCitationRoot?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = asRecord(item);
    return block.type === "text" && typeof block.text === "string"
      ? block.text
      : "";
  }).join("");
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function hasErrorCause(error: unknown, expected: Error): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === expected) return true;
    if (!(candidate instanceof Error) || visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate.cause !== undefined) pending.push(candidate.cause);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
  }
  return false;
}

function toolText(result: unknown): string {
  return contentText(asRecord(result).content);
}

function mapHarnessEvent(
  event: AgentHarnessEvent,
  streamFilter?: MemoryCitationStreamFilter,
): AgentRunEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "run-start" };
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        const delta = streamFilter?.push(event.assistantMessageEvent.delta) ??
          event.assistantMessageEvent.delta;
        if (!delta) return undefined;
        return {
          type: "answer-delta",
          delta,
        };
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return {
          type: "reasoning-delta",
          delta: event.assistantMessageEvent.delta,
        };
      }
      return undefined;
    case "tool_execution_start":
      return {
        type: "tool-start",
        callId: event.toolCallId,
        name: event.toolName,
        input: asRecord(event.args),
      };
    case "tool_execution_update":
      return {
        type: "tool-update",
        callId: event.toolCallId,
        name: event.toolName,
        text: toolText(event.partialResult),
      };
    case "tool_execution_end":
      return {
        type: "tool-end",
        callId: event.toolCallId,
        name: event.toolName,
        text: toolText(event.result),
        isError: event.isError,
      };
    default:
      return undefined;
  }
}

async function notify(
  listener: AgentEventListener | undefined,
  event: AgentRunEvent,
): Promise<void> {
  try {
    await listener?.(event);
  } catch {
    // Event consumers cannot affect Agent execution or persistence.
  }
}

export class PiPromptRunner {
  private readonly active = new Map<string, ActivePrompt>();

  constructor(private readonly options: PiPromptRunnerOptions) {}

  private notifyPromptSettled(sessionId: string): void {
    const listener = this.options.onPromptSettled;
    if (listener === undefined) return;
    queueMicrotask(() => {
      try {
        void Promise.resolve(listener(sessionId)).catch(() => {
          // Memory notification failures cannot affect the completed prompt.
        });
      } catch {
        // Memory notification failures cannot affect the completed prompt.
      }
    });
  }

  private async loadImages(
    images: AgentImage[] | undefined,
  ): Promise<ImageContent[]> {
    return Promise.all((images ?? []).map(async (image) => {
      let data: Uint8Array;
      if ("data" in image) {
        data = new Uint8Array(image.data);
      } else {
        const result = await this.options.runtime.env.readBinaryFile(image.path);
        if (!result.ok) {
          throw new AgentServiceError("invalid-argument", result.error.message, {
            cause: result.error,
          });
        }
        data = result.value;
      }
      return {
        type: "image" as const,
        data: Buffer.from(data).toString("base64"),
        mimeType: image.mimeType,
      };
    }));
  }

  private async contextMessage(prompt: AgentPrompt) {
    if (!prompt.context) return undefined;
    const images = await this.loadImages(prompt.context.images);
    const content = [
      ...(prompt.context.text
        ? [{ type: "text" as const, text: prompt.context.text }]
        : []),
      ...images,
    ];
    if (content.length === 0) return undefined;
    return createCustomMessage(
      INJECTED_CONTEXT_TYPE,
      content,
      false,
      undefined,
      new Date().toISOString(),
    );
  }

  private async promptSystemContext(): Promise<string | undefined> {
    try {
      const context = await this.options.loadPromptSystemContext?.();
      return context?.trim() || undefined;
    } catch {
      // Optional historical context cannot affect prompt execution.
      return undefined;
    }
  }

  async run(
    sessionId: string,
    prompt: AgentPrompt,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult> {
    if (this.active.has(sessionId)) {
      throw new AgentServiceError(
        "busy",
        `Session prompt is already running: ${sessionId}`,
      );
    }
    const activePrompt: ActivePrompt = { aborted: false };
    this.active.set(sessionId, activePrompt);
    try {
      return await this.options.runtime.mutate(sessionId, async () => {
        const entry = await this.options.runtime.getEntry(sessionId);
        const [images, contextMessage, promptSystemContext] = await Promise.all([
          this.loadImages(prompt.images),
          this.contextMessage(prompt),
          this.promptSystemContext(),
        ]);
        const abortMarker = new Error("Agent run was aborted");
        const streamFilter = this.options.memoryCitationRoot === undefined
          ? undefined
          : new MemoryCitationStreamFilter();
        const accessTracker = this.options.memoryCitationRoot === undefined
          ? undefined
          : new MemoryFileAccessTracker(
              this.options.memoryCitationRoot,
              this.options.cwd,
            );
        const throwIfAborted = () => {
          if (activePrompt.aborted) throw abortMarker;
        };
        let contextInjected = false;
        const removeContextHook = entry.harness.on(
          "before_agent_start",
          (event) => {
            throwIfAborted();
            if (
              contextMessage === undefined &&
              promptSystemContext === undefined
            ) {
              return undefined;
            }
            if (contextInjected) return undefined;
            contextInjected = true;
            return {
              ...(contextMessage === undefined ? {} : { messages: [contextMessage] }),
              ...(promptSystemContext === undefined
                ? {}
                : {
                    systemPrompt: `${event.systemPrompt}\n\n${promptSystemContext}`,
                  }),
            };
          },
        );
        const removeProviderGuard = entry.harness.on(
          "before_provider_request",
          () => {
            throwIfAborted();
            return undefined;
          },
        );
        const unsubscribe = onEvent || accessTracker
          ? entry.harness.subscribe(async (event) => {
              accessTracker?.observe(event);
              const mapped = mapHarnessEvent(event, streamFilter);
              if (mapped) await notify(onEvent, mapped);
            })
          : undefined;
        try {
          if (activePrompt.aborted) {
            throw new AgentServiceError("aborted", "Agent run was aborted");
          }
          const response = await entry.harness.prompt(prompt.text, {
            images,
          });
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            const aborted = response.stopReason === "aborted" ||
              (activePrompt.aborted && response.errorMessage === abortMarker.message);
            const error = new AgentServiceError(
              aborted ? "aborted" : "provider",
              response.errorMessage ?? "Agent run failed",
            );
            await notify(onEvent, {
              type: "failure",
              error: { code: error.code, message: error.message },
            });
            throw error;
          }
          const trailingDelta = streamFilter?.finish();
          if (trailingDelta) {
            await notify(onEvent, { type: "answer-delta", delta: trailingDelta });
          }
          const stripped = stripMemoryCitationBlock(assistantText(response));
          const answer = stripped.text;
          if (
            stripped.citationJson !== undefined &&
            this.options.memoryCitationRoot !== undefined &&
            accessTracker !== undefined
          ) {
            try {
              const citation = await validateMemoryCitation(
                stripped.citationJson,
                this.options.memoryCitationRoot,
                accessTracker,
              );
              await entry.session.appendCustomEntry(
                MEMORY_CITATION_ENTRY_TYPE,
                citation,
              );
            } catch {
              // Invalid model-authored provenance is discarded, not user-visible.
            }
          }
          const responseModel = this.options.runtime.findModel(
            response.provider,
            response.model,
          );
          if (responseModel === undefined) {
            const error = new AgentServiceError(
              "provider",
              `Completed response references unavailable model: ${response.provider}/${response.model}`,
            );
            await notify(onEvent, {
              type: "failure",
              error: { code: error.code, message: error.message },
            });
            throw error;
          }
          await notify(onEvent, { type: "complete", answer });
          this.notifyPromptSettled(sessionId);
          return {
            sessionId,
            answer,
            contextUsage: {
              contextTokens: calculateContextTokens(response.usage),
              contextWindow: responseModel.contextWindow,
            },
          };
        } catch (error) {
          const normalized = hasErrorCause(error, abortMarker)
            ? new AgentServiceError("aborted", abortMarker.message, {
                cause: error instanceof Error ? error : abortMarker,
              })
            : this.options.normalizeError(error);
          if (!(error instanceof AgentServiceError)) {
            await notify(onEvent, {
              type: "failure",
              error: { code: normalized.code, message: normalized.message },
            });
          }
          throw normalized;
        } finally {
          removeContextHook?.();
          removeProviderGuard();
          unsubscribe?.();
        }
      });
    } finally {
      if (this.active.get(sessionId) === activePrompt) {
        this.active.delete(sessionId);
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const activePrompt = this.active.get(sessionId);
    if (activePrompt !== undefined) activePrompt.aborted = true;
    await (await this.options.runtime.getEntry(sessionId)).harness.abort();
  }
}
