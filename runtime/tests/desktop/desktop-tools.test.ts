import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolSecurity } from "../../src/security/tool-security.js";

test("desktop window observation uses the driver without requesting approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let observations = 0;
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindows: async () => {
      observations += 1;
      return [{ windowId: 42n, pid: 123, appName: "Editor", title: "notes.txt" }];
    },
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_windows");
    assert.ok(observe);
    const result = await run.execute(() => observe.execute("call-1", {}, new AbortController().signal));
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const observed = JSON.parse(content.text) as { windows: Array<{ windowId: string; title: string }> };
    assert.equal(observations, 1);
    assert.deepEqual(observed.windows, [{ windowId: "42", pid: 123, appName: "Editor", title: "notes.txt" }]);
    assert.deepEqual(security.approvals.pending(), []);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop window observation bounds titles and the number of windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const options = {
    cwd: root,
    dataRoot: root,
    desktopWindows: async () => Array.from({ length: 101 }, (_, index) => ({
      windowId: BigInt(index + 1),
      pid: index + 1,
      appName: "A".repeat(300),
      title: "T".repeat(300),
    })),
  };
  const security = new ToolSecurity(options);
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_windows");
    assert.ok(observe);
    const result = await run.execute(() => observe.execute("call-1", {}, new AbortController().signal));
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const observed = JSON.parse(content.text) as { windows: Array<{ appName: string; title: string }>; truncated: boolean };
    assert.equal(observed.windows.length, 100);
    assert.equal(observed.truncated, true);
    assert.equal(observed.windows[0]?.appName.length, 200);
    assert.equal(observed.windows[0]?.title.length, 200);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop window state reads the exact window without approval and bounds displayed text", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const requests: Array<{ pid: number; windowId: bigint }> = [];
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async (target: { pid: number; windowId: bigint }) => {
      requests.push(target);
      return {
        pid: target.pid,
        windowId: target.windowId,
        snapshotId: "snapshot-1",
        appName: "Editor",
        windowTitle: "notes.txt",
        treeMarkdown: "X".repeat(21_000),
        truncated: false,
        elements: [{ elementIndex: 1n, role: "button", depth: 0, label: "Save", elementToken: "element-1", enabled: true }],
      };
    },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    assert.ok(observe);
    const result = await run.execute(() => observe.execute("call-2", { pid: 123, windowId: "42" }, new AbortController().signal));
    assert.deepEqual(requests, [{ pid: 123, windowId: 42n }]);
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const observed = JSON.parse(content.text) as { snapshotId: string; treeMarkdown: string; textTruncated: boolean; elements: Array<{ elementIndex: string; elementToken: string }> };
    assert.equal(observed.snapshotId, "snapshot-1");
    assert.equal(observed.treeMarkdown.length, 20_000);
    assert.equal(observed.textTruncated, true);
    assert.equal(observed.elements[0]?.elementIndex, "1");
    assert.equal(observed.elements[0]?.elementToken, "element-1");
    assert.deepEqual(security.approvals.pending(), []);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop window state reports degraded accessibility rather than implying an empty window", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123,
      windowId: 42n,
      degraded: true,
      degradedReason: "Accessibility permission unavailable",
      elements: [],
    }),
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    assert.ok(observe);
    const result = await run.execute(() => observe.execute("call-3", { pid: 123, windowId: "42" }, new AbortController().signal));
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const observed = JSON.parse(content.text) as { degraded: boolean; degradedReason: string; elements: unknown[]; observationId?: string };
    assert.equal(observed.degraded, true);
    assert.equal(observed.degradedReason, "Accessibility permission unavailable");
    assert.deepEqual(observed.elements, []);
    assert.equal(observed.observationId, undefined);
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop window state includes a fresh bounded screenshot when accessibility is degraded", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({
      pid: 123,
      windowId: 42n,
      degraded: true,
      degradedReason: "ax_window_unresolved",
      screenshotFrameValid: true,
      screenshotWidth: 640,
      screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
    }),
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    assert.ok(observe);
    const result = await run.execute(() => observe.execute("call-4", { pid: 123, windowId: "42" }, new AbortController().signal));
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const metadata = JSON.parse(content.text) as { observationId?: string; screenshotAvailable: boolean; screenshotWidth: number; screenshotHeight: number };
    assert.match(metadata.observationId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(metadata.screenshotAvailable, true);
    assert.equal(metadata.screenshotWidth, 640);
    assert.equal(metadata.screenshotHeight, 480);
    assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop observation does not authorize clicks from an empty screenshot or invalid dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const states = [
    { screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "" }] },
    { screenshotFrameValid: true, screenshotWidth: 0, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] },
  ];
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, ...states.shift()! }),
    desktopClick: async () => ({ effect: "confirmed" as const }),
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    assert.ok(observe);
    await run.execute(async () => {
      for (let index = 0; index < 2; index += 1) {
        const result: { content: Array<{ type: string; text?: string }> } = await observe.execute(`observe-${index}`, { pid: 123, windowId: "42" });
        const content = result.content[0];
        assert.equal(content?.type, "text");
        assert.ok(content?.text);
        const metadata = JSON.parse(content.text) as { observationId?: string; screenshotAvailable: boolean };
        assert.equal(metadata.observationId, undefined);
        assert.equal(metadata.screenshotAvailable, false);
      }
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop click waits for one approval, executes the exact observed window action, and reobserves", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const calls: Array<{ pid: number; windowId: bigint; position: { x: number; y: number } | { elementToken: string }; deliveryMode: string }> = [];
  let observations = 0;
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async (target: { pid: number; windowId: bigint }) => {
      observations += 1;
      return { ...target, appName: "Editor", windowTitle: "notes.txt", screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] };
    },
    desktopClick: async input => {
      calls.push(input);
      return { effect: "confirmed" as const, summary: "Clicked Save" };
    },
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" }, new AbortController().signal);
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pendingClick = click.execute("click-1", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }, new AbortController().signal);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 0);
      const pending = security.approvals.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.tool, "desktop_click");
      assert.deepEqual(pending[0]?.previewImage, { mimeType: "image/png", dataBase64: "aW1hZ2U=" });
      const approvedTarget = pending[0]!.target;
      assert.ok(typeof approvedTarget !== "string");
      assert.equal(approvedTarget.windowId, "42");
      security.approvals.decide(pending[0]!.id, true);
      const result = await pendingClick;
      assert.equal(approvedTarget.screenshotSha256, createHash("sha256").update(Buffer.from("aW1hZ2U=", "base64")).digest("hex"));
      assert.doesNotMatch(JSON.stringify(approvedTarget), /aW1hZ2U=/);
      assert.deepEqual(calls, [{ pid: 123, windowId: 42n, position: { x: 10, y: 20 }, deliveryMode: "background" }]);
      assert.equal(observations, 3);
      assert.ok(result.content.some(item => item.type === "text" && item.text.includes("Clicked Save")));
      assert.equal(events.filter(event => event.type === "security-tool-committed").length, 1);
      assert.equal(events.find(event => event.type === "security-tool-committed")?.target, pending[0]!.target);
      assert.equal(approvedTarget.action, "click");
      if (approvedTarget.action === "click") {
        assert.notEqual(approvedTarget.position, calls[0]!.position, "Approval snapshot must not share mutable driver input");
        if ("x" in calls[0]!.position) calls[0]!.position.x = 999;
        assert.deepEqual(approvedTarget.position, { x: 10, y: 20 });
      }
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop driver failure after approval records uncertain effects and warns against retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { throw new Error("driver response lost"); },
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const observation = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const id = (JSON.parse(content.text) as { observationId: string }).observationId;
      const pending = click.execute("click-1", { observationId: id, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await assert.rejects(pending, /may have run.*Check side effects before retrying/);
      assert.equal(events.filter(event => event.type === "security-desktop-execution-uncertain").length, 1);
      assert.equal(events.find(event => event.type === "security-desktop-execution-uncertain")?.tool, "desktop_click");
      assert.equal(events.filter(event => event.type === "security-tool-committed").length, 0);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const status of ["executed", "uncertain"] as const) {
  test(`desktop ${status} receipt survives audit failure and stays local to its call`, async t => {
    const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-audit-failure-"));
    const security = new ToolSecurity({
      cwd: root, dataRoot: root,
      desktopWindowState: async () => ({ pid: 123, windowId: 42n, screenshotFrameValid: true,
        screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
      desktopClick: async () => {
        if (status === "uncertain") throw new Error("driver response lost");
        return { effect: "confirmed" };
      },
    });
    t.after(async () => { security.approvals.close(); await rm(root, { recursive: true, force: true }); });
    const run = await security.prepare("session-a", event => {
      if (event.type === "security-tool-committed" || event.type === "security-desktop-execution-uncertain") {
        throw new Error("audit unavailable");
      }
    });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
    const click = security.tools.find(tool => tool.name === "desktop_click")!;
    await run.execute(async () => {
      const observation = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const action = click.execute("click", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      const outcome = status === "uncertain"
        ? assert.rejects(action, /may have run.*audit unavailable/)
        : action.then(result => {
          assert.ok(result.content.some(item => item.type === "text" && /click executed.*audit unavailable/.test(item.text)));
        });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await outcome;
      const next = await observe.execute("observe-next", { pid: 123, windowId: "42" });
      assert.ok(next.content.every(item => item.type !== "text" || !/audit unavailable|application approval/.test(item.text)));
    });
  });
}

test("cancellation during post-approval reobservation prevents desktop input", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let observations = 0;
  let releaseObservation!: () => void;
  const observationWait = new Promise<void>(resolve => { releaseObservation = resolve; });
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      if (observations === 2) await observationWait;
      return { pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] };
    },
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const id = (JSON.parse(content.text) as { observationId: string }).observationId;
      const controller = new AbortController();
      const pending = click.execute("click-1", { observationId: id, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }, controller.signal);
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      while (observations < 2) await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      releaseObservation();
      await assert.rejects(pending, /cancelled/);
      assert.equal(clicks, 0);
    });
  } finally {
    releaseObservation();
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation during post-approval app identity refresh prevents click and scroll", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  try {
    for (const toolName of ["desktop_click", "desktop_scroll"] as const) {
      let identityReads = 0;
      let enteredIdentityRefresh!: () => void;
      let releaseIdentityRefresh!: () => void;
      const identityRefreshStarted = new Promise<void>(resolve => { enteredIdentityRefresh = resolve; });
      const identityRefreshWait = new Promise<void>(resolve => { releaseIdentityRefresh = resolve; });
      let dispatched = 0;
      const security = new ToolSecurity({
        cwd: root,
        dataRoot: root,
        desktopAppForPid: async pid => {
          identityReads += 1;
          if (identityReads === 2) {
            enteredIdentityRefresh();
            await identityRefreshWait;
          }
          return { pid, appName: "Editor", bundleId: "com.example.editor" };
        },
        desktopWindowState: async () => ({
          pid: 123, windowId: 42n, appName: "Editor", screenshotFrameValid: true,
          screenshotWidth: 640, screenshotHeight: 480,
          images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        }),
        desktopClick: async () => { dispatched += 1; return { effect: "confirmed" as const }; },
        desktopScroll: async () => { dispatched += 1; return { effect: "confirmed" as const }; },
      });
      try {
        const run = await security.prepare("session-a", () => {});
        const observe = security.tools.find(tool => tool.name === "desktop_window_state");
        const action = security.tools.find(tool => tool.name === toolName);
        assert.ok(observe && action);
        await run.execute(async () => {
          const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
          const content = observed.content[0];
          assert.equal(content?.type, "text");
          const { observationId } = JSON.parse(content.text) as { observationId: string };
          const controller = new AbortController();
          const args = toolName === "desktop_click"
            ? { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }
            : { observationId, x: 10, y: 20, direction: "down", by: "line", amount: 1 };
          const pending = action.execute("action", args, controller.signal);
          await new Promise(resolve => setImmediate(resolve));
          security.approvals.decide(security.approvals.pending()[0]!.id, true);
          await identityRefreshStarted;
          controller.abort();
          releaseIdentityRefresh();
          await assert.rejects(pending, /cancelled/);
          assert.equal(dispatched, 0, `${toolName} dispatched after cancellation`);
        });
      } finally {
        releaseIdentityRefresh();
        security.approvals.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another session cannot replace desktop snapshot context during an approved click", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let observations = 0;
  let startClick!: () => void;
  let releaseClick!: () => void;
  const clickStarted = new Promise<void>(resolve => { startClick = resolve; });
  const clickWait = new Promise<void>(resolve => { releaseClick = resolve; });
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      return { pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] };
    },
    desktopClick: async () => { startClick(); await clickWait; return { effect: "confirmed" as const }; },
  });
  try {
    const runA = await security.prepare("session-a", () => {});
    const runB = await security.prepare("session-b", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    const actionA = runA.execute(async () => {
      const observed = await observe.execute("observe-a", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const id = (JSON.parse(content.text) as { observationId: string }).observationId;
      const pending = click.execute("click-a", { observationId: id, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      return pending;
    });
    await clickStarted;
    const observationB = runB.execute(() => observe.execute("observe-b", { pid: 123, windowId: "42" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observations, 2, "second session observed while first click was in progress");
    releaseClick();
    await Promise.all([actionA, observationB]);
    assert.equal(observations, 4);
  } finally {
    releaseClick();
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop click refreshes an observed accessibility element before approved dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let observations = 0;
  const positions: Array<{ x: number; y: number } | { elementToken: string }> = [];
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      return {
        pid: 123, windowId: 42n, appName: "Editor", windowTitle: "notes.txt",
        screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        elements: [{ elementIndex: 1n, role: "button", depth: 0, label: "Save", enabled: true, elementToken: observations === 1 ? "old-token" : "fresh-token" }],
      };
    },
    desktopClick: async input => { positions.push(input.position); return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const id = (JSON.parse(content.text) as { observationId: string }).observationId;
      const pending = click.execute("click-1", { observationId: id, position: { kind: "element", elementToken: "old-token" }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await pending;
      assert.deepEqual(positions, [{ elementToken: "fresh-token" }]);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported background AXPress retries the same approved element by fresh window-local coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const positions: Array<{ x: number; y: number } | { elementToken: string }> = [];
  const events: Array<{ type: string }> = [];
  let observations = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      return {
        pid: 123, windowId: 42n, appName: "Editor", windowTitle: "notes.txt",
        screenshotFrameValid: true, screenshotWidth: 1200, screenshotHeight: 800,
        windowBounds: { x: 100, y: 200, width: 600, height: 400 },
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        elements: [{ elementIndex: 1n, role: "AXTextField", depth: 0, label: "Search", value: "", enabled: true,
          frame: { x: 160, y: 260, w: 100, h: 40 }, elementToken: `token-${observations}` }],
      };
    },
    desktopClick: async input => {
      positions.push(input.position);
      if (positions.length === 1) {
        throw Object.assign(new Error("AXPress unsupported"), { tag: "Tool", inner: {
          tool: "click", message: "AX action failed: AXUIElementPerformAction(AXPress) returned -25206",
        } });
      }
      return { effect: "unverifiable" as const, summary: "Background coordinate click dispatched" };
    },
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe && click);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pending = click.execute("click-1", { observationId, position: { kind: "element", elementToken: "token-1" }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      const result = await pending;
      assert.deepEqual(positions, [{ elementToken: "token-2" }, { x: 220, y: 160 }]);
      assert.equal(observations, 4);
      assert.ok(result.content.some(item => item.type === "text" && item.text.includes("Background coordinate click dispatched")));
      assert.equal(events.filter(event => event.type === "security-tool-committed").length, 1);
      assert.equal(events.filter(event => event.type === "security-desktop-execution-uncertain").length, 0);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported AXPress does not retry when the element changes before coordinate fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  const positions: Array<{ x: number; y: number } | { elementToken: string }> = [];
  const events: Array<{ type: string }> = [];
  let observations = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => {
      observations += 1;
      return {
        pid: 123, windowId: 42n, appName: "Editor", windowTitle: "notes.txt",
        screenshotFrameValid: true, screenshotWidth: 1200, screenshotHeight: 800,
        windowBounds: { x: 100, y: 200, width: 600, height: 400 },
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
        elements: [{ elementIndex: 1n, role: "AXTextField", depth: 0, label: "Search", value: "", enabled: true,
          frame: { x: observations === 3 ? 170 : 160, y: 260, w: 100, h: 40 }, elementToken: `token-${observations}` }],
      };
    },
    desktopClick: async input => {
      positions.push(input.position);
      throw Object.assign(new Error("AXPress unsupported"), { tag: "Tool", inner: {
        tool: "click", message: "AX action failed: AXUIElementPerformAction(AXPress) returned -25206",
      } });
    },
  });
  try {
    const run = await security.prepare("session-a", event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe && click);
    await run.execute(async () => {
      const observed = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const pending = click.execute("click-1", { observationId, position: { kind: "element", elementToken: "token-1" }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await assert.rejects(pending, /may have run.*Check side effects before retrying/);
      assert.deepEqual(positions, [{ elementToken: "token-2" }]);
      assert.equal(events.filter(event => event.type === "security-tool-committed").length, 0);
      assert.equal(events.filter(event => event.type === "security-desktop-execution-uncertain").length, 1);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop click rejects an aged observation before requesting approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let now = 1_000;
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    now: () => now,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const observation = await observe.execute("observe-1", { pid: 123, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      now += 30_001;
      await assert.rejects(click.execute("click-1", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }), /stale/);
      assert.deepEqual(security.approvals.pending(), []);
      assert.equal(clicks, 0);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop click never dispatches after an app denial or when the approved window changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-tools-"));
  let windowId = 42n;
  let clicks = 0;
  const security = new ToolSecurity({
    cwd: root,
    dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId, appName: "Editor", windowTitle: "notes.txt", screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480, images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => { clicks += 1; return { effect: "confirmed" as const }; },
  });
  try {
    const run = await security.prepare("session-a", () => {});
    const otherRun = await security.prepare("session-b", () => {});
    const observe = security.tools.find(tool => tool.name === "desktop_window_state");
    const click = security.tools.find(tool => tool.name === "desktop_click");
    assert.ok(observe);
    assert.ok(click);
    await run.execute(async () => {
      const getId = async () => {
        const observation = await observe.execute("observe", { pid: 123, windowId: "42" });
        const content = observation.content[0];
        assert.equal(content?.type, "text");
        return (JSON.parse(content.text) as { observationId: string }).observationId;
      };
      const deniedId = await getId();
      const denied = click.execute("denied", { observationId: deniedId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      security.approvals.decide(security.approvals.pending()[0]!.id, false);
      await assert.rejects(denied, /did not approve/);
      const deniedAgainId = await getId();
      await assert.rejects(click.execute("denied-again", { observationId: deniedAgainId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }), /denied desktop access/);
      assert.deepEqual(security.approvals.pending(), []);
      assert.equal(clicks, 0);
    });
    await otherRun.execute(async () => {
      const observation = await observe.execute("observe-other", { pid: 123, windowId: "42" });
      const content = observation.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text) as { observationId: string };
      const changed = click.execute("changed", { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" });
      await new Promise(resolve => setImmediate(resolve));
      windowId = 43n;
      security.approvals.decide(security.approvals.pending()[0]!.id, true);
      await assert.rejects(changed, /window changed.*no click executed/);
      assert.equal(clicks, 0);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});
