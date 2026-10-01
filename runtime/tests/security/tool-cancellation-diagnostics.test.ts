import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentExecutionDiagnostic } from "../../src/agent/api.js";
import { TurnTrace } from "../../src/application/diagnostics/turn-trace.js";
import type { TraceAttachment, TracePayload } from "../../src/application/diagnostics/schema.js";
import { ToolSecurity } from "../../src/security/tool-security.js";

function traceFixture() {
  const rows: { payload: TracePayload; attachment?: TraceAttachment }[] = [];
  const trace = new TurnTrace({ turnId: "turn", threadId: "session", requestId: "request" },
    (_id, payload, attachment) => rows.push({ payload, attachment }));
  const diagnostics: AgentExecutionDiagnostic[] = [];
  return { trace, rows, diagnostics, diagnose: (event: AgentExecutionDiagnostic) => {
    diagnostics.push(event);
    trace.agentDiagnostic(event);
  } };
}

for (const [toolName, mode] of [["write", "before-call"], ["write", "after-approval"],
  ["edit", "before-call"], ["edit", "after-approval"]] as const) {
  test(`${toolName} cancellation is traced as cancelled, not permission denied: ${mode}`, { skip: process.platform !== "darwin" }, async t => {
    const root = await mkdtemp(join(tmpdir(), "openscreen-write-cancel-trace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const { trace, rows, diagnose } = traceFixture();
    const securityEvents: string[] = [];
    const security = new ToolSecurity({ cwd: root, dataRoot: root });
    t.after(() => security.approvals.close());
    const run = await security.prepare("session", event => {
      securityEvents.push(event.type);
      if (event.type === "security-approval-requested") {
        trace.agentEvent({ type: "approval-requested", request: event.request });
        security.approvals.decide(event.request.id, true);
      }
      if (event.type === "security-approval-decided" && event.approved) controller.abort();
    }, diagnose);
    const target = join(root, "not-created.txt");
    if (toolName === "edit") await writeFile(target, "original");
    if (mode === "before-call") controller.abort();
    trace.agentEvent({ type: "tool-start", callId: "file", name: toolName, input: {} });
    const fileTool = security.tools.find(tool => tool.name === toolName)!;
    const params = toolName === "write" ? { path: target, content: "not saved" }
      : { path: target, edits: [{ oldText: "original", newText: "not saved" }] };
    await assert.rejects(run.execute(() => fileTool.execute("file", params, controller.signal)),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "aborted");
        return true;
      });
    trace.agentEvent({ type: "tool-end", callId: "file", name: toolName, text: "aborted", isError: true });
    const end = rows.find(row => row.payload.type === "tool_call_ended")!;
    assert.ok(end.payload.type === "tool_call_ended");
    assert.equal(end.payload.status, "cancelled");
    assert.equal(end.attachment?.value.error_code, "aborted");
    assert.equal(securityEvents.includes("security-tool-committed"), false);
    if (toolName === "edit") assert.equal(await readFile(target, "utf8"), "original");
    else await assert.rejects(readFile(target));
  });
}

test("an observed driver failure is not relabeled from signal state or cancellation words", async t => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-error-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const { trace, rows, diagnose, diagnostics } = traceFixture();
  const securityEvents: string[] = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => {
      controller.abort();
      throw new Error("Driver cancelled delivery unexpectedly");
    },
  });
  t.after(() => security.approvals.close());
  const run = await security.prepare("session", event => {
    securityEvents.push(event.type);
    if (event.type === "security-approval-requested") {
      trace.agentEvent({ type: "approval-requested", request: event.request });
      security.approvals.decide(event.request.id, true);
    }
  }, diagnose);
  await run.execute(async () => {
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const result = await observe.execute("observe", { pid: 123, windowId: "42" });
    const content = result.content[0];
    assert.ok(content.type === "text");
    const { observationId } = JSON.parse(content.text);
    trace.agentEvent({ type: "tool-start", callId: "click", name: "desktop_click", input: {} });
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    await assert.rejects(click.execute("click", { observationId, position: { kind: "coordinates", x: 20, y: 40 },
      deliveryMode: "background" }, controller.signal), /may have run.*Driver cancelled/s);
    trace.agentEvent({ type: "tool-end", callId: "click", name: "desktop_click", text: "Driver error", isError: true });
  });
  const end = rows.find(row => row.payload.type === "tool_call_ended")!;
  assert.ok(end.payload.type === "tool_call_ended");
  assert.equal(end.payload.status, "failed");
  assert.equal(end.attachment?.value.error_code, "tool_error");
  assert.equal(diagnostics.some(event => event.type === "tool-cancelled"), false);
  assert.equal(securityEvents.includes("security-desktop-execution-uncertain"), true);
});

