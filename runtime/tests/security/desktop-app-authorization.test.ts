import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolSecurity, type SecurityToolEvent } from "../../src/security/tool-security.js";

test("one app approval authorizes later clicks, scrolls, and typing in that app", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-app-auth-"));
  const clicks: bigint[] = [];
  const scrolls: bigint[] = [];
  const events: SecurityToolEvent[] = [];
  let fieldValue = "";
  const focusModes: string[] = [];
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    ownPid: 999,
    desktopAppForPid: async (pid, observedAppName) => {
      assert.equal(observedAppName, "Editor");
      return { pid, appName: "Editor", bundleId: "com.example.editor" };
    },
    desktopWindowState: async ({ pid, windowId }) => ({ pid, windowId, appName: "Editor", windowTitle: `Window ${windowId}`,
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "body", label: "Body",
        enabled: true, frame: { x: 20, y: 40, w: 400, h: 60 }, value: fieldValue }] }),
    desktopClick: async ({ windowId, deliveryMode }) => { clicks.push(windowId); focusModes.push(deliveryMode); return { effect: "confirmed" as const }; },
    desktopScroll: async ({ windowId }) => { scrolls.push(windowId); return { effect: "confirmed" as const }; },
    desktopType: async ({ text }) => { fieldValue += text; return { effect: "confirmed" as const }; },
    createDesktopFocusGuard: async () => ({
      arm: async () => ({ value: fieldValue, selectionStart: fieldValue.length, selectionLength: 0 }),
      check: async () => ({ value: fieldValue, selectionStart: fieldValue.length, selectionLength: 0 }),
      close: async () => {},
    }),
  });
  try {
    const run = await security.prepare("chat-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    const scroll = security.tools.find(tool => tool.name === "desktop_scroll")!;
    const type = security.tools.find(tool => tool.name === "desktop_type")!;
    await run.execute(async () => {
      const act = async (windowId: string, callId: string) => {
        const observation = await observe.execute(`observe-${callId}`, { pid: 123, windowId });
        const content = observation.content[0];
        assert.equal(content?.type, "text");
        const { observationId } = JSON.parse(content.text) as { observationId: string };
        return click.execute(callId, { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      };
      const first = act("42", "click-1");
      await new Promise(resolve => setImmediate(resolve));
      const approval = security.approvals.pending()[0];
      assert.ok(approval);
      assert.ok(typeof approval.target !== "string");
      assert.equal(approval.target.bundleId, "com.example.editor");
      security.approvals.decide(approval.id, true);
      await first;
      const second = await act("43", "click-2");
      assert.ok(second.content.some(item => item.type === "text" && item.text.includes("conversation-scoped application approval")));
      const observed = await observe.execute("observe-scroll", { pid: 123, windowId: "43" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const scrollAction = scroll.execute("scroll-1", { observationId, x: 50, y: 50, direction: "down", by: "line", amount: 1 });
      scrollAction.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const unexpected = security.approvals.pending();
      for (const pending of unexpected) security.approvals.decide(pending.id, false);
      assert.deepEqual(unexpected, [], "a granted app must not request another approval for scrolling");
      await scrollAction;
      const typeObservation = await observe.execute("observe-type", { pid: 123, windowId: "43" });
      const typeContent = typeObservation.content[0];
      assert.equal(typeContent?.type, "text");
      const typeId = (JSON.parse(typeContent.text) as { observationId: string }).observationId;
      const typeAction = type.execute("type-1", { observationId: typeId, elementToken: "body", text: "hello" });
      typeAction.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const typeApproval = security.approvals.pending();
      for (const pending of typeApproval) security.approvals.decide(pending.id, false);
      assert.deepEqual(typeApproval, [], "a granted app must not request another approval for typing");
      await typeAction;
      assert.deepEqual(clicks, [42n, 43n, 43n]);
      assert.deepEqual(focusModes, ["background", "background", "background"]);
      assert.deepEqual(scrolls, [43n]);
      assert.equal(fieldValue, "hello");
      const actions = events.filter(event => event.type === "security-tool-committed");
      assert.deepEqual(actions.map(event => event.callId), ["click-1", "click-2", "scroll-1", "type-1"]);
      const typedTarget = actions.at(-1)?.target;
      assert.ok(typedTarget && typeof typedTarget !== "string");
      assert.equal(typedTarget.action, "type");
      if (typedTarget.action === "type") {
        assert.equal(typedTarget.textLength, 5);
        assert.match(typedTarget.textSha256, /^[0-9a-f]{64}$/);
      }
      assert.doesNotMatch(JSON.stringify(typedTarget), /hello/);
      assert.deepEqual(security.approvals.pending(), []);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenScreen's own window is refused before an approval request", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-self-auth-"));
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root, dataRoot: root, ownPid: 999,
    desktopAppForPid: async pid => ({ pid, appName: "OpenScreen", bundleId: "com.github.Electron" }),
    desktopWindowState: async ({ pid, windowId }) => ({ pid, windowId, appName: "OpenScreen", windowTitle: "Chat",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("chat-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    await run.execute(async () => {
      const observation = await observe.execute("observe", { pid: 999, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      await assert.rejects(click.execute("click", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }), /OpenScreen.*window/);
      assert.deepEqual(security.approvals.pending(), []);
      assert.equal(clicks, 0);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("foreground delivery cannot be requested through desktop_click", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-background-"));
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopWindowState: async ({ pid, windowId }) => ({ pid, windowId, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("chat-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    await run.execute(async () => {
      const observation = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      await assert.rejects(click.execute("click", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "foreground" }), /background only/);
      assert.deepEqual(security.approvals.pending(), []);
      assert.equal(clicks, 0);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});

test("an approval is not reused when recording its decision fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-decision-audit-"));
  let clicks = 0;
  let failDecision = true;
  const security = new ToolSecurity({
    cwd: root, dataRoot: root,
    desktopAppForPid: async pid => ({ pid, appName: "Editor", bundleId: "com.example.editor" }),
    desktopWindowState: async ({ pid, windowId }) => ({ pid, windowId, appName: "Editor", windowTitle: "Draft",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("chat-a", event => {
      if (event.type === "security-approval-decided" && failDecision) throw new Error("audit unavailable");
    });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    await run.execute(async () => {
      const act = async (callId: string) => {
        const observation = await observe.execute(`observe-${callId}`, { pid: 123, windowId: "42" });
        const content = observation.content[0];
        assert.equal(content?.type, "text");
        const { observationId } = JSON.parse(content.text) as { observationId: string };
        return click.execute(callId, { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      };
      const first = act("first");
      first.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const original = security.approvals.pending()[0];
      assert.ok(original);
      security.approvals.decide(original.id, true);
      await assert.rejects(first, /audit unavailable/);
      assert.equal(clicks, 0);
      failDecision = false;
      const second = act("second");
      second.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const retry = security.approvals.pending()[0];
      assert.ok(retry, "a grant without a durable decision must not authorize another action");
      assert.notEqual(retry.id, original.id);
      security.approvals.decide(retry.id, true);
      await second;
      assert.equal(clicks, 1);
    });
  } finally { security.approvals.close(); await rm(root, { recursive: true, force: true }); }
});
