import type {
  AgentError,
  AgentPrompt,
  AgentRunEvent,
  AgentService,
} from "../agent/api.js";
import type { CapturedContext, CaptureService } from "../capture/api.js";
import type {
  ApplicationCommand,
  ApplicationEvent,
  ApplicationEventSink,
  ApplicationHandler,
  ProductFailure,
} from "./api.js";

const CAPTURE_CONTEXT_MAX_CHARACTERS = 12_000;

export interface ApplicationDiagnostic {
  area: "capture";
  phase: "start" | "request" | "stop";
  message: string;
}

export interface ApplicationRuntimeOptions {
  agent: AgentService;
  capture: CaptureService;
  onDiagnostic?: (diagnostic: ApplicationDiagnostic) => void;
}

type ActivePrompt = {
  sessionId: string;
  controller: AbortController;
  phase: "capture" | "agent";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): ProductFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "aborted",
      "busy",
      "invalid-argument",
      "not-found",
      "provider",
      "session",
      "unknown",
    ].includes(error.code) &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      code: error.code as ProductFailure["code"],
      message: error.message,
    };
  }
  return { code: "unknown", message: errorMessage(error) };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "aborted");
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= CAPTURE_CONTEXT_MAX_CHARACTERS
    ? serialized
    : serialized.slice(0, CAPTURE_CONTEXT_MAX_CHARACTERS - 1) + "…";
}

function toAgentPrompt(
  command: Extract<ApplicationCommand, { type: "prompt" }>,
  context: CapturedContext | undefined,
): AgentPrompt {
  return {
    text: command.input.text,
    ...(command.input.images === undefined
      ? {}
      : { images: command.input.images.map((image) => ({ ...image })) }),
    ...(context === undefined
      ? {}
      : {
          context: {
            text: boundedJson({
              captureId: context.captureId,
              capturedAt: context.capturedAt,
              status: context.status,
              application: context.target.application.name,
              applicationBundleIdentifier:
                context.target.application.bundleIdentifier,
              window: context.target.window.title,
              accessibility: context.accessibility,
            }),
            ...(context.image === undefined
              ? {}
              : {
                  images: [
                    {
                      path: context.image.path,
                      mimeType: context.image.mimeType,
                    },
                  ],
                }),
          },
        }),
  };
}

function mapAgentEvent(
  sessionId: string,
  event: AgentRunEvent,
): ApplicationEvent | undefined {
  switch (event.type) {
    case "run-start":
      return { type: "run_started", sessionId };
    case "answer-delta":
      return { type: "answer_delta", sessionId, delta: event.delta };
    case "reasoning-delta":
      return { type: "reasoning_delta", sessionId, delta: event.delta };
    case "tool-start":
      return {
        type: "tool_started",
        sessionId,
        callId: event.callId,
        name: event.name,
        input: event.input,
      };
    case "tool-update":
      return {
        type: "tool_updated",
        sessionId,
        callId: event.callId,
        name: event.name,
        text: event.text,
      };
    case "tool-end":
      return {
        type: "tool_finished",
        sessionId,
        callId: event.callId,
        name: event.name,
        text: event.text,
        isError: event.isError,
      };
    case "complete":
      return undefined;
    case "failure":
      return undefined;
  }
}

export class ApplicationRuntime implements ApplicationHandler {
  private readonly active = new Map<string, ActivePrompt | undefined>();
  private readonly executions = new Set<Promise<void>>();

  constructor(private readonly options: ApplicationRuntimeOptions) {}

  async start(): Promise<void> {
    try {
      await this.options.capture.start();
    } catch (error) {
      this.diagnostic("start", error);
    }
  }

  async stop(): Promise<void> {
    const agentSessions = new Set<string>();
    for (const prompt of this.active.values()) {
      prompt?.controller.abort();
      if (prompt?.phase === "agent") agentSessions.add(prompt.sessionId);
    }
    await Promise.allSettled(
      [...agentSessions].map((sessionId) => this.options.agent.abort(sessionId)),
    );
    await Promise.allSettled([...this.executions]);
    try {
      await this.options.capture.stop();
    } catch (error) {
      this.diagnostic("stop", error);
    }
  }

