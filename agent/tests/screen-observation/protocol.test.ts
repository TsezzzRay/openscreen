import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeHelperCommand,
  parseHelperOutput,
  type NativeHelperConfiguration,
} from "../../src/screen-observation/protocol.js";

const configuration = {
  activityMonitoring: {
    coalescingIntervalMilliseconds: 250,
  },
  accessibility: {
    maxDepth: 40,
    maxNodes: 5_000,
    timeoutMilliseconds: 2_000,
    maxTextLength: 8_192,
  },
  screenshot: {
    maxWidth: 1_920,
    jpegQuality: 0.85,
  },
  visualMonitoring: {
    maxWidth: 320,
    sampleIntervalMilliseconds: 500,
    queueDepth: 2,
    changeThreshold: 0.015,
    signatureWidth: 32,
    signatureHeight: 18,
  },
  windowSelection: {
    minimumWidth: 160,
    minimumHeight: 120,
    maximumAspectRatio: 4,
  },
} satisfies NativeHelperConfiguration;

test("parses helper readiness and activity signals", () => {
  assert.deepEqual(
    parseHelperOutput(JSON.stringify({
      type: "ready",
      processIdentifier: 42,
    })),
    {
      type: "ready",
      processIdentifier: 42,
    },
  );

  const output = parseHelperOutput(JSON.stringify({
    type: "signal",
    signal: {
      kind: "focusedWindowChanged",
      occurredAt: "2026-07-27T00:00:00.000Z",
      window: {
        processIdentifier: 100,
        bundleIdentifier: "com.example.Editor",
        applicationName: "Editor",
        windowIdentifier: 7,
        title: "Document",
        frame: { x: 0, y: 0, width: 1200, height: 800 },
      },
    },
  }));

  assert.equal(output.type, "signal");
  if (output.type === "signal") {
    assert.equal(output.signal.kind, "focusedWindowChanged");
    assert.equal(output.signal.window.windowIdentifier, 7);
  }
});

test("parses partial capture results without treating missing artifacts as success", () => {
  const output = parseHelperOutput(JSON.stringify({
    requestId: "capture-1",
    type: "captureResult",
    result: {
      capturedAt: "2026-07-27T00:00:01.000Z",
      window: {
        processIdentifier: 100,
        applicationName: "Editor",
        windowIdentifier: 7,
      },
      screenshot: {
        status: "permissionDenied",
        durationMilliseconds: 3,
      },
      accessibility: {
        status: "timedOut",
        durationMilliseconds: 2000,
        snapshot: {
          nodeCount: 1,
          truncated: true,
          root: { role: "AXWindow", title: "Document" },
        },
      },
      visualSignature: [0, 128, 255],
    },
  }));

  assert.equal(output.type, "captureResult");
  if (output.type === "captureResult") {
    assert.equal(output.result.screenshot.status, "permissionDenied");
    assert.equal(output.result.screenshot.dataBase64, undefined);
    assert.equal(output.result.accessibility.status, "timedOut");
    assert.equal(output.result.accessibility.snapshot?.truncated, true);
  }
});

test("normalizes empty optional AX strings from real applications", () => {
  const output = parseHelperOutput(JSON.stringify({
    requestId: "capture-1",
    type: "captureResult",
    result: {
      capturedAt: "2026-07-27T00:00:01.000Z",
      window: {
        processIdentifier: 100,
        applicationName: "Editor",
        windowIdentifier: 7,
        title: "",
      },
      screenshot: {
        status: "permissionDenied",
        durationMilliseconds: 1,
      },
      accessibility: {
        status: "complete",
        durationMilliseconds: 1,
        snapshot: {
          nodeCount: 1,
          truncated: false,
          root: {
            role: "AXGroup",
            title: "",
            value: "",
            description: "",
          },
        },
      },
    },
  }));

  assert.equal(output.type, "captureResult");
  if (output.type === "captureResult") {
    assert.equal(output.result.window.title, undefined);
    assert.equal(output.result.accessibility.snapshot?.root.title, undefined);
    assert.equal(output.result.accessibility.snapshot?.root.value, undefined);
    assert.equal(output.result.accessibility.snapshot?.root.description, undefined);
  }
});

test("encodes configuration and capture commands as newline-delimited JSON", () => {
  const configured = encodeHelperCommand({
    requestId: "configure-1",
    type: "configure",
    excludedProcessIdentifiers: [10, 20],
    excludedBundleIdentifiers: ["com.openscreen.app"],
    configuration,
  });
  assert.equal(configured.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(configured), {
    requestId: "configure-1",
    type: "configure",
    excludedProcessIdentifiers: [10, 20],
    excludedBundleIdentifiers: ["com.openscreen.app"],
    configuration,
  });
});

test("rejects malformed helper messages", () => {
  assert.throws(
    () => parseHelperOutput(JSON.stringify({
      type: "signal",
      signal: { kind: "keyActivity" },
    })),
    /Invalid helper message/,
  );
  assert.throws(
    () => parseHelperOutput(JSON.stringify({
      type: "status",
      component: "screenCapture",
      status: "ready",
    })),
    /Invalid helper message/,
  );
});
