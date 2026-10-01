import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ApprovalPanel } from "../src/renderer/components/ApprovalPanel.tsx";

test("host command approval preserves multiline command formatting", () => {
  const html = renderToStaticMarkup(createElement(ApprovalPanel, {
    requests: [{
      id: "approval-1",
      sessionId: "session-a",
      callId: "call-a",
      tool: "bash",
      target: "printf first\nprintf second",
    }],
    sessions: [],
    decisionsInFlight: [],
    onDecide: () => {},
  }));
  expect(html).toMatch(/<pre[^>]*whitespace-pre-wrap[^>]*>printf first\nprintf second<\/pre>/);
  expect(html).toContain("Background tasks started by this command may continue after it returns");
  expect(html).toContain("Later host commands require separate approval");
});

test("approval decision error remains visible after the last request disappears", () => {
  const html = renderToStaticMarkup(createElement(ApprovalPanel, {
    requests: [],
    sessions: [],
    decisionsInFlight: [],
    error: "Approval request is no longer pending",
    onDecide: () => {},
  }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Approval request is no longer pending");
});

test("desktop app approval shows the application identity, scope, and captured window preview", () => {
  const target = { scope: "application" as const, action: "click" as const, pid: 123, windowId: "42", appName: "Editor", bundleId: "com.example.editor",
    observationId: "observed", screenshotSha256: "hash", deliveryMode: "background" as const, position: { elementToken: "save" } };
  const html = renderToStaticMarkup(createElement(ApprovalPanel, {
    requests: [{
      id: "approval-desktop",
      sessionId: "session-a",
      callId: "call-a",
      tool: "desktop_click",
      target,
      previewImage: { mimeType: "image/png", dataBase64: "aW1hZ2U=" },
    }],
    sessions: [],
    decisionsInFlight: [],
    onDecide: () => {},
  }));
  expect(html).toContain("desktop click");
  expect(html).toContain("Editor");
  expect(html).toContain("com.example.editor");
  expect(html).toContain("Current window: 42");
  expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  expect(html).toContain("Allow for this chat");
  expect(html).toContain("all windows");
  expect(html).toContain("Desktop tools request background input targeted at a window and never request foreground retries");
  expect(html).toContain("The target application may activate itself");
  expect(html).not.toContain("fails without bringing the app forward");
});

test("desktop scroll approval shows its exact movement and window preview", () => {
  const html = renderToStaticMarkup(createElement(ApprovalPanel, {
    requests: [{
      id: "approval-scroll",
      sessionId: "session-a",
      callId: "call-scroll",
      tool: "desktop_scroll",
      target: { scope: "application", action: "scroll", pid: 123, windowId: "42", appName: "Editor", bundleId: "com.example.editor",
        observationId: "observed", screenshotSha256: "hash", x: 10, y: 20, direction: "down", by: "line", amount: 3 },
      previewImage: { mimeType: "image/png", dataBase64: "aW1hZ2U=" },
    }],
    sessions: [],
    decisionsInFlight: [],
    onDecide: () => {},
  }));
  expect(html).toContain("desktop scroll");
  expect(html).toContain("com.example.editor");
  expect(html).toContain("Current window: 42");
  expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
});

test("desktop text approval does not display the proposed text", () => {
  const html = renderToStaticMarkup(createElement(ApprovalPanel, {
    requests: [{
      id: "approval-type",
      sessionId: "session-a",
      callId: "call-type",
      tool: "desktop_type",
      target: { scope: "application", action: "type", pid: 123, windowId: "42", appName: "Editor", bundleId: "com.example.editor",
        observationId: "observed", screenshotSha256: "hash", elementToken: "body", role: "AXTextField",
        frame: { x: 20, y: 40, w: 400, h: 60 }, textSha256: "text-hash", textLength: 22 },
      previewImage: { mimeType: "image/png", dataBase64: "aW1hZ2U=" },
    }],
    sessions: [],
    decisionsInFlight: [],
    onDecide: () => {},
  }));
  expect(html).toContain("desktop text input");
  expect(html).toContain("com.example.editor");
  expect(html).not.toContain("Complete text to enter");
  expect(html).not.toContain("First line");
  expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
  expect(html).not.toContain("Exact path");
});
