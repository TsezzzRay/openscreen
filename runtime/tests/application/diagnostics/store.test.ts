import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticStore, readDiagnosticTurns } from "../../../src/application/diagnostics/store.js";
import { TurnTrace } from "../../../src/application/diagnostics/turn-trace.js";
import type { TraceAttachment, TracePayload } from "../../../src/application/diagnostics/schema.js";

function fixture() {
  let now = 0;
  const rows: { payload: TracePayload; details?: TraceAttachment }[] = [];
  const turn = new TurnTrace({ turnId: "turn", threadId: "session", requestId: "request" },
    (_turnId, payload, details) => rows.push({ payload, details }), { now: () => now });
  return { turn, rows, tick: (value: number) => { now = value; } };
}

test("overlapping approval waits are unioned; dispatch active time is not execution time", () => {
  const { turn, rows, tick } = fixture();
  for (const callId of ["a", "b"]) turn.agentEvent({ type: "tool-start", callId, name: "write", input: { content: "SECRET" } });
  tick(10);
  turn.agentEvent({ type: "approval-requested", request: { id: "x", callId: "a", sessionId: "session", tool: "write", target: "/SECRET", proposedContent: "SECRET" } });
  tick(20);
  turn.agentEvent({ type: "approval-requested", request: { id: "y", callId: "b", sessionId: "session", tool: "write", target: "/SECRET" } });
  tick(60);
  turn.agentDiagnostic({ type: "approval-outcome", approvalId: "x", reason: "approved" });
  tick(80);
  turn.agentDiagnostic({ type: "approval-outcome", approvalId: "y", reason: "denied" });
  tick(100);
  turn.agentEvent({ type: "tool-end", callId: "a", name: "write", text: "SECRET", isError: false });
  turn.agentEvent({ type: "tool-end", callId: "b", name: "write", text: "SECRET", isError: true });
  turn.finish("completed");
  const end = rows.find(row => row.payload.type === "protocol_event_observed" && row.payload.event_type === "turn_complete")!;
  assert.equal(end.details?.value.approval_wait_ms, 70);
  assert.equal(end.details?.value.active_ms, 30);
  const toolEnds = rows.filter(row => row.payload.type === "tool_call_ended");
  assert.equal(toolEnds[0].details?.value.dispatch_active_ms, 50);
  assert.equal(toolEnds[1].details?.value.status, "declined");
  assert.equal(toolEnds[1].details?.value.error_code, "approval_denied");
  assert.equal(rows.filter(row => row.payload.type === "tool_call_runtime_started").length, 0);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test("cancelled approval is an abort, not a synthetic denial or command end", () => {
  const { turn, rows, tick } = fixture();
  turn.stage("agent", "start");
  turn.agentDiagnostic({ type: "model-start", invocationId: "inference", provider: "test", model: "test" });
  tick(10);
  turn.agentDiagnostic({ type: "model-first-token", invocationId: "inference" });
  turn.agentEvent({ type: "tool-start", callId: "a", name: "bash", input: {} });
  turn.agentEvent({ type: "approval-requested", request: { id: "x", sessionId: "session", callId: "a", tool: "bash", target: "SECRET" } });
  tick(110);
  turn.agentDiagnostic({ type: "approval-outcome", approvalId: "x", reason: "cancelled" });
  turn.finish("cancelled", "aborted");
  turn.finish("completed");
  assert.equal(rows.filter(row => row.payload.type === "codex_turn_ended").length, 1);
  assert.equal(rows.find(row => row.payload.type === "protocol_event_observed" && row.payload.event_type === "approval_decision")?.details?.value.decision, "abort");
  assert.equal(rows.find(row => row.payload.type === "protocol_event_observed" && row.payload.event_type === "approval_decision")?.details?.value.source, "runtime");
  assert.equal(rows.filter(row => row.payload.type === "inference_cancelled").length, 0, "No provider terminal event was observed");
  assert.equal(rows.filter(row => row.payload.type === "tool_call_runtime_ended").length, 0);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test("command attempts retain sandbox, actual duration, failure code, and exit status", () => {
  const { turn, rows } = fixture();
  turn.agentEvent({ type: "tool-start", callId: "call", name: "bash", input: { command: "SECRET" } });
  turn.agentDiagnostic({ type: "command-start", callId: "call", attemptId: "attempt", host: false });
  turn.agentDiagnostic({ type: "command-end", callId: "call", attemptId: "attempt", host: false, status: "failed", durationMs: 12, exitCode: 7 });
  turn.agentEvent({ type: "tool-end", callId: "call", name: "bash", text: "SECRET", isError: true });
  const begin = rows.find(row => row.payload.type === "tool_call_runtime_started")!;
  const end = rows.find(row => row.payload.type === "tool_call_runtime_ended")!;
  assert.equal(begin.details?.value.sandbox_type, "macos_seatbelt");
  assert.equal(end.details?.value.exit_code, 7);
  assert.equal(end.details?.value.duration_ms, 12);
  assert.equal(rows.find(row => row.payload.type === "tool_call_ended")?.details?.value.error_code, "nonzero_exit");
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test("a truncated model response is completed, not an interrupted turn", () => {
  const { turn, rows } = fixture();
  turn.agentDiagnostic({ type: "model-start", invocationId: "inference", provider: "test", model: "test" });
  turn.agentDiagnostic({ type: "model-end", invocationId: "inference", stopReason: "length", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(rows.at(-1)?.payload.type, "inference_completed");
  assert.equal(rows.at(-1)?.details?.value.stop_reason, "length");
});

test("a cancelled command or approval preserves cancelled tool status rather than failed or declined", () => {
  for (const duringExecution of [false, true]) {
    const { turn, rows } = fixture();
    turn.agentEvent({ type: "tool-start", callId: "call", name: "bash", input: {} });
    if (duringExecution) {
      turn.agentDiagnostic({ type: "command-start", callId: "call", attemptId: "attempt", host: false });
      turn.agentDiagnostic({ type: "command-end", callId: "call", attemptId: "attempt", host: false,
        status: "cancelled", durationMs: 5, errorCode: "aborted" });
    } else {
      turn.agentEvent({ type: "approval-requested", request: { id: "approval", sessionId: "session",
        callId: "call", tool: "bash", target: "command" } });
      turn.agentDiagnostic({ type: "approval-outcome", approvalId: "approval", reason: "cancelled" });
    }
    turn.agentEvent({ type: "tool-end", callId: "call", name: "bash", text: "Aborted", isError: true });
    const end = rows.find(row => row.payload.type === "tool_call_ended")!;
    assert.ok(end.payload.type === "tool_call_ended");
    assert.equal(end.payload.status, "cancelled");
    assert.equal(end.details?.value.status, "cancelled");
    assert.equal(end.details?.value.error_code, "aborted");
  }
});

test("trace-safe tool-result statistics match Codex UTF-8 lengths and Rust lines semantics", () => {
  const sequences: number[] = [];
  for (const [output, lineCount] of [["", 0], ["\n", 1], ["text\n", 1], ["two\r\nlines\r\n", 2], ["α\nβ", 2]] as const) {
    const { turn, rows } = fixture();
    turn.agentEvent({ type: "tool-start", callId: "call", name: "read", input: {} });
    turn.agentEvent({ type: "tool-end", callId: "call", name: "read", text: output, isError: false });
    const stats = rows.find(row => row.payload.type === "other" && row.payload.kind === "codex.tool_result")!;
    assert.ok(stats.payload.type === "other");
    assert.equal(stats.payload.metadata.output_length, Buffer.byteLength(output));
    assert.equal(stats.payload.metadata.output_line_count, lineCount);
    sequences.push(Number(stats.payload.metadata.tool_result_seq));
    assert.equal("output" in stats.payload.metadata, false);
    assert.equal("arguments" in stats.payload.metadata, false);
  }
  assert.ok(sequences.every((seq, i) => i === 0 || seq > sequences[i - 1]));
});

test("persists private independent thread bundles and preserves an incomplete tail", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  store.start({ sessionId: "s1", requestId: "../request" }).finish("completed");
  store.start({ sessionId: "s2", requestId: "request" }).finish("failed", "provider");
  await store.close();
  const paths = await readdir(root);
  assert.equal(paths.length, 2);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const path of paths) {
    assert.equal((await stat(join(root, path))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, path, "trace.jsonl"))).mode & 0o777, 0o600);
  }
  const turns = await readDiagnosticTurns(root, { sessionId: "s1" });
  assert.equal(turns.length, 1);
  const file = join(root, turns[0].bundle, "trace.jsonl");
  const original = await readFile(file, "utf8");
  const lines = original.trim().split("\n");
  const cutoff = lines.findIndex(line => JSON.parse(line).payload.type === "codex_turn_ended");
  await writeFile(file, lines.slice(0, cutoff).join("\n") + '\n{"schema_version":');
  const incomplete = await readDiagnosticTurns(root, { sessionId: "s1" });
  assert.equal(incomplete[0].incompleteTail, true);
  assert.equal(incomplete[0].status, "running");
  assert.equal(incomplete[0].complete, false);
});

test("a filesystem failure emits one static warning and never rejects the agent", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "not-directory");
  await writeFile(file, "SECRET");
  const warnings: string[] = [];
  const store = new DiagnosticStore(file, message => { warnings.push(message); });
  store.start({ sessionId: "session", requestId: "request" }).finish("completed");
  await store.close();
  assert.deepEqual(warnings, ["OpenScreen rollout trace unavailable"]);
});
