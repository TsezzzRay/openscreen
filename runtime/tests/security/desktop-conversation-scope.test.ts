import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolSecurity, type SecurityToolEvent } from "../../src/security/tool-security.js";

for (const decision of ["approved", "denied", "cancelled"] as const) {
  test(`application ${decision} state is scoped across Turns and Sessions`, { timeout: 5_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "openscreen-desktop-chat-scope-"));
    const events: SecurityToolEvent[] = [];
    const actions: number[] = [];
    const security = new ToolSecurity({
      cwd: root, dataRoot: root,
      desktopAppForPid: async pid => ({ pid, appName: "Editor", bundleId: "com.example.editor" }),
      desktopWindowState: async ({ pid, windowId }) => ({
        pid, windowId, appName: "Editor", windowTitle: "Draft",
        screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
        images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      }),
      desktopClick: async ({ pid }) => { actions.push(pid); return { effect: "confirmed" as const }; },
    });
    try {
      const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
      const click = security.tools.find(tool => tool.name === "desktop_click")!;
      const controller = new AbortController();
      const start = async (sessionId: string, callId: string, pid: number, signal?: AbortSignal) => {
        const run = await security.prepare(sessionId, event => { events.push(event); });
        return run.execute(async () => {
          const result = await observe.execute(`observe-${callId}`, { pid, windowId: "42" });
          const content = result.content[0];
          assert.equal(content?.type, "text");
          const { observationId } = JSON.parse(content.text) as { observationId: string };
          return click.execute(callId, { observationId, position: { kind: "coordinates", x: 10, y: 20 }, deliveryMode: "background" }, signal);
        });
      };
      const first = start("chat-a", "first", 123, controller.signal);
      first.catch(() => {});
      // prepare creates the per-Turn directory asynchronously.
      for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const initial = security.approvals.pending()[0];
      assert.ok(initial);
      if (decision === "cancelled") controller.abort();
      else security.approvals.decide(initial.id, decision === "approved");
      if (decision === "approved") await first;
      else if (decision === "cancelled") await assert.rejects(first, error =>
        error instanceof Error && "code" in error && error.code === "aborted");
      else await assert.rejects(first, /did not approve/);
      const outcome = events.find(event => event.type === "security-approval-decided" && event.id === initial.id);
      assert.ok(outcome?.type === "security-approval-decided");
      assert.equal(outcome.reason, decision);

      const second = start("chat-a", "second", 456);
      second.catch(() => {});
      // A new PID in the same app must inherit a bundle-scoped decision,
      // while cancelling a pending request must leave the app undecided.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (security.approvals.pending().length > 0 || events.some(event =>
          event.type === "security-tool-committed" && event.callId === "second")) break;
        await new Promise(resolve => setTimeout(resolve, 5));
        if (decision === "denied" && attempt >= 5) break;
      }
      if (decision === "cancelled") {
        const renewed = security.approvals.pending()[0];
        assert.ok(renewed);
        assert.notEqual(renewed.id, initial.id);
        security.approvals.decide(renewed.id, true);
        await second;
      } else {
        assert.deepEqual(security.approvals.pending(), []);
        if (decision === "approved") await second;
        else await assert.rejects(second, /denied desktop access/);
      }

      const third = start("chat-b", "third", 456);
      third.catch(() => {});
      for (let attempt = 0; attempt < 100 && security.approvals.pending().length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const fresh = security.approvals.pending()[0];
      assert.ok(fresh, "a new conversation must not inherit another conversation's decision");
      assert.equal(fresh.sessionId, "chat-b");
      security.approvals.decide(fresh.id, false);
      await assert.rejects(third, /did not approve/);
      assert.deepEqual(actions, decision === "approved" ? [123, 456] : decision === "cancelled" ? [456] : []);
      assert.equal(events.filter(event => event.type === "security-approval-requested").length,
        decision === "cancelled" ? 3 : 2);
    } finally {
      security.approvals.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
