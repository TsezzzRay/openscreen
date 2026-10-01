import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { PiAgentService } from "../../src/agent/pi/service.js";
import type { AgentRunEvent } from "../../src/agent/api.js";
import { ToolSecurity } from "../../src/security/tool-security.js";

test("real pi tool call pauses for approval and resumes after decision", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-security-"));
  const target = join(root, "outside.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: target, content: "approved" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    const emitted: AgentRunEvent[] = [];
    const running = service.prompt(session.session.id, { text: "Update the file" }, event => { emitted.push(event); });
    for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = security.approvals.pending()[0];
    assert.ok(approval);
    await assert.rejects(readFile(target));
    security.approvals.decide(approval.id, true);
    assert.equal((await running).answer, "done");
    assert.equal(await readFile(target, "utf8"), "approved");
    const events = emitted.map(event => event.type);
    assert.ok(events.includes("approval-requested"));
    assert.ok(events.includes("approval-committed"));
    assert.ok(events.indexOf("approval-requested") < events.indexOf("approval-decided"));
    assert.ok(events.indexOf("approval-decided") < events.indexOf("approval-committed"));
    assert.ok(events.indexOf("approval-committed") < events.indexOf("tool-end"));
    assert.deepEqual(emitted.find(event => event.type === "approval-committed"), {
      type: "approval-committed", id: approval.id, callId: approval.callId, tool: "write", target: approval.target,
    });
    const sessionFiles = await readdir(join(root, "sessions"), { recursive: true });
    const jsonlName = sessionFiles.find(name => name.endsWith(".jsonl"));
    assert.ok(jsonlName);
    const entries = (await readFile(join(root, "sessions", jsonlName), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const audit = entries.filter(entry => entry.type === "custom" && entry.customType === "openscreen.approval-event");
    assert.deepEqual(audit.map(entry => entry.data.type), ["approval-requested", "approval-decided", "approval-committed"]);
    assert.ok(audit.every(entry => entry.data.id === approval.id));
    assert.equal(audit[1].data.approved, true);
    assert.equal(audit[2].data.callId, approval.callId);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a paused pi run invalidates approval before any file write", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-security-"));
  const target = join(root, "outside.txt");
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: target, content: "should not happen" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("not done"),
    ]);
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    const running = service.prompt(session.session.id, { text: "Write the file" });
    const settled = assert.rejects(running);
    for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = security.approvals.pending()[0];
    assert.ok(approval);
    await service.abort(session.session.id);
    await settled;
    assert.equal(security.approvals.decide(approval.id, true), false);
    await assert.rejects(readFile(target));
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pi host Bash call waits for exact-command approval before execution", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-host-security-"));
  const target = join(root, "host.txt");
  const command = `printf host > ${JSON.stringify(target)}`;
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command, host: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    const events: string[] = [];
    const running = service.prompt(session.session.id, { text: "Run the host command" }, event => { events.push(event.type); });
    for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = security.approvals.pending()[0];
    assert.ok(approval);
    assert.equal(approval.tool, "bash");
    assert.equal(approval.target, command);
    await assert.rejects(readFile(target));
    security.approvals.decide(approval.id, true);
    assert.equal((await running).answer, "done");
    assert.equal(await readFile(target, "utf8"), "host");
    assert.ok(events.includes("approval-requested"));
    assert.ok(events.includes("approval-committed"));
    const sessionFiles = await readdir(join(root, "sessions"), { recursive: true });
    const jsonlName = sessionFiles.find(name => name.endsWith(".jsonl"));
    assert.ok(jsonlName);
    const entries = (await readFile(join(root, "sessions", jsonlName), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const audit = entries.filter(entry => entry.type === "custom" && entry.customType === "openscreen.approval-event");
    assert.deepEqual(audit.map(entry => entry.data.type), ["approval-requested", "approval-decided", "approval-committed"]);
    assert.equal(audit[0].data.tool, "bash");
    assert.equal(audit[0].data.target, command);
    assert.equal(audit[1].data.approved, true);
    assert.equal(audit[2].data.target, command);
    assert.ok(audit.every(entry => entry.data.id === approval.id));
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pi Session records uncertain host execution after an approved timeout", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-host-timeout-"));
  const target = join(root, "host.txt");
  const command = `printf started > ${JSON.stringify(target)}; sleep 2`;
  const security = new ToolSecurity({ cwd: root, dataRoot: root });
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command, host: true, timeout: 0.2 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The command timed out; check the file before retrying."),
    ]);
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    const running = service.prompt(session.session.id, { text: "Run the host command" });
    for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = security.approvals.pending()[0];
    assert.ok(approval);
    security.approvals.decide(approval.id, true);
    await running;
    assert.equal(await readFile(target, "utf8"), "started");
    const sessionFiles = await readdir(join(root, "sessions"), { recursive: true });
    const jsonlName = sessionFiles.find(name => name.endsWith(".jsonl"));
    assert.ok(jsonlName);
    const entries = (await readFile(join(root, "sessions", jsonlName), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const audit = entries.filter(entry => entry.type === "custom" && entry.customType === "openscreen.approval-event");
    assert.deepEqual(audit.map(entry => entry.data.type), ["approval-requested", "approval-decided", "approval-execution-uncertain"]);
    assert.equal(audit[2].data.reason, "timeout");
    assert.equal(audit[2].data.id, approval.id);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop approval audit records the snapshot hash but not its preview image", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-pi-desktop-audit-"));
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123,
      windowId: 42n,
      appName: "Editor",
      windowTitle: "notes.txt",
      screenshotFrameValid: true,
      screenshotWidth: 100,
      screenshotHeight: 100,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
    }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" }; },
  });
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("desktop_window_state", { pid: 123, windowId: "42" }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult" && message.toolName === "desktop_window_state").at(-1);
        assert.ok(result && result.role === "toolResult");
        const content = result.content.find(item => item.type === "text");
        assert.ok(content && content.type === "text");
        const observation = JSON.parse(content.text) as { observationId: string };
        return fauxAssistantMessage(fauxToolCall("desktop_click", {
          observationId: observation.observationId,
          position: { kind: "coordinates", x: 10, y: 20 },
          deliveryMode: "background",
        }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("done"),
    ]);
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    const running = service.prompt(session.session.id, { text: "Click the observed window" });
    for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = security.approvals.pending()[0];
    assert.ok(approval);
    assert.equal(approval.tool, "desktop_click");
    assert.deepEqual(approval.previewImage, { mimeType: "image/png", dataBase64: "aW1hZ2U=" });
    security.approvals.decide(approval.id, true);
    assert.equal((await running).answer, "done");
    assert.equal(clicks, 1);
    const sessionFiles = await readdir(join(root, "sessions"), { recursive: true });
    const jsonlName = sessionFiles.find(name => name.endsWith(".jsonl"));
    assert.ok(jsonlName);
    const entries = (await readFile(join(root, "sessions", jsonlName), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const audit = entries.filter(entry => entry.type === "custom" && entry.customType === "openscreen.approval-event");
    assert.deepEqual(audit.map(entry => entry.data.type), ["approval-requested", "approval-decided", "approval-committed"]);
    assert.ok(audit.every(entry => !JSON.stringify(entry.data).includes("aW1hZ2U=")));
    assert.ok(audit.every(entry => !("previewImage" in entry.data)));
    assert.equal(typeof audit[0].data.target, "string");
    assert.deepEqual(JSON.parse(audit[0].data.target), approval.target);
    assert.match(audit[0].data.target, /"screenshotSha256":"[0-9a-f]{64}"/);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop tool rule limits post-action claims to observed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-report-rule-"));
  try {
    const faux = fauxProvider({ provider: `faux-${Math.random().toString(36).slice(2)}`, models: [{ id: "test-model" }] });
    const models = createModels(); models.setProvider(faux.provider);
    let systemPrompt = "";
    faux.setResponses([context => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("done");
    }]);
    const security = new ToolSecurity({ cwd: root, dataRoot: root });
    const service = new PiAgentService({ cwd: root, sessionsRoot: join(root, "sessions"), models, model: faux.getModel(), tools: security.tools, toolSecurity: security });
    const session = await service.createSession();
    await service.prompt(session.session.id, { text: "Report the desktop result" });
    assert.match(systemPrompt, /If the UI only confirms a request was started, report that request start without inferring downstream progress or completion/i);
    assert.match(systemPrompt, /desktop actions require one application approval per conversation/i);
    assert.match(systemPrompt, /If desktop typing becomes uncertain, do not retry before inspecting the field/i);
    assert.match(systemPrompt, /Before a tool approval decision, describe the action as a pending request, not as already executing or completed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
