import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticStore, readDiagnosticTurns } from "../../../src/application/diagnostics/store.js";
import type { DesktopApprovalTarget } from "../../../src/desktop/api.js";

test("one thread activation owns multiple turns with one contiguous Codex raw event log", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  const first = store.start({ sessionId: "session", requestId: "request-a" });
  first.finish("completed");
  store.start({ sessionId: "session", requestId: "request-b" }).finish("failed", "provider");
  await store.close();
  const bundles = await readdir(root);
  assert.equal(bundles.length, 1);
  const directory = join(root, bundles[0]);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.root_thread_id, "session");
  assert.equal(manifest.schema_version, 1);
  const events = (await readFile(join(directory, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.filter(event => event.payload.type === "thread_started").length, 1);
  assert.equal(events.filter(event => event.payload.type === "codex_turn_started").length, 2);
  assert.equal(events.at(-1).payload.type, "rollout_ended");
  const turns = await readDiagnosticTurns(root);
  assert.equal(turns.length, 2);
  assert.deepEqual(new Set(turns.map(turn => turn.requestId)), new Set(["request-a", "request-b"]));
  assert.equal(turns.find(turn => turn.requestId === "request-a")?.turnId, first.turnId);
  assert.ok(turns.every(turn => turn.complete));
});

test("owner interruption closes inference state but preserves unfinished tool evidence without inventing results", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  const turn = store.start({ sessionId: "session", requestId: "request" });
  turn.agentDiagnostic({ type: "model-start", invocationId: "inference", provider: "test", model: "test" });
  turn.agentEvent({ type: "tool-start", callId: "call", name: "read", input: {} });
  turn.finish("cancelled", "aborted");
  await store.close();
  const data = (await readDiagnosticTurns(root))[0];
  assert.equal(data.status, "cancelled");
  assert.equal(data.complete, false);
  assert.equal(data.inferenceCalls.inference.execution.status, "cancelled");
  assert.equal(Object.values(data.toolCalls)[0].execution.status, "running");
  assert.equal(data.records.filter(record => ["inference_cancelled", "tool_call_ended"].includes(record.payload.type)).length, 0);
});

test("a later call can reuse an approved application within the same turn", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-grant-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  const turn = store.start({ sessionId: "session", requestId: "request" });
  const target: DesktopApprovalTarget = { scope: "application", action: "click", bundleId: "com.example.editor", appName: "Editor",
    pid: 123, windowId: "42", observationId: "observation", screenshotSha256: "hash",
    deliveryMode: "background", position: { x: 10, y: 20 } };
  for (const callId of ["first", "second"]) {
    turn.agentEvent({ type: "tool-start", callId, name: "desktop_click", input: {} });
    if (callId === "first") {
      turn.agentEvent({ type: "approval-requested", request: {
        id: "grant", sessionId: "session", callId, tool: "desktop_click", target,
      } });
      turn.agentDiagnostic({ type: "approval-outcome", approvalId: "grant", reason: "approved" });
    }
    turn.agentEvent({ type: "approval-committed", id: "grant", callId, tool: "desktop_click", target });
    turn.agentEvent({ type: "tool-end", callId, name: "desktop_click", text: "", isError: false });
  }
  turn.finish("completed");
  await store.close();
  const data = (await readDiagnosticTurns(root))[0];
  assert.equal(data.complete, true);
  const commits = Object.values(data.payloads).filter(value => value.type === "approval_committed");
  assert.deepEqual(commits.map(value => [value.call_id, value.source]), [["first", "user"], ["second", "session"]]);
  for (const commit of commits) {
    assert.equal(commit.bundle_id, target.bundleId);
    assert.equal(commit.pid, target.pid);
    assert.equal(commit.window_id, target.windowId);
    assert.equal(commit.target_sha256, createHash("sha256").update(JSON.stringify(target)).digest("hex"));
    assert.equal("position" in commit, false);
  }
  assert.equal(Object.keys(data.toolCalls).length, 2);
});

test("an incomplete later append does not erase a previous turn's terminal evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-later-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  store.start({ sessionId: "session", requestId: "finished" }).finish("completed");
  store.start({ sessionId: "session", requestId: "interrupted" });
  await store.flush();
  const earlier = (await readDiagnosticTurns(root)).find(turn => turn.requestId === "finished")!;
  const path = join(root, earlier.bundle, "trace.jsonl");
  const content = await readFile(path, "utf8");
  await writeFile(path, content + '{"schema_version":');
  let turns;
  try { turns = await readDiagnosticTurns(root); }
  finally { await writeFile(path, content); await store.close(); }
  assert.equal(turns.find(turn => turn.requestId === "finished")?.complete, true);
  assert.equal(turns.find(turn => turn.requestId === "interrupted")?.complete, false);
  assert.ok(turns.every(turn => turn.incompleteTail));
});

test("reader rejects mismatched inference and tool terminal IDs rather than silently pairing them", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-corruption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  const turn = store.start({ sessionId: "session", requestId: "request" });
  turn.agentDiagnostic({ type: "model-start", invocationId: "inference", provider: "test", model: "test" });
  turn.agentDiagnostic({ type: "model-end", invocationId: "inference", stopReason: "stop", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  turn.agentEvent({ type: "tool-start", callId: "call", name: "read", input: {} });
  turn.agentEvent({ type: "tool-end", callId: "call", name: "read", text: "", isError: false });
  turn.finish("completed");
  await store.close();
  const data = (await readDiagnosticTurns(root))[0];
  const path = join(root, data.bundle, "trace.jsonl");
  const original = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const [type, key] of [["inference_completed", "inference_call_id"], ["tool_call_ended", "tool_call_id"]]) {
    const changed = original.map(record => record.payload.type === type ? { ...record, payload: { ...record.payload, [key]: "wrong" } } : record);
    await writeFile(path, changed.map(record => JSON.stringify(record)).join("\n") + "\n");
    await assert.rejects(readDiagnosticTurns(root), /Unmatched/);
  }
  const invalidStatus = original.map(record => record.payload.type === "tool_call_ended"
    ? { ...record, payload: { ...record.payload, status: "unknown_success" } } : record);
  await writeFile(path, invalidStatus.map(record => JSON.stringify(record)).join("\n") + "\n");
  await assert.rejects(readDiagnosticTurns(root), /Invalid tool end status/);
});

test("reader validates payload references and preserves a crashed turn as running", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-rollout-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  store.start({ sessionId: "session", requestId: "request" });
  await store.flush();
  const turn = (await readDiagnosticTurns(root))[0];
  assert.equal(turn.status, "running");
  assert.equal(turn.complete, false);
  const event = turn.records.find(record => record.payload.type === "protocol_event_observed")!;
  assert.ok(event.payload.type === "protocol_event_observed");
  const ref = event.payload.event_payload!;
  const payloadPath = join(root, turn.bundle, ref.path);
  assert.equal(JSON.parse(await readFile(payloadPath, "utf8")).turn_id, turn.turnId);
  await rm(payloadPath);
  await assert.rejects(readDiagnosticTurns(root), /payload/);
  await store.close();
});
