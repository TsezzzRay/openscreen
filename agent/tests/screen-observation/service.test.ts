import assert from "node:assert/strict";
import test from "node:test";

import { ScreenObservationService } from "../../src/screen-observation/service.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
  ScreenObservation,
} from "../../src/screen-observation/types.js";

const windowA = {
  processIdentifier: 100,
  bundleIdentifier: "com.example.Browser",
  applicationName: "Browser",
  windowIdentifier: 7,
  title: "Example",
};
const windowB = {
  ...windowA,
  processIdentifier: 200,
  windowIdentifier: 9,
  title: "Other",
};

function signal(
  kind: NativeActivitySignal["kind"],
  window = windowA,
  occurredAtMilliseconds = 0,
): NativeActivitySignal {
  return {
    kind,
    occurredAt: new Date(occurredAtMilliseconds).toISOString(),
    window,
  };
}

function result(
  window = windowA,
  title = "Example",
  visualSignature = [0, 0, 0, 0],
): NativeCaptureResult {
  return {
    capturedAt: "2026-07-27T00:00:01.000Z",
    window,
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
          title,
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
    visualSignature,
  };
}

test("builds a normalized observation without persisting it", async () => {
  const observations: ScreenObservation[] = [];
  const service = new ScreenObservationService({
    capture: async () => result(),
    onObservation: (observation) => observations.push(observation),
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.schemaVersion, 1);
  assert.equal(observations[0]?.trigger.type, "mouseClick");
  assert.equal(observations[0]?.window.windowIdentifier, 7);
  assert.equal(observations[0]?.screenshot.sha256?.length, 64);
  assert.equal(observations[0]?.focusedElement?.identifier, "address-field");
  assert.equal(observations[0]?.visibleText, "Example\nVisible body\nhttps://example.com/page");
  assert.equal(observations[0]?.url, "https://example.com/page");
});

test("drops unchanged ordinary observations but retains a real window boundary", async () => {
  const observations: ScreenObservation[] = [];
  const captures = [result(), result(), result(windowB, "Other")];
  const service = new ScreenObservationService({
    capture: async () => captures.shift()!,
    onObservation: (observation) => observations.push(observation),
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 2_100), 2_100);
  await service.tick(2_500);
  service.push(signal("focusedWindowChanged", windowB, 2_600), 2_600);
  await service.tick(2_600);

  assert.deepEqual(
    observations.map((observation) => observation.window.windowIdentifier),
    [7, 9],
  );
});

test("enforces the ordinary two second capture gap without dropping the latest signal", async () => {
  let captureCount = 0;
  const service = new ScreenObservationService({
    capture: async () => {
      captureCount += 1;
      return result(windowA, `Capture ${captureCount}`, [captureCount, 0, 0, 0]);
    },
    onObservation: () => {},
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);
  service.push(signal("mouseClick", windowA, 500), 500);
  await service.tick(900);
  await service.tick(2_399);
  assert.equal(captureCount, 1);

  await service.tick(2_400);
  assert.equal(captureCount, 2);
});

test("discards a capture when the helper returns a different foreground window", async () => {
  const observations: ScreenObservation[] = [];
  const service = new ScreenObservationService({
    capture: async () => result(windowB, "Other"),
    onObservation: (observation) => observations.push(observation),
  });

  service.push(signal("mouseClick"), 0);
  await service.tick(400);

  assert.deepEqual(observations, []);
});
