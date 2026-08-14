import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentServiceError,
  type AgentCompactionResult,
  type AgentEventListener,
  type AgentPrompt,
  type AgentService,
  type AgentSessionView,
} from "../../src/agent/api.js";
import type {
  ApplicationCommand,
  ApplicationEvent,
} from "../../src/application/api.js";
import { ApplicationRuntime } from "../../src/application/runtime.js";
import type {
  CapturedContext,
  CaptureService,
} from "../../src/capture/api.js";

function sessionView(id = "session-1"): AgentSessionView {
  return {
    session: {
      id,
      createdAt: "2026-08-13T00:00:00.000Z",
      name: "Session",
    },
    messages: [],
    state: { thinking: "medium" },
  };
}

function capturedContext(requestId: string): CapturedContext {
  return {
    requestId,
    captureId: "capture-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
    capturedAt: "2026-08-13T00:00:00.100Z",
    status: "complete",
    target: {
      application: {
        processIdentifier: 42,
        bundleIdentifier: "com.example.Editor",
        name: "Editor",
      },
      window: { identifier: 7, title: "notes.txt" },
    },
    image: {
      path: "/private/data/screen-captures/capture-1.jpg",
      mimeType: "image/jpeg",
      width: 1280,
      height: 720,
    },
    accessibility: {
      captureId: "capture-1",
      application: "Editor",
      windowTitle: "notes.txt",
      focusedElement: { role: "AXTextArea", value: "draft" },
      visibleText: "bounded visible text",
    },
    diagnostics: {
      intentRevision: 10,
      artifactRevision: 10,
      completedRevision: 10,
      intentContentEpoch: 3,
      artifactContentEpoch: 3,
      completedContentEpoch: 3,
      screenshotStatus: "available",
      accessibilityStatus: "available",
    },
  };
}

type AgentOverrides = Partial<AgentService> & {
  onPrompt?: (
    sessionId: string,
    prompt: AgentPrompt,
    onEvent?: AgentEventListener,
  ) => Promise<{
    sessionId: string;
    answer: string;
    contextUsage: { contextTokens: number; contextWindow: number };
  }>;
};

function fakeAgent(overrides: AgentOverrides = {}): AgentService {
  const view = sessionView();
  return {
    createSession: async () => view,
    listSessions: async () => [view.session],
    getSession: async () => view,
    renameSession: async (_id, name) => ({ ...view.session, name }),
    prompt: overrides.onPrompt ?? (async (sessionId) => ({
      sessionId,
      answer: "answer",
      contextUsage: { contextTokens: 100, contextWindow: 1_000 },
    })),
    abort: async () => {},
    compact: async () => ({
      summary: "summary",
      firstKeptEntryId: "kept",
      tokensBefore: 900,
    }),
    compactIfNeeded: async () => undefined,
    setThinking: async () => view.state,
    ...overrides,
  };
}

function fakeCapture(
  capture: CaptureService["capture"] = async (requestId) =>
    capturedContext(requestId),
): CaptureService {
  return {
    start: async () => {},
    stop: async () => {},
    capture,
  };
}

async function execute(
  runtime: ApplicationRuntime,
  command: ApplicationCommand,
): Promise<ApplicationEvent[]> {
  const events: ApplicationEvent[] = [];
  await runtime.execute(command, (event) => {
    events.push(event);
  });
  return events;
}

test("prompt injects bounded Capture context while keeping user images visible", async () => {
  let receivedPrompt: AgentPrompt | undefined;
  const automaticCompaction: AgentCompactionResult = {
    summary: "automatic summary",
    firstKeptEntryId: "kept",
    tokensBefore: 900,
  };
  const agent = fakeAgent({
    onPrompt: async (sessionId, prompt, onEvent) => {
      receivedPrompt = prompt;
      await onEvent?.({ type: "run-start" });
      await onEvent?.({ type: "reasoning-delta", delta: "reason" });
      await onEvent?.({ type: "answer-delta", delta: "answer" });
      await onEvent?.({
        type: "tool-start",
        callId: "call-1",
        name: "read",
        input: { path: "notes.txt" },
      });
      await onEvent?.({
        type: "tool-end",
        callId: "call-1",
        name: "read",
        text: "contents",
        isError: false,
      });
      await onEvent?.({ type: "complete", answer: "answer" });
      return {
        sessionId,
        answer: "answer",
        contextUsage: { contextTokens: 800, contextWindow: 1_000 },
      };
    },
    compactIfNeeded: async () => automaticCompaction,
  });
  const runtime = new ApplicationRuntime({ agent, capture: fakeCapture() });

  const events = await execute(runtime, {
    requestId: "request-1",
    type: "prompt",
    sessionId: "session-1",
    input: {
      text: "What is on screen?",
      images: [{ path: "/tmp/user.png", mimeType: "image/png" }],
    },
  });

  assert.ok(receivedPrompt);
  assert.deepEqual(receivedPrompt.images, [
    { path: "/tmp/user.png", mimeType: "image/png" },
  ]);
  assert.deepEqual(receivedPrompt.context?.images, [
    {
      path: "/private/data/screen-captures/capture-1.jpg",
      mimeType: "image/jpeg",
    },
  ]);
  assert.match(receivedPrompt.context?.text ?? "", /"application":"Editor"/);
  assert.match(receivedPrompt.context?.text ?? "", /bounded visible text/);
  assert.ok((receivedPrompt.context?.text?.length ?? 0) <= 12_000);
  assert.deepEqual(events.map((event) => event.type), [
    "run_started",
    "reasoning_delta",
    "answer_delta",
    "tool_started",
    "tool_finished",
    "answer_completed",
    "compaction_completed",
    "completed",
  ]);
  assert.equal(
    events.filter((event) => event.type === "answer_completed").length,
    1,
  );
  assert.deepEqual(
    events.find((event) => event.type === "answer_completed"),
    {
      type: "answer_completed",
      sessionId: "session-1",
      answer: "answer",
      contextUsage: { contextTokens: 800, contextWindow: 1_000 },
    },
  );
  assert.deepEqual(events.at(-2), {
    type: "compaction_completed",
    sessionId: "session-1",
    automatic: true,
    result: automaticCompaction,
  });
});

