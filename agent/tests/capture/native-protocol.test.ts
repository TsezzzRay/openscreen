import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeHelperCommand,
  parseHelperOutput,
  type NativeHelperConfiguration,
} from "../../src/capture/native/protocol.js";

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

test("parses the low-resolution signature carried by visual activity", () => {
  const output = parseHelperOutput(JSON.stringify({
    type: "signal",
    signal: {
      kind: "visualChanged",
      occurredAt: "2026-07-27T00:00:00.000Z",
      window: {
        processIdentifier: 100,
        applicationName: "Editor",
        windowIdentifier: 7,
      },
      visualSignature: [0, 128, 255],
    },
  }));

  assert.equal(output.type, "signal");
  if (output.type === "signal") {
    assert.deepEqual(output.signal.visualSignature, [0, 128, 255]);
  }
});

test("parses native capture diagnostics without screen content", () => {
  assert.deepEqual(
    parseHelperOutput(JSON.stringify({
      type: "diagnostic",
      event: "visual.stream_stopped",
      reason: "stream_stopped",
      generation: 3,
      windowIdentifier: 7,
      delayMilliseconds: 500,
    })),
    {
      type: "diagnostic",
      event: "visual.stream_stopped",
      reason: "stream_stopped",
      generation: 3,
      windowIdentifier: 7,
      delayMilliseconds: 500,
    },
  );
});

test("parses partial capture results without treating missing artifacts as success", () => {
  const output = parseHelperOutput(JSON.stringify({
    requestId: "capture-1",
    type: "captureResult",
    result: {
      startedAt: "2026-07-27T00:00:00.900Z",
      capturedAt: "2026-07-27T00:00:01.000Z",
      validation: {
        preflightDurationMilliseconds: 2,
        attestationDurationMilliseconds: 1,
      },
      window: {
        processIdentifier: 100,
        applicationName: "Editor",
        windowIdentifier: 7,
      },
      windowGroup: {
        processIdentifier: 100,
        rootWindowIdentifier: 7,
        memberWindowIdentifiers: [3],
        frame: { x: 0, y: 0, width: 1200, height: 800 },
      },
      screenshot: {
        status: "permissionDenied",
        durationMilliseconds: 3,
        completedAt: "2026-07-27T00:00:00.950Z",
        failureReason: "permission_denied",
      },
      accessibility: {
        status: "partial",
        quality: "useful",
        durationMilliseconds: 2000,
        completedAt: "2026-07-27T00:00:00.975Z",
        contentRootFound: true,
        semanticNodeCount: 42,
        usefulTextCharacters: 1_024,
        failureReason: "target_mismatch",
        windowIdentifiers: [7],
        missingWindowIdentifiers: [3],
        activation: {
          status: "enabled",
          attempts: [
            { method: "enhanced_ui", status: "unsupported" },
            { method: "manual_accessibility", status: "enabled" },
          ],
          waitMilliseconds: 150,
          nodeCountBefore: 12,
          nodeCountAfter: 2_000,
        },
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
    assert.equal(
      (output.result as any).startedAt,
      "2026-07-27T00:00:00.900Z",
    );
    assert.equal(
      (output.result.screenshot as any).completedAt,
      "2026-07-27T00:00:00.950Z",
    );
    assert.equal(
      (output.result.accessibility as any).completedAt,
      "2026-07-27T00:00:00.975Z",
    );
    assert.equal(output.result.screenshot.status, "permissionDenied");
    assert.equal(
      output.result.screenshot.failureReason,
      "permission_denied",
    );
    assert.equal(output.result.screenshot.dataBase64, undefined);
    assert.equal(output.result.accessibility.status, "partial");
    assert.equal(output.result.accessibility.quality, "useful");
    assert.equal(output.result.accessibility.contentRootFound, true);
    assert.equal(output.result.accessibility.semanticNodeCount, 42);
    assert.equal(output.result.accessibility.usefulTextCharacters, 1_024);
    assert.equal(
      output.result.accessibility.failureReason,
      "target_mismatch",
    );
    assert.deepEqual(output.result.accessibility.windowIdentifiers, [7]);
    assert.deepEqual(
      output.result.accessibility.missingWindowIdentifiers,
      [3],
    );
    assert.deepEqual(output.result.windowGroup, {
      processIdentifier: 100,
      rootWindowIdentifier: 7,
      memberWindowIdentifiers: [3],
      frame: { x: 0, y: 0, width: 1200, height: 800 },
    });
    assert.equal(output.result.accessibility.snapshot?.truncated, true);
    assert.deepEqual(output.result.accessibility.activation, {
      status: "enabled",
      attempts: [
        { method: "enhanced_ui", status: "unsupported" },
        { method: "manual_accessibility", status: "enabled" },
      ],
      waitMilliseconds: 150,
      nodeCountBefore: 12,
      nodeCountAfter: 2_000,
    });
    assert.equal(output.result.validation.preflightDurationMilliseconds, 2);
    assert.equal(output.result.validation.attestationDurationMilliseconds, 1);
  }
});

test("normalizes empty optional AX strings from real applications", () => {
  const output = parseHelperOutput(JSON.stringify({
    requestId: "capture-1",
    type: "captureResult",
    result: {
      startedAt: "2026-07-27T00:00:00.900Z",
      capturedAt: "2026-07-27T00:00:01.000Z",
      validation: {
        preflightDurationMilliseconds: 2,
        attestationDurationMilliseconds: 1,
      },
      window: {
        processIdentifier: 100,
        applicationName: "Editor",
        windowIdentifier: 7,
        title: "",
      },
      screenshot: {
        status: "permissionDenied",
        durationMilliseconds: 1,
        completedAt: "2026-07-27T00:00:00.950Z",
      },
      accessibility: {
        status: "complete",
        quality: "shell_only",
        durationMilliseconds: 1,
        completedAt: "2026-07-27T00:00:00.975Z",
        contentRootFound: false,
        semanticNodeCount: 0,
        usefulTextCharacters: 0,
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

  const captured = encodeHelperCommand({
    requestId: "capture-1",
    type: "capture",
    target: {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
      frame: { x: 0, y: 0, width: 1_200, height: 800 },
    },
  });
  assert.equal(captured.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(captured), {
    requestId: "capture-1",
    type: "capture",
    target: {
      processIdentifier: 100,
      bundleIdentifier: "com.example.Editor",
      applicationName: "Editor",
      windowIdentifier: 7,
      title: "Document",
      frame: { x: 0, y: 0, width: 1_200, height: 800 },
    },
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
  assert.throws(
    () => parseHelperOutput(JSON.stringify({
      requestId: "capture-1",
      type: "captureResult",
      result: {
        capturedAt: "2026-07-27T00:00:01.000Z",
        window: {
          processIdentifier: 100,
          applicationName: "Editor",
          windowIdentifier: 7,
        },
        screenshot: { status: "failed", durationMilliseconds: 1 },
        accessibility: {
          status: "failed",
          quality: "unavailable",
          durationMilliseconds: 1,
          contentRootFound: false,
          semanticNodeCount: 0,
          usefulTextCharacters: 0,
        },
      },
    })),
    /Invalid helper capture result/,
  );
});
