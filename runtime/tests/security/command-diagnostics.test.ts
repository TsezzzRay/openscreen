import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentExecutionDiagnostic } from "../../src/agent/api.js";
import { ToolSecurity } from "../../src/security/tool-security.js";
import { TurnTrace } from "../../src/application/diagnostics/turn-trace.js";
import type { TraceAttachment, TracePayload } from "../../src/application/diagnostics/schema.js";

async function pendingApproval(security: ToolSecurity) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = security.approvals.pending()[0];
    if (pending) return pending;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Missing approval");
}

test("host attempt starts after approval, preserves nonzero exit, and emits content-free metadata", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-command-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  t.after(() => security.approvals.close());
  const events: AgentExecutionDiagnostic[] = [];
  const run = await security.prepare("session", () => {}, event => { events.push(event); });
  const bash = security.tools.find(tool => tool.name === "bash")!;
  const work = run.execute(() => bash.execute("call", { command: "printf SECRET; exit 7", host: true }, new AbortController().signal));
  const rejected = assert.rejects(work, /code 7/);
  const pending = await pendingApproval(security);
  assert.equal(events.length, 0);
  security.approvals.decide(pending.id, true);
  await rejected;
  assert.deepEqual(events.map(event => event.type), ["approval-outcome", "command-start", "command-end"]);
  const start = events.find(event => event.type === "command-start")!;
  const end = events.find(event => event.type === "command-end")!;
  assert.equal(start.approvalId, pending.id);
  assert.equal(end.attemptId, start.attemptId);
  assert.equal(end.callId, "call");
  assert.equal(end.exitCode, 7);
  assert.equal(end.status, "failed");
  assert.ok(end.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test("cancelled approval retains its reason and launches no runtime attempt", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-command-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  t.after(() => security.approvals.close());
  const events: AgentExecutionDiagnostic[] = [];
  const run = await security.prepare("session", () => {}, event => { events.push(event); });
  const bash = security.tools.find(tool => tool.name === "bash")!;
  const controller = new AbortController();
  const output = join(root, "not-created");
  const work = run.execute(() => bash.execute("call", { command: `touch '${output}'`, host: true }, controller.signal));
  const rejected = assert.rejects(work, /aborted/i);
  const pending = await pendingApproval(security);
  controller.abort();
  await rejected;
  assert.deepEqual(events, [{ type: "approval-outcome", approvalId: pending.id, reason: "cancelled" }]);
  await assert.rejects(readFile(output));
});

test("timeout is a runtime failure, not denial; diagnostics exceptions do not change execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-command-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  t.after(() => security.approvals.close());
  const events: AgentExecutionDiagnostic[] = [];
  const run = await security.prepare("session", () => {}, event => { events.push(event); throw new Error("trace sink failed"); });
  const bash = security.tools.find(tool => tool.name === "bash")!;
  const work = run.execute(() => bash.execute("call", { command: "sleep 1", host: true, timeout: 0.05 }, new AbortController().signal));
  const rejected = assert.rejects(work, /may have run/i);
  const pending = await pendingApproval(security);
  security.approvals.decide(pending.id, true);
  await rejected;
  const end = events.find(event => event.type === "command-end")!;
  assert.equal(end.status, "failed");
  assert.equal(end.errorCode, "timeout");
  assert.equal(end.exitCode, undefined);
});

test("cancellation after approval but before dispatch records no command attempt or uncertain side effect", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-command-pre-dispatch-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  t.after(() => security.approvals.close());
  const controller = new AbortController();
  const rows: { payload: TracePayload; details?: TraceAttachment }[] = [];
  const turn = new TurnTrace({ turnId: "turn", threadId: "session", requestId: "request" },
    (_turnId, payload, details) => rows.push({ payload, details }));
  const events: AgentExecutionDiagnostic[] = [];
  const securityEvents: string[] = [];
  const run = await security.prepare("session", event => {
    securityEvents.push(event.type);
    if (event.type === "security-approval-requested") turn.agentEvent({ type: "approval-requested", request: event.request });
    if (event.type === "security-approval-decided" && event.approved) controller.abort();
  }, event => { events.push(event); turn.agentDiagnostic(event); });
  const output = join(root, "not-created");
  turn.agentEvent({ type: "tool-start", callId: "call", name: "bash", input: {} });
  const bash = security.tools.find(tool => tool.name === "bash")!;
  const work = run.execute(() => bash.execute("call", { command: `touch '${output}'`, host: true }, controller.signal));
  const rejected = assert.rejects(work, /aborted/i);
  const pending = await pendingApproval(security);
  security.approvals.decide(pending.id, true);
  await rejected;
  turn.agentEvent({ type: "tool-end", callId: "call", name: "bash", text: "Command aborted", isError: true });
  const end = rows.find(row => row.payload.type === "tool_call_ended")!;
  assert.ok(end.payload.type === "tool_call_ended");
  assert.equal(end.payload.status, "cancelled");
  assert.equal(end.details?.value.error_code, "aborted");
  assert.equal(events.filter(event => event.type === "command-start" || event.type === "command-end").length, 0);
  assert.equal(securityEvents.includes("security-host-execution-uncertain"), false);
  await assert.rejects(readFile(output));
});

test("sandbox failure does not invent a host escalation or approval", { skip: process.platform !== "darwin" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-command-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  t.after(() => security.approvals.close());
  const events: AgentExecutionDiagnostic[] = [];
  const run = await security.prepare("session", () => {}, event => { events.push(event); });
  const bash = security.tools.find(tool => tool.name === "bash")!;
  await assert.rejects(run.execute(() => bash.execute("call", { command: `touch '${join(root, "forbidden")}'` }, new AbortController().signal)));
  assert.equal(events.filter(event => event.type === "command-start").length, 1);
  assert.ok(events.filter(event => event.type === "command-start").every(event => !event.host));
  assert.deepEqual(security.approvals.pending(), []);
  assert.equal(events.filter(event => event.type === "approval-outcome").length, 0);
});
