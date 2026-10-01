import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolSecurity } from "../../src/security/tool-security.js";

test("desktop scroll requires an exact observed window and one approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-scroll-"));
  const actions: unknown[] = [];
  let observations = 0;
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      return {
        pid: 123,
        windowId: 42n,
        appName: "Editor",
        windowTitle: "notes.txt",
        screenshotFrameValid: true,
        screenshotWidth: 640,
        screenshotHeight: 480,
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      };
    },
    desktopScroll: async (input: unknown) => {
      actions.push(input);
      return { effect: "confirmed" as const, summary: "Scrolled" };
    },
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const scroll = security.tools.find(tool => tool.name === "desktop_scroll");
    assert.ok(observe);
    assert.ok(scroll);
    assert.match(scroll.description, /first action in an app requires conversation-scoped approval/i);
    assert.match(scroll.description, /background.*no foreground retry/i);
    assert.doesNotMatch(scroll.description, /one user approval/i);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pending = scroll.execute("scroll-1", {
        observationId,
        x: 320,
        y: 240,
        direction: "down",
        by: "line",
        amount: 3,
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(actions, []);
      const approval = security.approvals.pending()[0];
      assert.equal(approval?.tool, "desktop_scroll");
      assert.deepEqual(approval.previewImage, { mimeType: "image/png", dataBase64: "aW1hZ2U=" });
      security.approvals.decide(approval.id, true);
      const result = await pending;
      assert.equal(observations, 3);
      assert.deepEqual(actions, [{ pid: 123, windowId: 42n, x: 320, y: 240, direction: "down", by: "line", amount: 3 }]);
      assert.ok(result.content.some(item => item.type === "text" && item.text.includes("Scrolled")));
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop scroll failure after approval records the correct uncertain tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-scroll-"));
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopScroll: async () => { throw new Error("driver response lost"); },
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const scroll = security.tools.find(tool => tool.name === "desktop_scroll");
    assert.ok(observe);
    assert.ok(scroll);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pending = scroll.execute("scroll-1", { observationId, x: 320, y: 240, direction: "down", by: "line", amount: 3 });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await assert.rejects(pending, /may have run.*Check side effects before retrying/);
      assert.equal(events.find(event => event.type === "security-desktop-execution-uncertain")?.tool, "desktop_scroll");
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop scroll rejects non-string directions before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-scroll-"));
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopScroll: async () => ({ effect: "confirmed" as const }),
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const scroll = security.tools.find(tool => tool.name === "desktop_scroll");
    assert.ok(observe);
    assert.ok(scroll);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const attempted = scroll.execute("scroll-invalid", {
        observationId,
        x: 320,
        y: 240,
        direction: { toString: () => "down" },
        by: "line",
        amount: 3,
      });
      const rejected = assert.rejects(attempted, /Invalid desktop scroll arguments/);
      await new Promise(resolve => setImmediate(resolve));
      for (const pending of security.approvals.pending()) security.approvals.decide(pending.id, false);
      await rejected;
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop scroll dispatches neither an app-denied nor a changed-window action", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-scroll-"));
  let windowId = 42n;
  let actions = 0;
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId, appName: "Editor", windowTitle: "notes.txt", screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopScroll: async () => { actions += 1; return { effect: "confirmed" as const }; },
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const otherRun = await security.prepare("session-b", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const scroll = security.tools.find(tool => tool.name === "desktop_scroll");
    assert.ok(observe);
    assert.ok(scroll);
    await run.execute(async () => {
      const nextId = async () => {
        const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
        const content = observed.content[0];
        assert.equal(content?.type, "text");
        return (JSON.parse(content.text) as { observationId: string }).observationId;
      };
      const args = (observationId: string) => ({ observationId, x: 320, y: 240, direction: "down", by: "line", amount: 3 });
      const denied = scroll.execute("scroll-denied", args(await nextId()));
      const deniedResult = assert.rejects(denied, /did not approve/);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, false);
      await deniedResult;
      await assert.rejects(scroll.execute("scroll-denied-again", args(await nextId())), /denied desktop access/);
      assert.deepEqual(security.approvals.pending(), []);
      assert.equal(actions, 0);
    });
    await otherRun.execute(async () => {
      const observed = await observe.execute("observe-other", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const changed = scroll.execute("scroll-changed", { observationId, x: 320, y: 240, direction: "down", by: "line", amount: 3 });
      const changedResult = assert.rejects(changed, /window changed.*no scroll executed/);
      await new Promise(resolve => setImmediate(resolve));
      windowId = 43n;
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await changedResult;
      assert.equal(actions, 0);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});
