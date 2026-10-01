import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolSecurity } from "../../src/security/tool-security.js";

for (const mode of ["cancel-during-check", "value-change", "selection-change"] as const) {
  test(`desktop type stops on segment-boundary interference: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "openscreen-segment-interference-"));
    const controller = new AbortController();
    let value = "";
    let selection = 0;
    let checks = 0;
    let typed = 0;
    const events: string[] = [];
    const security = new ToolSecurity({
      cwd: root, dataRoot: root,
      desktopWindowState: async () => ({ pid: 123, windowId: 42n, windowTitle: "Draft",
        screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
          value: "", frame: { x: 20, y: 40, w: 400, h: 60 } }] }),
      desktopClick: async () => ({ effect: "confirmed" }),
      createDesktopFocusGuard: async () => ({
        arm: async () => ({ value, selectionStart: selection, selectionLength: 0 }),
        check: async () => {
          checks += 1;
          if (checks === 1 && mode === "cancel-during-check") controller.abort();
          if (checks === 3 && mode === "value-change") { value = "external change"; selection = value.length; }
          if (checks === 3 && mode === "selection-change") selection = 0;
          return { value, selectionStart: selection, selectionLength: 0 };
        },
        close: async () => {},
      }),
      desktopType: async ({ text }) => {
        typed += 1;
        value = value.slice(0, selection) + text + value.slice(selection);
        selection += text.length;
        return { effect: "confirmed" };
      },
    });
    try {
      const run = await security.prepare("session-a", event => {
        events.push(event.type);
        if (event.type === "security-approval-requested") security.approvals.decide(event.request.id, true);
      });
      await run.execute(async () => {
        const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
        const result = await observe.execute("observe", { pid: 123, windowId: "42" });
        const content = result.content[0];
        assert.equal(content?.type, "text");
        const { observationId } = JSON.parse(content.text);
        const type = security.tools.find(tool => tool.name === "desktop_type")!;
        await assert.rejects(type.execute("type", { observationId, elementToken: "body", text: "a".repeat(40) }, controller.signal),
          /cancelled|changed between text segments/);
        assert.equal(typed, mode === "cancel-during-check" ? 0 : 1);
        assert.equal(events.includes("security-tool-committed"), false);
        assert.equal(events.includes("security-desktop-execution-uncertain"), true);
      });
    } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["ax-focused", "coordinates", "unexpected-error", "changed-element", "cancelled", "native-value-change", "cancel-during-verify"] as const) {
  test(`desktop type focus fallback: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "openscreen-focus-fallback-"));
    const actions: string[] = [];
    let value = "";
    let reads = 0;
    const controller = new AbortController();
    const security = new ToolSecurity({
      cwd: root, dataRoot: root,
      desktopWindowState: async () => ({
        pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
        windowBounds: { x: 100, y: 200, width: 640, height: 480 },
        screenshotFrameValid: true, screenshotWidth: 1280, screenshotHeight: 960,
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
          value: ++reads > 2 && mode === "changed-element" ? "changed" : "",
          enabled: true, frame: { x: 120, y: 240, w: 400, h: 60 } }],
      }),
      desktopClick: async ({ position, deliveryMode }) => {
        assert.equal(deliveryMode, "background");
        if ("elementToken" in position) {
          actions.push("press");
          if (mode === "unexpected-error") throw new Error("driver timed out");
          throw Object.assign(new Error("DriverError.Tool"), {
            tag: "Tool", inner: { tool: "click", message: "AX action failed: AXUIElementPerformAction(AXPress) returned -25206" },
          });
        }
        actions.push("coordinates");
        assert.deepEqual(position, { x: 440, y: 140 });
        return { effect: "unverifiable" };
      },
      desktopType: async ({ text }) => { actions.push("type"); value += text; return { effect: "confirmed" }; },
      createDesktopFocusGuard: async () => {
        if (mode === "cancelled") controller.abort();
        return {
        focus: async () => { actions.push("ax-focused"); return mode === "ax-focused"; },
        verifyTarget: async () => {
          actions.push("verify-target");
          if (mode === "native-value-change") throw new Error("focus-value-changed");
          if (mode === "cancel-during-verify") controller.abort();
        },
        arm: async () => ({ value, selectionStart: value.length, selectionLength: 0 }),
        check: async () => ({ value, selectionStart: value.length, selectionLength: 0 }),
        close: async () => {},
        };
      },
    });
    try {
      const run = await security.prepare("session-a", event => {
        if (event.type === "security-approval-requested") security.approvals.decide(event.request.id, true);
      });
      await run.execute(async () => {
        const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
        const result = await observe.execute("observe", { pid: 123, windowId: "42" });
        const content = result.content[0];
        assert.equal(content?.type, "text");
        const { observationId } = JSON.parse(content.text);
        const type = security.tools.find(tool => tool.name === "desktop_type")!;
        const pending = type.execute("type", { observationId, elementToken: "body", text: "hello" }, controller.signal);
        if (mode === "cancelled") {
          await assert.rejects(pending, /cancelled/);
          assert.deepEqual(actions, []);
        } else if (mode === "native-value-change" || mode === "cancel-during-verify") {
          await assert.rejects(pending, /may have run/);
          assert.deepEqual(actions, ["press", "ax-focused", "verify-target"]);
          assert.equal(value, "");
        } else if (mode === "unexpected-error" || mode === "changed-element") {
          await assert.rejects(pending, /may have run/);
          assert.deepEqual(actions, ["press"]);
          assert.equal(value, "");
        } else {
          await pending;
          assert.deepEqual(actions, mode === "ax-focused" ? ["press", "ax-focused", "type"] : ["press", "ax-focused", "verify-target", "coordinates", "type"]);
          assert.equal(value, "hello");
        }
      });
    } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("desktop type authorizes the app before background focus and guarded input", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-"));
  const actions: string[] = [];
  let focused = false;
  let value = "";
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }],
    }),
    desktopClick: async ({ position, deliveryMode }: { position: unknown; deliveryMode: string }) => {
      assert.deepEqual(position, { elementToken: "body" });
      assert.equal(deliveryMode, "background");
      actions.push("click"); focused = true; return { effect: "unverifiable" as const };
    },
    createDesktopFocusGuard: async (target: { pid: number; windowId: bigint; windowTitle: string; element: unknown; screenshotWidth?: number }) => {
      assert.equal(target.screenshotWidth, 640);
      actions.push("guard-start");
      return {
        arm: async () => { assert.equal(focused, true); actions.push("guard-arm"); return { value, selectionStart: value.length, selectionLength: 0 }; },
        check: async () => { actions.push("guard-check"); return { value, selectionStart: value.length, selectionLength: 0 }; },
        close: async () => { actions.push("guard-close"); },
      };
    },
    desktopType: async ({ text }: { text: string }) => { actions.push("type"); value += text; return { effect: "confirmed" as const }; },
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const type = security.tools.find(tool => tool.name === "desktop_type");
    assert.ok(observe);
    assert.ok(type);
    assert.match(type.description, /conversation-scoped app approval.*background window input/i);
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pending = type.execute("type", { observationId, elementToken: "body", text: "ship now" });
      await new Promise(resolve => setImmediate(resolve));
      const approval = security.approvals.pending()[0];
      assert.equal(approval?.tool, "desktop_type");
      assert.equal(approval.proposedContent, undefined);
      assert.ok(typeof approval.target !== "string");
      assert.equal(approval.target.action, "type");
      if (approval.target.action === "type") assert.equal(approval.target.elementToken, "body");
      assert.deepEqual(actions, []);
      security.approvals.decide(approval.id, true);
      await pending;
      assert.equal(value, "ship now");
      assert.deepEqual(actions, ["guard-start", "click", "guard-arm", "guard-check", "type", "guard-check", "guard-close"]);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop type denial prevents focus click and text dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-denied-"));
  let actions = 0;
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }],
    }),
    desktopClick: async () => { actions += 1; return { effect: "confirmed" }; },
    desktopType: async () => { actions += 1; return { effect: "confirmed" }; },
    createDesktopFocusGuard: async () => { actions += 1; throw new Error("guard unexpectedly started"); },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = type.execute("type", { observationId, elementToken: "body", text: "ship now" });
      const rejected = assert.rejects(action, /did not approve/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, false);
      await rejected;
      assert.equal(actions, 0);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop type stops after focus guard detects a different element", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-focus-"));
  let typed = 0;
  const events: Array<{ type: string }> = [];
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }],
    }),
    desktopClick: async () => ({ effect: "confirmed" as const }),
    desktopType: async () => { typed += 1; return { effect: "confirmed" as const }; },
    createDesktopFocusGuard: async () => ({
      arm: async () => { throw new Error("focus-changed"); },
      check: async () => ({ value: "", selectionStart: 0, selectionLength: 0 }),
      close: async () => {},
    }),
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = type.execute("type", { observationId, elementToken: "body", text: "ship now" });
      const rejected = assert.rejects(action, /may have run and its effects are unknown/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await rejected;
      assert.equal(typed, 0);
      assert.ok(events.some(event => event.type === "security-desktop-execution-uncertain"));
      assert.equal(events.some(event => event.type === "security-tool-committed"), false);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop type does not accept a field that merely contains the proposed text", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-mismatch-"));
  let value = "ship now";
  const events: Array<{ type: string }> = [];
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }] }),
    desktopClick: async () => ({ effect: "confirmed" as const }),
    desktopType: async () => { value += "x"; return { effect: "confirmed" as const }; },
    createDesktopFocusGuard: async () => ({
      arm: async () => ({ value, selectionStart: value.length, selectionLength: 0 }),
      check: async () => ({ value, selectionStart: value.length, selectionLength: 0 }),
      close: async () => {},
    }),
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = type.execute("type", { observationId, elementToken: "body", text: "ship now" });
      const rejected = assert.rejects(action, /may have run and its effects are unknown/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await rejected;
      assert.equal(value, "ship nowx");
      assert.equal(events.some(event => event.type === "security-tool-committed"), false);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop type rejects a changed field value after approval before focusing", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-changed-"));
  let observation = 0;
  let actions = 0;
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
        value: observation++ === 0 ? "old" : "changed", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }] }),
    desktopClick: async () => { actions += 1; return { effect: "confirmed" as const }; },
    desktopType: async () => { actions += 1; return { effect: "confirmed" as const }; },
    createDesktopFocusGuard: async () => { actions += 1; throw new Error("Guard must not start"); },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = type.execute("type", { observationId, elementToken: "body", text: "new" });
      const rejected = assert.rejects(action, /changed after approval/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await rejected;
      assert.equal(actions, 0);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop type stops before the next segment when focus changes mid-input", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-type-interrupted-"));
  let value = "";
  let checks = 0;
  const events: Array<{ type: string }> = [];
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
        value: "", enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 } }] }),
    desktopClick: async () => ({ effect: "unverifiable" as const }),
    desktopType: async ({ text }: { text: string }) => { value += text; return { effect: "confirmed" as const }; },
    createDesktopFocusGuard: async () => ({
      arm: async () => ({ value, selectionStart: value.length, selectionLength: 0 }),
      check: async () => { if (++checks === 3) throw new Error("focus changed"); return { value, selectionStart: value.length, selectionLength: 0 }; },
      close: async () => {},
    }),
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = type.execute("type", { observationId, elementToken: "body", text: "a".repeat(40) });
      const rejected = assert.rejects(action, /may have run and its effects are unknown/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await rejected;
      assert.equal(value, "a".repeat(32));
      assert.ok(events.some(event => event.type === "security-desktop-execution-uncertain"));
      assert.equal(events.some(event => event.type === "security-tool-committed"), false);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});
