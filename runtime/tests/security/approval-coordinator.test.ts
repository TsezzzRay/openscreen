import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalCoordinator } from "../../src/security/approval-coordinator.js";

test("approval is one-use and bound to a pending request", async () => {
  const coordinator = new ApprovalCoordinator();
  const pending = coordinator.request({ sessionId: "session-a", callId: "call-a", tool: "bash", target: "echo ok" });
  assert.deepEqual(coordinator.pending().map(item => item.target), ["echo ok"]);
  assert.equal(coordinator.decide(pending.id, true), true);
  assert.equal(await pending.result, true);
  assert.equal(coordinator.decide(pending.id, true), false);
  assert.deepEqual(coordinator.pending(), []);
});

test("cancellation invalidates a pending approval", async () => {
  const coordinator = new ApprovalCoordinator();
  const controller = new AbortController();
  const pending = coordinator.request({ sessionId: "session-a", callId: "call-a", tool: "edit", target: "/tmp/a", signal: controller.signal });
  controller.abort();
  assert.equal(await pending.result, false);
  assert.equal(coordinator.decide(pending.id, true), false);
});

test("explicit denial is distinguishable from cancellation", async () => {
  const coordinator = new ApprovalCoordinator();
  const denied = coordinator.request({ sessionId: "session-a", callId: "call-a", tool: "desktop_click", target: "Editor" });
  const controller = new AbortController();
  const cancelled = coordinator.request({ sessionId: "session-a", callId: "call-b", tool: "desktop_click", target: "Browser", signal: controller.signal });
  assert.equal(coordinator.decide(denied.id, false), true);
  controller.abort();
  assert.deepEqual(await denied.decision, { approved: false, reason: "denied" });
  assert.deepEqual(await cancelled.decision, { approved: false, reason: "cancelled" });
});

test("shutdown invalidates all requests", async () => {
  const coordinator = new ApprovalCoordinator();
  const first = coordinator.request({ sessionId: "a", callId: "1", tool: "bash", target: "date" });
  const second = coordinator.request({ sessionId: "b", callId: "2", tool: "write", target: "/tmp/b" });
  coordinator.close();
  assert.deepEqual(await Promise.all([first.result, second.result]), [false, false]);
  assert.equal(coordinator.decide(first.id, true), false);
  assert.throws(() => coordinator.request({ sessionId: "c", callId: "3", tool: "bash", target: "pwd" }));
});

test("desktop click approval preserves its exact action and temporary screenshot preview", async () => {
  const coordinator = new ApprovalCoordinator();
  const target = JSON.stringify({ action: "click", pid: 123, windowId: "42", x: 10, y: 20 });
  const previewImage = { mimeType: "image/png" as const, dataBase64: "aW1hZ2U=" };
  const pending = coordinator.request({ sessionId: "a", callId: "call-1", tool: "desktop_click", target, previewImage });
  assert.deepEqual(coordinator.pending()[0], {
    id: pending.id,
    sessionId: "a",
    callId: "call-1",
    tool: "desktop_click",
    target,
    previewImage,
  });
  coordinator.decide(pending.id, false);
  assert.equal(await pending.result, false);
});
