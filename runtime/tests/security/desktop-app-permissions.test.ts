import assert from "node:assert/strict";
import test from "node:test";

import { DesktopAppPermissions } from "../../src/security/desktop-app-permissions.js";

test("an app grant follows its bundle ID across windows and processes in one session only", () => {
  const permissions = new DesktopAppPermissions();
  const editor = { pid: 123, bundleId: "com.example.editor", appName: "Editor" };
  assert.equal(permissions.state("chat-a", editor), "unknown");
  permissions.decide("chat-a", editor, true, "approval-1");
  assert.equal(permissions.state("chat-a", { ...editor, pid: 456 }), "allowed");
  assert.equal(permissions.approvalId("chat-a", { ...editor, pid: 456 }), "approval-1");
  assert.equal(permissions.state("chat-b", editor), "unknown");
  assert.equal(permissions.state("chat-a", { pid: 123, bundleId: "com.example.browser", appName: "Browser" }), "unknown");
});

test("an explicit app denial remains denied until that session ends", () => {
  const permissions = new DesktopAppPermissions();
  const editor = { pid: 123, bundleId: "com.example.editor", appName: "Editor" };
  permissions.decide("chat-a", editor, false);
  permissions.decide("chat-a", editor, true);
  assert.equal(permissions.state("chat-a", editor), "denied");
  assert.equal(permissions.state("chat-a", { ...editor, pid: 456 }), "denied");
  permissions.clearSession("chat-a");
  assert.equal(permissions.state("chat-a", editor), "unknown");
});

test("an app without a bundle ID does not inherit another process's permission by display name", () => {
  const permissions = new DesktopAppPermissions();
  const app = { pid: 123, appName: "Terminal" };
  permissions.decide("chat-a", app, true);
  assert.equal(permissions.state("chat-a", app), "allowed");
  assert.equal(permissions.state("chat-a", { ...app, pid: 456 }), "unknown");
});
