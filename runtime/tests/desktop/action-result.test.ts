import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionDeliveryMode, ActionEffect, ActionRoute } from "@trycua/cua-driver";
import { desktopActionResult } from "../../src/desktop/action-result.js";
import { ToolSecurity } from "../../src/security/tool-security.js";

test("desktop receipt conversion rejects explicitly foreground delivery", () => {
  assert.throws(() => desktopActionResult({
    effect: ActionEffect.Confirmed,
    route: ActionRoute.SyntheticEvents,
    delivery: { mode: ActionDeliveryMode.Foreground },
    summary: "private input must not appear in the error",
  }), /^Error: Desktop driver reported foreground delivery; side effects may have occurred$/);
});

test("desktop receipt conversion preserves action effects and summary precedence", () => {
  for (const [effect, expected] of [
    [ActionEffect.Confirmed, "confirmed"], [ActionEffect.Partial, "partial"],
    [ActionEffect.Unverifiable, "unverifiable"], [ActionEffect.SuspectedNoop, "suspected-noop"],
    [ActionEffect.Refused, "refused"],
  ] as const) {
    assert.deepEqual(desktopActionResult({ effect, route: ActionRoute.Accessibility,
      delivery: { mode: ActionDeliveryMode.Background }, summary: "receipt" }, "fallback"),
    { effect: expected, summary: "receipt" });
  }
  assert.deepEqual(desktopActionResult({ effect: ActionEffect.Confirmed, route: ActionRoute.Accessibility }, "fallback"),
    { effect: "confirmed", summary: "fallback" });
  assert.throws(() => desktopActionResult({ effect: 99 as ActionEffect, route: ActionRoute.Accessibility }), /unknown action effect/);
});

test("desktop receipt conversion rejects global input even when delivery claims background", () => {
  assert.throws(() => desktopActionResult({ effect: ActionEffect.Confirmed,
    route: ActionRoute.GlobalInput, delivery: { mode: ActionDeliveryMode.Background },
    summary: "private input must not appear in the error" }),
  /^Error: Desktop driver reported global input; side effects may have occurred$/);
});

test("a foreground SDK receipt is audited as uncertain rather than committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-delivery-receipt-"));
  const events: string[] = [];
  const security = new ToolSecurity({ cwd: root, dataRoot: root,
    desktopWindowState: async () => ({ pid: 123, windowId: 42n, appName: "Test",
      screenshotFrameValid: true, screenshotWidth: 640, screenshotHeight: 480,
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }] }),
    desktopClick: async () => desktopActionResult({ effect: ActionEffect.Confirmed,
      route: ActionRoute.SyntheticEvents, delivery: { mode: ActionDeliveryMode.Foreground } }),
  });
  try {
    const run = await security.prepare("session", event => {
      events.push(event.type);
      if (event.type === "security-approval-requested") security.approvals.decide(event.request.id, true);
    });
    await run.execute(async () => {
      const observe = security.tools.find(tool => tool.name === "desktop_window_state")!;
      const click = security.tools.find(tool => tool.name === "desktop_click")!;
      const observed = await observe.execute("observe", { pid: 123, windowId: "42" });
      const content = observed.content[0];
      assert.equal(content?.type, "text");
      const { observationId } = JSON.parse(content.text);
      await assert.rejects(click.execute("click", { observationId, deliveryMode: "background",
        position: { kind: "coordinates", x: 20, y: 40 } }), /foreground delivery/);
      assert.equal(events.includes("security-desktop-execution-uncertain"), true);
      assert.equal(events.includes("security-tool-committed"), false);
    });
  } finally {
    security.approvals.close();
    await rm(root, { recursive: true, force: true });
  }
});
