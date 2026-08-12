import assert from "node:assert/strict";
import test from "node:test";

import { buildObservation } from "../../src/extensions/screen-observation/observation.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
} from "../../src/extensions/screen-observation/protocol.js";

const signal: NativeActivitySignal = {
  kind: "mouseClick",
  occurredAt: "2026-07-27T00:00:00.000Z",
  window: {
    processIdentifier: 100,
    bundleIdentifier: "com.example.Browser",
    applicationName: "Browser",
    windowIdentifier: 7,
    title: "Example",
  },
};

const result: NativeCaptureResult = {
  capturedAt: "2026-07-27T00:00:01.000Z",
  validation: {
    preflightDurationMilliseconds: 2,
    attestationDurationMilliseconds: 1,
  },
  window: signal.window,
  windowGroup: {
    processIdentifier: 100,
    rootWindowIdentifier: 7,
    memberWindowIdentifiers: [3],
    frame: { x: 0, y: 0, width: 100, height: 80 },
  },
  screenshot: {
    status: "complete",
    durationMilliseconds: 10,
    mimeType: "image/jpeg",
    dataBase64: "aW1hZ2U=",
    width: 100,
    height: 80,
  },
  accessibility: {
    status: "complete",
    durationMilliseconds: 5,
    snapshot: {
      nodeCount: 4,
      truncated: false,
      root: {
        role: "AXWindow",
        title: "Example",
        children: [
          { role: "AXStaticText", value: "Visible body" },
          {
            role: "AXTextField",
            identifier: "address-field",
            value: "https://example.com/page",
            focused: true,
          },
          { role: "AXStaticText", value: "Visible body" },
        ],
      },
    },
  },
  visualSignature: [0, 0, 0, 0],
};

test("builds the domain observation from a native capture", () => {
  const observation = buildObservation(signal, result, {
    id: "observation-1",
    captureId: "capture-1",
    activityRevision: 3,
  });

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.id, "observation-1");
  assert.equal(observation.captureId, "capture-1");
  assert.equal(observation.activityRevision, 3);
  assert.equal(observation.trigger.type, "mouseClick");
  assert.equal(observation.window.windowIdentifier, 7);
  assert.deepEqual(observation.windowGroup, result.windowGroup);
  assert.equal(observation.screenshot.sha256?.length, 64);
  assert.equal(observation.focusedElement?.identifier, "address-field");
  assert.equal(
    observation.visibleText,
    "Example\nVisible body\nhttps://example.com/page",
  );
  assert.equal(observation.url, "https://example.com/page");
});

test("does not promote shell-only AX text into observation semantics", () => {
  const shellOnly: NativeCaptureResult = {
    ...result,
    accessibility: {
      ...result.accessibility,
      quality: "shell_only",
      contentRootFound: false,
      semanticNodeCount: 1,
      usefulTextCharacters: 0,
    },
  };

  const observation = buildObservation(signal, shellOnly, {
    id: "observation-2",
    captureId: "capture-2",
    activityRevision: 4,
  });

  assert.equal(observation.visibleText, "");
  assert.equal(observation.focusedElement, undefined);
  assert.equal(observation.url, undefined);
});