test("capture failure is non-fatal and prompts without injected context", async () => {
  let receivedPrompt: AgentPrompt | undefined;
  const diagnostics: string[] = [];
  const runtime = new ApplicationRuntime({
    agent: fakeAgent({
      onPrompt: async (sessionId, prompt) => {
        receivedPrompt = prompt;
        return {
          sessionId,
          answer: "without capture",
          contextUsage: { contextTokens: 1, contextWindow: 100 },
        };
      },
    }),
    capture: fakeCapture(async () => {
      throw new Error("capture unavailable");
    }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });

  const events = await execute(runtime, {
    requestId: "request-fallback",
    type: "prompt",
    sessionId: "session-1",
    input: { text: "continue" },
  });

  assert.equal(receivedPrompt?.context, undefined);
  assert.deepEqual(events.map((event) => event.type), [
    "answer_completed",
    "completed",
  ]);
  assert.deepEqual(diagnostics, ["capture unavailable"]);
});

test("abort cancels Capture before Agent starts", async () => {
  let captureStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    captureStarted = resolve;
  });
  let promptCalls = 0;
  let abortCalls = 0;
  const agent = fakeAgent({
    onPrompt: async (sessionId) => {
      promptCalls += 1;
      return {
        sessionId,
        answer: "unexpected",
        contextUsage: { contextTokens: 1, contextWindow: 100 },
      };
    },
    abort: async () => {
      abortCalls += 1;
    },
  });
  const capture = fakeCapture(async (_requestId, signal) => {
    captureStarted();
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  });
  const runtime = new ApplicationRuntime({ agent, capture });
  const promptEvents: ApplicationEvent[] = [];
  const prompt = runtime.execute(
    {
      requestId: "prompt-request",
      type: "prompt",
      sessionId: "session-1",
      input: { text: "wait" },
    },
    (event) => {
      promptEvents.push(event);
    },
  );
  await started;

  const abortEvents = await execute(runtime, {
    requestId: "abort-request",
    type: "abort",
    sessionId: "session-1",
    targetRequestId: "prompt-request",
  });
  await prompt;

  assert.equal(promptCalls, 0);
  assert.equal(abortCalls, 0);
  assert.deepEqual(promptEvents.at(-1), {
    type: "failed",
    error: { code: "aborted", message: "Request was aborted" },
  });
  assert.deepEqual(abortEvents.map((event) => event.type), [
    "abort_completed",
    "completed",
  ]);
});

test("normalizes foreign error codes at the product boundary", async () => {
  const runtime = new ApplicationRuntime({
    agent: fakeAgent({
      listSessions: async () => {
        throw Object.assign(new Error("filesystem denied"), { code: "EACCES" });
      },
    }),
    capture: fakeCapture(),
  });

  const events = await execute(runtime, {
    requestId: "foreign-error",
    type: "list_sessions",
  });

  assert.deepEqual(events, [
    {
      type: "failed",
      error: { code: "unknown", message: "filesystem denied" },
    },
  ]);

});

test("abort delegates to Agent after Capture completes", async () => {
  let agentStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    agentStarted = resolve;
  });
  let rejectPrompt!: (error: unknown) => void;
  let abortCalls = 0;
  const agent = fakeAgent({
    onPrompt: async () => {
      agentStarted();
      return new Promise((_, reject) => {
        rejectPrompt = reject;
      });
    },
    abort: async () => {
      abortCalls += 1;
      rejectPrompt(new AgentServiceError("aborted", "prompt aborted"));
    },
  });
  const runtime = new ApplicationRuntime({ agent, capture: fakeCapture() });
  const promptEvents: ApplicationEvent[] = [];
  const prompt = runtime.execute(
    {
      requestId: "agent-prompt",
      type: "prompt",
      sessionId: "session-1",
      input: { text: "wait for agent" },
    },
    (event) => {
      promptEvents.push(event);
    },
  );
  await started;

  await execute(runtime, {
    requestId: "agent-abort",
    type: "abort",
    sessionId: "session-1",
    targetRequestId: "agent-prompt",
  });
  await prompt;

  assert.equal(abortCalls, 1);
  assert.deepEqual(promptEvents.at(-1), {
    type: "failed",
    error: { code: "aborted", message: "prompt aborted" },
  });
});

