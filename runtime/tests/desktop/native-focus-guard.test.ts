import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

test("native focus guard exchanges correlated arm and check responses", async () => {
  const modulePath = "../../src/desktop/native-focus-guard.js";
  const { createNativeDesktopFocusGuard } = await import(modulePath);
  const guard = await createNativeDesktopFocusGuard({
    helperPath: resolve("runtime/tests/desktop/fake-focus-helper.mjs"),
    pid: 123,
    windowId: 42n,
    windowTitle: "Draft",
    screenshotWidth: 640,
    element: { elementIndex: 1n, role: "AXTextField", depth: 1, label: "Body", elementToken: "body", frame: { x: 20, y: 40, w: 400, h: 60 } },
  });
  try {
    const focus = Reflect.get(guard, "focus");
    assert.equal(typeof focus, "function");
    assert.equal(await focus(), true);
    const verifyTarget = Reflect.get(guard, "verifyTarget");
    assert.equal(typeof verifyTarget, "function");
    await verifyTarget();
    assert.deepEqual(await guard.arm(), { value: "", selectionStart: 0, selectionLength: 0 });
    assert.deepEqual(await guard.check(), { value: "ship now", selectionStart: 8, selectionLength: 0 });
  } finally {
    await guard.close();
  }
});
