import assert from "node:assert/strict";
import test from "node:test";

import { projectChronicleObservation } from "../../src/harness/memory/chronicle/model-projection.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";

function observation(): ScreenObservation {
  return {
    schemaVersion: 1,
    id: "observation-1",
    occurredAt: "2026-08-04T10:00:01.000Z",
    capturedAt: "2026-08-04T10:00:01.150Z",
    trigger: { type: "focusedWindowChanged" },
    window: {
      processIdentifier: 42,
      bundleIdentifier: "com.apple.Safari",
      applicationName: "Safari",
      windowIdentifier: 99,
      title: `${"T".repeat(210)}😀tail`,
      frame: { x: 0, y: 0, width: 1440, height: 900 },
    },
    screenshot: {
      status: "complete",
      durationMilliseconds: 20,
      mimeType: "image/jpeg",
      dataBase64: "private-image",
      width: 1440,
      height: 900,
      sha256: "screenshot-hash",
    },
    accessibility: {
      status: "complete",
      durationMilliseconds: 15,
      snapshot: {
        nodeCount: 1,
        truncated: false,
        root: { role: "AXWindow", value: "raw AX child" },
      },
    },
    focusedElement: {
      role: "AXTextField",
      title: "Search",
      value: `${"V".repeat(2_100)}😀tail`,
      focused: true,
    },
    visibleText: `${"A".repeat(4_100)}😀tail`,
    url: "https://example.com/design",
    diagnostics: {
      triggerToCaptureMilliseconds: 150,
      screenshotDurationMilliseconds: 20,
      accessibilityDurationMilliseconds: 15,
    },
  };
}

test("projects bounded semantic Observation fields for Chronicle", () => {
  const projection = projectChronicleObservation(observation());

  assert.equal(projection.type, "screen_observation");
  assert.equal(projection.sourceId, "observation:observation-1");
  assert.equal(Array.from(projection.windowTitle ?? "").length, 200);
  assert.equal(Array.from(projection.focusedElement?.value ?? "").length, 2_000);
  assert.equal(Array.from(projection.visibleText).length, 4_000);
  assert.match(projection.windowTitle ?? "", /tail$/);
  assert.match(projection.focusedElement?.value ?? "", /tail$/);
  assert.match(projection.visibleText, /tail$/);

  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    "private-image",
    "screenshot-hash",
    "raw AX child",
    "processIdentifier",
    "windowIdentifier",
    "diagnostics",
    "durationMilliseconds",
    "frame",
    "trigger",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});