test("duplicate request ids fail independently without contaminating the active prompt", async () => {
  let releaseCapture!: () => void;
  const captureRelease = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const runtime = new ApplicationRuntime({
    agent: fakeAgent(),
    capture: fakeCapture(async (requestId) => {
      await captureRelease;
      return capturedContext(requestId);
    }),
  });
  const firstEvents: ApplicationEvent[] = [];
  const first = runtime.execute(
    {
      requestId: "duplicate",
      type: "prompt",
      sessionId: "session-1",
      input: { text: "first" },
    },
    (event) => {
      firstEvents.push(event);
    },
  );

  const duplicateEvents = await execute(runtime, {
    requestId: "duplicate",
    type: "list_sessions",
  });
  releaseCapture();
  await first;

  assert.deepEqual(duplicateEvents, [
    {
      type: "failed",
      error: {
        code: "duplicate-request",
        message: "Request is already active: duplicate",
      },
    },
  ]);
  assert.equal(firstEvents.at(-1)?.type, "completed");
});

test("delegates all non-prompt Agent commands and emits product DTOs", async () => {
  const calls: string[] = [];
  const view = sessionView();
  const agent = fakeAgent({
    createSession: async () => (calls.push("create"), view),
    listSessions: async () => (calls.push("list"), [view.session]),
    getSession: async () => (calls.push("get"), view),
    renameSession: async (_id, name) => (
      calls.push("rename"), { ...view.session, name }
    ),
    compact: async () => (
      calls.push("compact"), {
        summary: "summary",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
      }
    ),
    setThinking: async () => (calls.push("thinking"), view.state),
  });
  const runtime = new ApplicationRuntime({ agent, capture: fakeCapture() });
  const commands: ApplicationCommand[] = [
    { requestId: "1", type: "list_sessions" },
    { requestId: "2", type: "create_session" },
    { requestId: "3", type: "get_session", sessionId: "session-1" },
    {
      requestId: "4",
      type: "rename_session",
      sessionId: "session-1",
      name: "Renamed",
    },
    { requestId: "6", type: "compact", sessionId: "session-1" },
    {
      requestId: "9",
      type: "set_thinking",
      sessionId: "session-1",
      thinking: "high",
    },
  ];

  const eventTypes = await Promise.all(
    commands.map(async (command) =>
      (await execute(runtime, command)).map((event) => event.type)
    ),
  );

  assert.deepEqual(calls, [
    "list",
    "create",
    "get",
    "rename",
    "compact",
    "thinking",
  ]);
  assert.deepEqual(eventTypes, [
    ["sessions", "completed"],
    ["session_view", "completed"],
    ["session_view", "completed"],
    ["session_renamed", "completed"],
    ["compaction_completed", "completed"],
    ["state_updated", "completed"],
  ]);
});

test("Capture startup failure is diagnostic-only and Agent commands stay usable", async () => {
  let stopCalls = 0;
  const diagnostics: string[] = [];
  const capture = fakeCapture();
  capture.start = async () => {
    throw new Error("helper missing");
  };
  capture.stop = async () => {
    stopCalls += 1;
  };
  const runtime = new ApplicationRuntime({
    agent: fakeAgent(),
    capture,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });

  await runtime.start();
  const events = await execute(runtime, {
    requestId: "list-after-start-failure",
    type: "list_sessions",
  });
  await runtime.stop();

  assert.deepEqual(diagnostics, ["helper missing"]);
  assert.deepEqual(events.map((event) => event.type), ["sessions", "completed"]);
  assert.equal(stopCalls, 1);
});

test("stop waits for an aborted Agent execution to finish before Capture cleanup", async () => {
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let releasePrompt!: () => void;
  const promptRelease = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  let captureStopped = false;
  const runtime = new ApplicationRuntime({
    agent: fakeAgent({
      onPrompt: async () => {
        promptStarted();
        await promptRelease;
        throw new AgentServiceError("aborted", "prompt aborted");
      },
      abort: async () => {},
    }),
    capture: {
      ...fakeCapture(),
      stop: async () => {
        captureStopped = true;
      },
    },
  });
  const execution = runtime.execute(
    {
      requestId: "shutdown-prompt",
      type: "prompt",
      sessionId: "session-1",
      input: { text: "wait" },
    },
    () => {},
  );
  await started;

  let stopSettled = false;
  const stopping = runtime.stop().then(() => {
    stopSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopSettled, false);
  assert.equal(captureStopped, false);
  releasePrompt();
  await Promise.all([execution, stopping]);
  assert.equal(captureStopped, true);
});
