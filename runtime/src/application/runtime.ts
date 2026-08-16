import type {
  AgentImage,
  AgentError,
  AgentPrompt,
  AgentRunEvent,
  AgentService,
} from "../agent/api.js";
import type {
  CapturedFrameImage,
  CapturedContext,
  CapturedFrameContext,
  CaptureService,
} from "../capture/api.js";
import type {
  ApplicationCommand,
  ApplicationEvent,
  ApplicationEventSink,
  ApplicationHandler,
  ProductFailure,
} from "./api.js";

const CAPTURE_CONTEXT_MAX_CHARACTERS = 12_000;
type ScreenFrame = CapturedFrameContext["frames"][number];

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

function frameProvenance(frame: ScreenFrame): Record<string, unknown> {
  return {
    sourceId: frame.sourceId,
    generationId: frame.generationId,
    frameId: frame.frameId,
    monitorKey: frame.monitorKey,
    capturedAt: frame.capturedAt,
  };
}

function addProjectedString(
  frame: Record<string, unknown>,
  key: string,
  original: string,
  serialize: () => string,
): void {
  frame[key] = "";
  if (serialize().length > CAPTURE_CONTEXT_MAX_CHARACTERS) {
    delete frame[key];
    return;
  }
  let low = 0;
  let high = original.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    frame[key] = original.slice(0, middle);
    if (serialize().length <= CAPTURE_CONTEXT_MAX_CHARACTERS) {
      best = original.slice(0, middle);
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best.length === 0) {
    delete frame[key];
  } else {
    frame[key] = best;
  }
}

function addProjectedFocused(
  frame: Record<string, unknown>,
  focused: boolean,
  serialize: () => string,
): void {
  frame.focused = focused;
  if (serialize().length > CAPTURE_CONTEXT_MAX_CHARACTERS) delete frame.focused;
}

function matchingFrameImages(
  frames: ScreenFrame[],
  images: CapturedFrameImage[] | undefined,
): AgentImage[] | undefined {
  if (images === undefined) return undefined;
  if (frames.length === 0) return undefined;
  if (frames.length !== images.length) return undefined;
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index]?.sourceId !== images[index]?.sourceId) return undefined;
  }
  return images.map((image) => ({
    data: new Uint8Array(image.data),
    mimeType: image.mimeType,
  }));
}

function projectFrameContext(
  frames: ScreenFrame[],
  images: AgentImage[] | undefined,
  imageOmissionReason?: "frame_image_mapping_mismatch",
): {
  text: string;
  images?: AgentImage[];
} {
  if (frames.length === 0) {
    return {
      text: JSON.stringify({
        frames: [],
        ...(imageOmissionReason === undefined ? {} : { imageOmissionReason }),
      }),
      ...(images === undefined ? {} : { images }),
    };
  }
  const projectedFrames = frames.map(frameProvenance);
  const base = { frames: projectedFrames };
  const withReason = {
    ...base,
    ...(imageOmissionReason === undefined ? {} : { imageOmissionReason }),
  };
  const includeReason = imageOmissionReason !== undefined &&
    JSON.stringify(withReason).length <= CAPTURE_CONTEXT_MAX_CHARACTERS;
  const serialize = () => JSON.stringify(includeReason ? withReason : base);
  if (serialize().length > CAPTURE_CONTEXT_MAX_CHARACTERS) {
    return {
      text: JSON.stringify({
        frames: [],
        omittedFrameCount: frames.length,
        omissionReason: "provenance_budget_exceeded",
      }),
    };
  }
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const projected = projectedFrames[index];
    if (frame === undefined || projected === undefined) continue;
    addProjectedString(projected, "trigger", frame.trigger, serialize);
    addProjectedString(projected, "deviceName", frame.deviceName, serialize);
    if (frame.application !== undefined) {
      addProjectedString(projected, "application", frame.application, serialize);
    }
    if (frame.windowTitle !== undefined) {
      addProjectedString(projected, "windowTitle", frame.windowTitle, serialize);
    }
    if (frame.url !== undefined) {
      addProjectedString(projected, "url", frame.url, serialize);
    }
    if (frame.focused !== undefined) {
      addProjectedFocused(projected, frame.focused, serialize);
    }
  }
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const projected = projectedFrames[index];
    if (frame?.visibleText === undefined || projected === undefined) continue;
    addProjectedString(projected, "visibleText", frame.visibleText, serialize);
  }
  return {
    text: serialize(),
    ...(images === undefined ? {} : { images }),
  };
}

function toAgentPrompt(
  command: Extract<ApplicationCommand, { type: "prompt" }>,
  context: CapturedContext | undefined,
): AgentPrompt {
  const prompt = {
    text: command.input.text,
    ...(command.input.images === undefined
      ? {}
      : { images: command.input.images.map((image) => ({ ...image })) }),
  };
  if (context === undefined) return prompt;
  const images = matchingFrameImages(context.frames, context.images);
  const projected = projectFrameContext(
    context.frames,
    images,
    context.frames.length > 0 && images === undefined
      ? "frame_image_mapping_mismatch"
      : undefined,
  );
  return {
    ...prompt,
    context: {
      text: projected.text,
      ...(projected.images === undefined ? {} : { images: projected.images }),
    },
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