for (const toolName of ["desktop_click", "desktop_scroll", "desktop_type"] as const) {
  for (const mode of ["after-approval", "during-recheck"] as const) {
    test(`${toolName} cancellation before driver dispatch retains cancelled status: ${mode}`, async t => {
      const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-cancel-trace-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const controller = new AbortController();
      const { trace, rows, diagnose } = traceFixture();
      let reads = 0;
      let actions = 0;
      const securityEvents: string[] = [];
      const security = new ToolSecurity({
        cwd: root, dataRoot: root,
        desktopWindowState: async () => {
          if (++reads === 2 && mode === "during-recheck") controller.abort();
          return { pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
            screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
            images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
            elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
              value: "", frame: { x: 20, y: 40, w: 400, h: 60 } }] };
        },
        desktopClick: async () => { actions++; return { effect: "confirmed" }; },
        desktopScroll: async () => { actions++; return { effect: "confirmed" }; },
        desktopType: async () => { actions++; return { effect: "confirmed" }; },
        createDesktopFocusGuard: async () => ({
          arm: async () => ({ value: "", selectionStart: 0, selectionLength: 0 }),
          check: async () => ({ value: "", selectionStart: 0, selectionLength: 0 }),
          close: async () => {},
        }),
      });
      t.after(() => security.approvals.close());
      const run = await security.prepare("session", event => {
        securityEvents.push(event.type);
        if (event.type === "security-approval-requested") {
          trace.agentEvent({ type: "approval-requested", request: event.request });
          security.approvals.decide(event.request.id, true);
        }
        if (event.type === "security-approval-decided" && event.approved && mode === "after-approval") controller.abort();
      }, diagnose);
      await run.execute(async () => {
        const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
        const result = await observe.execute("observe", { pid: 123, windowId: "42" });
        const content = result.content[0];
        assert.ok(content.type === "text");
        const { observationId } = JSON.parse(content.text);
        const params = toolName === "desktop_click"
          ? { observationId, position: { kind: "element", elementToken: "body" }, deliveryMode: "background" }
          : toolName === "desktop_scroll"
            ? { observationId, x: 20, y: 40, direction: "down", by: "line", amount: 1 }
            : { observationId, elementToken: "body", text: "not typed" };
        trace.agentEvent({ type: "tool-start", callId: "action", name: toolName, input: {} });
        const tool = security.tools.find(item => item.name === toolName)!;
        await assert.rejects(tool.execute("action", params, controller.signal), /cancelled/);
        trace.agentEvent({ type: "tool-end", callId: "action", name: toolName, text: "cancelled", isError: true });
      });
      const end = rows.find(row => row.payload.type === "tool_call_ended")!;
      assert.ok(end.payload.type === "tool_call_ended");
      assert.equal(end.payload.status, "cancelled");
      assert.equal(end.attachment?.value.error_code, "aborted");
      assert.equal(actions, 0);
      assert.equal(securityEvents.includes("security-tool-committed"), false);
      assert.equal(securityEvents.includes("security-desktop-execution-uncertain"), false);
    });
  }
}
