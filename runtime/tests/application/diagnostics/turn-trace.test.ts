import assert from "node:assert/strict";
import test from "node:test";
import type { AgentService } from "../../../src/agent/api.js";
import { ApplicationRuntime } from "../../../src/application/runtime.js";
import { TurnTrace } from "../../../src/application/diagnostics/turn-trace.js";
import type { TracePayload, TraceAttachment } from "../../../src/application/diagnostics/schema.js";
type Observation = { threadId: string; turnId: string | null; payload: TracePayload; details?: TraceAttachment };
function turn(ids: { sessionId: string; requestId: string }, records: Observation[]) {
  return new TurnTrace({ threadId: ids.sessionId, turnId: ids.requestId, requestId: ids.requestId },
    (turnId, payload, details) => { records.push({ threadId: ids.sessionId, turnId, payload, details }); });
}

function unusedAgent(overrides: Partial<AgentService> = {}): AgentService {
  return {
    async createSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async getSession() { throw new Error("unused"); },
    async renameSession() { throw new Error("unused"); },
    async abort() {},
    async compact() { throw new Error("unused"); },
    async setThinking() { return { thinking: "off" }; },
    async prompt(sessionId) { return { sessionId, answer: "ok", contextUsage: { contextTokens: 1, contextWindow: 100 } }; },
    async compactIfNeeded() { return undefined; },
    ...overrides,
  };
}

test("records the whole prompt lifecycle independently of product events", async () => {
  const recorded: string[] = [];
  const agent: AgentService = {
    async createSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async getSession() { throw new Error("unused"); },
    async renameSession() { throw new Error("unused"); },
    async abort() {},
    async compact() { throw new Error("unused"); },
    async setThinking() { return { thinking: "off" }; },
    async prompt(sessionId, _prompt, emit) {
      await emit?.({ type: "tool-start", callId: "call-1", name: "read", input: { path: "secret" } });
      await emit?.({ type: "tool-end", callId: "call-1", name: "read", text: "secret", isError: false });
      return { sessionId, answer: "secret", contextUsage: { contextTokens: 1, contextWindow: 100 } };
    },
    async compactIfNeeded() { return undefined; },
  };
  const runtime = new ApplicationRuntime({
    agent,
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
    ...{
      turnDiagnostics: () => ({
        stage(phase: string, boundary: string) { recorded.push(`${phase}:${boundary}`); },
        agentEvent(event: { type: string }) { recorded.push(event.type); },
        agentDiagnostic() {},
        finish(status: string) { recorded.push(status); },
      }),
    },
  });
  const events: string[] = [];
  await runtime.execute({ type: "prompt", requestId: "request-1", sessionId: "session-1", input: { text: "secret" } }, event => { events.push(event.type); });
  assert.deepEqual(recorded, ["capture:start", "capture:end", "agent:start", "tool-start", "tool-end", "agent:end", "compaction:start", "compaction:end", "completed"]);
  assert.deepEqual(events, ["tool_started", "tool_finished", "answer_completed", "completed"]);
});

test("concurrent prompts keep inference and tool IDs inside independent turns", async () => {
  const records: Observation[] = [];
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>(resolve => { release = resolve; });
  const runtime = new ApplicationRuntime({
    agent: unusedAgent({
      async prompt(sessionId, _prompt, emit, diagnose) {
        await diagnose?.({ type: "model-start", invocationId: "model-1", provider: "test", model: "test" });
        await emit?.({ type: "tool-start", callId: "call-1", name: "read", input: {} });
        if (++entered === 2) release();
        await bothEntered;
        await emit?.({ type: "tool-end", callId: "call-1", name: "read", text: "private", isError: false });
        return { sessionId, answer: "ok", contextUsage: { contextTokens: 1, contextWindow: 100 } };
      },
    }),
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
    turnDiagnostics: ids => turn(ids, records),
  });
  await Promise.all(["a", "b"].map(id => runtime.execute({ type: "prompt", requestId: id, sessionId: id, input: { text: "private" } }, () => {})));
  for (const id of ["a", "b"]) {
    const own = records.filter(record => record.turnId === id);
    assert.ok(own.every(record => record.threadId === id));
    assert.equal(own.filter(record => record.payload.type === "tool_call_ended").length, 1);
    assert.deepEqual(own.at(-1)?.payload, { type: "codex_turn_ended", codex_turn_id: id, status: "completed" });
  }
  assert.ok(!JSON.stringify(records).includes("private"));
});