  execute(
    command: ApplicationCommand,
    emit: ApplicationEventSink,
  ): Promise<void> {
    const execution = this.executeCommand(command, emit);
    this.executions.add(execution);
    void execution.then(
      () => this.executions.delete(execution),
      () => this.executions.delete(execution),
    );
    return execution;
  }

  private async executeCommand(
    command: ApplicationCommand,
    emit: ApplicationEventSink,
  ): Promise<void> {
    if (this.active.has(command.requestId)) {
      await emit({
        type: "failed",
        error: {
          code: "duplicate-request",
          message: `Request is already active: ${command.requestId}`,
        },
      });
      return;
    }
    this.active.set(command.requestId, undefined);
    try {
      await this.dispatch(command, emit);
      await emit({ type: "completed" });
    } catch (error) {
      await emit({ type: "failed", error: failure(error) });
    } finally {
      this.active.delete(command.requestId);
    }
  }

  private async dispatch(
    command: ApplicationCommand,
    emit: ApplicationEventSink,
  ): Promise<void> {
    switch (command.type) {
      case "list_sessions":
        await emit({ type: "sessions", sessions: await this.options.agent.listSessions() });
        return;
      case "create_session":
        await emit({ type: "session_view", view: await this.options.agent.createSession() });
        return;
      case "get_session":
        await emit({ type: "session_view", view: await this.options.agent.getSession(command.sessionId) });
        return;
      case "rename_session":
        await emit({
          type: "session_renamed",
          session: await this.options.agent.renameSession(command.sessionId, command.name),
        });
        return;
      case "prompt":
        await this.prompt(command, emit);
        return;
      case "abort":
        await this.abort(command);
        await emit({ type: "abort_completed", targetRequestId: command.targetRequestId });
        return;
      case "compact":
        await emit({
          type: "compaction_completed",
          sessionId: command.sessionId,
          automatic: false,
          result: await this.options.agent.compact(command.sessionId, command.instructions),
        });
        return;
      case "set_thinking":
        await emit({
          type: "state_updated",
          sessionId: command.sessionId,
          state: await this.options.agent.setThinking(command.sessionId, command.thinking),
        });
        return;
    }
  }

  private async prompt(
    command: Extract<ApplicationCommand, { type: "prompt" }>,
    emit: ApplicationEventSink,
  ): Promise<void> {
    const active: ActivePrompt = {
      sessionId: command.sessionId,
      controller: new AbortController(),
      phase: "capture",
    };
    this.active.set(command.requestId, active);
    let context: CapturedContext | undefined;
    try {
      context = await this.options.capture.capture(
        command.requestId,
        active.controller.signal,
      );
    } catch (error) {
      if (isAbort(error, active.controller.signal)) {
        throw new ErrorWithCode("aborted", "Request was aborted");
      }
      this.diagnostic("request", error);
    }
    if (active.controller.signal.aborted) {
      throw new ErrorWithCode("aborted", "Request was aborted");
    }
    active.phase = "agent";
    const result = await this.options.agent.prompt(
      command.sessionId,
      toAgentPrompt(command, context),
      async (event) => {
        const mapped = mapAgentEvent(command.sessionId, event);
        if (mapped !== undefined) await emit(mapped);
      },
    );
    await emit({
      type: "answer_completed",
      sessionId: command.sessionId,
      answer: result.answer,
      contextUsage: result.contextUsage,
    });
    const compacted = await this.options.agent.compactIfNeeded(command.sessionId);
    if (compacted !== undefined) {
      await emit({
        type: "compaction_completed",
        sessionId: command.sessionId,
        automatic: true,
        result: compacted,
      });
    }
  }

  private async abort(
    command: Extract<ApplicationCommand, { type: "abort" }>,
  ): Promise<void> {
    const target = this.active.get(command.targetRequestId);
    if (target === undefined || target.sessionId !== command.sessionId) return;
    target.controller.abort();
    if (target.phase === "agent") {
      await this.options.agent.abort(command.sessionId);
    }
  }

  private diagnostic(
    phase: ApplicationDiagnostic["phase"],
    error: unknown,
  ): void {
    this.options.onDiagnostic?.({ area: "capture", phase, message: errorMessage(error) });
  }
}

class ErrorWithCode extends Error {
  constructor(readonly code: AgentError["code"], message: string) {
    super(message);
  }
}
