import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeHelperCommand,
  parseHelperOutput,
} from "../../src/screen-observation/helper-protocol.js";

test("parses helper readiness and activity signals", () => {
  assert.deepEqual(
    parseHelperOutput(JSON.stringify({
      protocolVersion: 1,
      type: "ready",
      processIdentifier: 42,
    })),
    {
      protocolVersion: 1,
      type: "ready",
      processIdentifier: 42,
    },
  );

  const output = parseHelperOutput(JSON.stringify({
    protocolVersion: 1,
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
    protocolVersion: 1,
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
    protocolVersion: 1,
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
    protocolVersion: 1,
    requestId: "configure-1",
    type: "configure",
    excludedProcessIdentifiers: [10, 20],
    excludedBundleIdentifiers: ["com.openscreen.app"],
  });
  assert.equal(configured.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(configured), {
    protocolVersion: 1,
    requestId: "configure-1",
    type: "configure",
    excludedProcessIdentifiers: [10, 20],
    excludedBundleIdentifiers: ["com.openscreen.app"],
  });
});

test("rejects unsupported versions and malformed helper messages", () => {
  assert.throws(
    () => parseHelperOutput(JSON.stringify({
      protocolVersion: 2,
      type: "ready",
      processIdentifier: 42,
    })),
    /Unsupported helper protocol version/,
  );
  assert.throws(
    () => parseHelperOutput(JSON.stringify({
      protocolVersion: 1,
      type: "signal",
      signal: { kind: "keyActivity" },
    })),
    /Invalid helper message/,
  );
});