test("capture degradation is recorded without failing the prompt; unavailable diagnostics are optional", async () => {
  const records: Observation[] = [];
  const options = {
    agent: unusedAgent(),
    capture: { async start() {}, async stop() {}, async capture(): Promise<never> { throw new Error("private cause"); } },
  };
  const runtime = new ApplicationRuntime({ ...options, turnDiagnostics: ids => turn(ids, records) });
  await runtime.execute({ type: "prompt", requestId: "a", sessionId: "a", input: { text: "private" } }, () => {});
  assert.ok(records.some(record => record.payload.type === "other" && record.payload.metadata.status === "degraded"));
  assert.deepEqual(records.at(-1)?.payload, { type: "codex_turn_ended", codex_turn_id: "a", status: "completed" });
  assert.ok(!JSON.stringify(records).includes("private"));
  const unavailable = new ApplicationRuntime({ ...options, turnDiagnostics() { throw new Error("private cause"); } });
  const events: string[] = [];
  await unavailable.execute({ type: "prompt", requestId: "b", sessionId: "b", input: { text: "private" } }, event => { events.push(event.type); });
  assert.deepEqual(events, ["answer_completed", "completed"]);
});

test("cancelling during capture closes the turn without invoking the Agent", async () => {
  const records: Observation[] = [];
  let entered!: () => void;
  const capturing = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new ApplicationRuntime({
    agent: unusedAgent({ async prompt() { assert.fail("Agent must not run after capture cancellation"); } }),
    capture: {
      async start() {}, async stop() {},
      async capture(_requestId, signal): Promise<never> {
        entered();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    },
    turnDiagnostics: ids => turn(ids, records),
  });
  const pending = runtime.execute({ type: "prompt", requestId: "a", sessionId: "a", input: { text: "private" } }, () => {});
  await capturing;
  await runtime.execute({ type: "abort", requestId: "abort", sessionId: "a", targetRequestId: "a" }, () => {});
  await pending;
  assert.deepEqual(records.at(-1)?.payload, { type: "codex_turn_ended", codex_turn_id: "a", status: "cancelled" });
  const end = records.find(record => record.payload.type === "protocol_event_observed" && record.payload.event_type === "turn_aborted");
  assert.equal(end?.details?.value.error_code, "aborted");
  assert.equal(end?.details?.value.phase, "capture");
  assert.equal(records.filter(record => record.payload.type === "codex_turn_started").length, 1);
});

test("cancel during post-answer compaction closes the owning turn as cancelled", async () => {
  const records: Observation[] = [];
  const events: string[] = [];
  let entered!: () => void;
  let release!: () => void;
  const compacting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new ApplicationRuntime({
    agent: unusedAgent({ async compactIfNeeded() {
      entered();
      await gate;
      return { summary: "late", firstKeptEntryId: "entry", tokensBefore: 100 };
    } }),
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
    turnDiagnostics: ids => turn(ids, records),
  });
  const pending = runtime.execute({ type: "prompt", requestId: "a", sessionId: "a", input: { text: "private" } }, event => { events.push(event.type); });
  await compacting;
  await runtime.execute({ type: "abort", requestId: "abort", sessionId: "a", targetRequestId: "a" }, () => {});
  release();
  await pending;
  assert.deepEqual(events, ["answer_completed", "failed"]);
  assert.deepEqual(records.at(-1)?.payload, { type: "codex_turn_ended", codex_turn_id: "a", status: "cancelled" });
});

test("cancel at answer delivery skips automatic compaction", async () => {
  let compactions = 0;
  const runtime = new ApplicationRuntime({
    agent: unusedAgent({ async compactIfNeeded() { compactions++; return undefined; } }),
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
  });
  const events: string[] = [];
  await runtime.execute({ type: "prompt", requestId: "a", sessionId: "a", input: { text: "private" } }, async event => {
    events.push(event.type);
    if (event.type === "answer_completed") await runtime.execute({ type: "abort", requestId: "abort", sessionId: "a", targetRequestId: "a" }, () => {});
  });
  assert.equal(compactions, 0);
  assert.deepEqual(events, ["answer_completed", "failed"]);
});
