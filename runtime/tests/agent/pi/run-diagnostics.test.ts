import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { AgentExecutionDiagnostic } from "../../../src/agent/api.js";
import { PiAgentService } from "../../../src/agent/pi/service.js";
import { ApplicationRuntime } from "../../../src/application/runtime.js";
import { DiagnosticStore, readDiagnosticTurns } from "../../../src/application/diagnostics/store.js";
import { ToolSecurity } from "../../../src/security/tool-security.js";

test("traces each provider invocation around a real Pi tool loop without recording content", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-model-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "faux-diagnostics", models: [{ id: "test", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_secret", {}, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("SECRET final answer"),
  ]);
  const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(),
    tools: [{ name: "read_secret", label: "Read", description: "Read", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "SECRET tool output" }], details: {} }; } }],
  });
  const session = await service.createSession();
  const diagnostics: AgentExecutionDiagnostic[] = [];
  const timeline: string[] = [];
  const answer = await service.prompt(session.session.id, { text: "SECRET prompt" }, event => { timeline.push(event.type); }, event => {
    diagnostics.push(event); timeline.push(event.type);
  });
  assert.equal(answer.answer, "SECRET final answer");
  const starts = diagnostics.filter(event => event.type === "model-start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].invocationId, starts[1].invocationId);
  for (const start of starts) assert.match(start.invocationId, /^[0-9a-f-]{36}$/);
  assert.equal(diagnostics.find(event => event.type === "tool-call-origin")?.invocationId, starts[0].invocationId);
  assert.deepEqual(diagnostics.filter(event => event.type === "model-end").map(event => event.stopReason), ["toolUse", "stop"]);
  assert.ok(timeline.indexOf("model-start") < timeline.indexOf("tool-start"));
  assert.ok(timeline.indexOf("model-end") < timeline.indexOf("tool-start"));
  assert.ok(timeline.lastIndexOf("model-start") > timeline.indexOf("tool-end"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET/);
  const firstTokens = diagnostics.filter(event => event.type === "model-first-token");
  assert.equal(firstTokens.length, 2);
  faux.setResponses([fauxAssistantMessage("next")]);
  await service.prompt(session.session.id, { text: "next" }, undefined, () => { throw new Error("diagnostics failed"); });
});

test("production Application, Pi, approvals, and host execution produce a correlated metadata-only bundle", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-production-trace-"));
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  const store = new DiagnosticStore(join(root, "traces"));
  const faux = fauxProvider({ provider: "faux-production-trace", models: [{ id: "test", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const command = "printf SECRET; exit 7";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command, host: true }, { id: "call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("SECRET command failed"),
  ]);
  const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(),
    tools: security.tools, toolSecurity: security });
  const sessionId = (await service.createSession()).session.id;
  const runtime = new ApplicationRuntime({ agent: service, approvals: security.approvals,
    capture: { async start() {}, async stop() {}, async capture() { return { type: "frames", frames: [], images: [] }; } },
    turnDiagnostics: ids => store.start(ids) });
  t.after(async () => { await runtime.stop(); await store.close(); await rm(root, { recursive: true, force: true }); });
  let approvedId: string | undefined;
  const events: string[] = [];
  await runtime.execute({ type: "prompt", sessionId, requestId: "request", input: { text: "SECRET prompt" } }, event => {
    events.push(event.type);
    if (event.type === "approval_requested") {
      approvedId = event.request.id;
      assert.equal(event.request.target, command);
      assert.equal(security.approvals.decide(event.request.id, true), true);
    }
  });
  await store.flush();
  const turn = (await readDiagnosticTurns(store.root))[0];
  assert.equal(turn.threadId, sessionId);
  assert.equal(turn.requestId, "request");
  assert.equal(turn.status, "completed", "Handled tool failure does not fail the owning prompt");
  assert.equal(turn.complete, true);
  assert.equal(Object.keys(turn.inferenceCalls).length, 2);
  const tool = Object.values(turn.toolCalls)[0];
  assert.equal(tool.execution.status, "failed");
  assert.equal(tool.model_visible_call_id, "call");
  const origin = turn.payloads[tool.raw_invocation_payload_id!].inference_call_id;
  assert.equal(turn.inferenceCalls[String(origin)].execution.status, "completed");
  const exec = tool.raw_runtime_payload_ids.map(id => turn.payloads[id]);
  assert.deepEqual(exec.map(value => value.type), ["exec_command_begin", "exec_command_end"]);
  assert.equal(exec[0].approval_id, approvedId);
  assert.equal(exec[0].sandbox_type, "none");
  assert.equal(exec[1].exit_code, 7);
  const result = turn.payloads[tool.raw_result_payload_id!];
  assert.equal(result.error_code, "nonzero_exit");
  assert.ok(Number(result.duration_ms) >= Number(exec[1].duration_ms));
  const approval = Object.values(turn.payloads).filter(value => value.type === "approval_decision");
  assert.equal(approval[0].approval_id, approvedId);
  assert.equal(approval[0].decision, "approved");
  assert.doesNotMatch(JSON.stringify(turn), /SECRET/);
  assert.equal(events.at(-1), "completed");
  const sessionPath = (await readdir(join(root, "sessions"), { recursive: true })).find(path => path.endsWith(".jsonl"))!;
  const history = (await readFile(join(root, "sessions", sessionPath), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const audit = history.filter(entry => entry.customType === "openscreen.approval-event");
  assert.deepEqual(audit.map(entry => entry.data.type), ["approval-requested", "approval-decided", "approval-committed"]);
  assert.ok(audit.every(entry => entry.data.id === approvedId));
  assert.equal(audit[1].data.reason, "approved");
});
