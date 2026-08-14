import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureConfig } from "../../src/capture/config.js";
import { CapturePlanner } from "../../src/capture/scheduler.js";
import type {
  NativeActivitySignal,
  WindowMetadata,
} from "../../src/capture/native/protocol.js";

const scheduling = {
  tickIntervalMilliseconds: 100,
  ordinaryCaptureGapMilliseconds: 2_000,
  eventDeduplicationWindowMilliseconds: 1_000,
  sameWindowCaptureGapMilliseconds: 5_000,
  visualOnlyCaptureGapMilliseconds: 15_000,
  delaysMilliseconds: {
    mouseClick: 400,
    focusedElementChanged: 500,
    keyActivity: 1_500,
    accessibilityChanged: 3_000,
    visualChanged: 750,
  },
  capsMilliseconds: {
    keyActivity: 30_000,
    visualChanged: 10_000,
  },
} satisfies CaptureConfig["scheduling"];

const windowA: WindowMetadata = {
  processIdentifier: 101,
  bundleIdentifier: "com.example.Editor",
  applicationName: "Editor",
  windowIdentifier: 7,
  title: "Document",
  frame: { x: 0, y: 0, width: 1200, height: 800 },
};

function signal(
  kind: NativeActivitySignal["kind"],
  occurredAtMilliseconds: number,
): NativeActivitySignal {
  return {
    kind,
    occurredAt: new Date(occurredAtMilliseconds).toISOString(),
    window: windowA,
  };
}

test("a window boundary supersedes delayed activity and is immediately due", () => {
  const planner = new CapturePlanner(scheduling);
  planner.push(signal("mouseClick", 0), 0);
  planner.push(signal("focusedWindowChanged", 100), 100);

  assert.deepEqual(
    planner.takeDue(100).map((capture) => capture.signal.kind),
    ["focusedWindowChanged"],
  );
  assert.deepEqual(planner.takeDue(1_000), []);
});

test("activity after a boundary can schedule inside the superseded deduplication window", () => {
  const planner = new CapturePlanner(scheduling);
  planner.push(signal("mouseClick", 0), 0);
  planner.push(signal("focusedWindowChanged", 100), 100);
  planner.takeDue(100);

  const next = planner.push(signal("mouseClick", 200), 200);

  assert.equal(next.decision, "scheduled");
  assert.deepEqual(
    planner.takeDue(600).map((capture) => capture.signal.kind),
    ["mouseClick"],
  );
});

test("deduplicates the same event and window for one second", () => {
  const planner = new CapturePlanner(scheduling);
  const scheduled = planner.push(signal("mouseClick", 0), 0);
  const deduplicated = planner.push(signal("mouseClick", 300), 300);

  assert.equal(scheduled.decision, "scheduled");
  assert.equal(deduplicated.decision, "deduplicated");

  assert.deepEqual(
    planner.takeDue(400).map((capture) => capture.signal.kind),
    ["mouseClick"],
  );
});

test("keyboard activity uses a trailing delay with a thirty second cap", () => {
  const planner = new CapturePlanner(scheduling);
  planner.push(signal("keyActivity", 0), 0);
  planner.push(signal("keyActivity", 1_000), 1_000);

  assert.deepEqual(planner.takeDue(2_499), []);
  assert.deepEqual(
    planner.takeDue(2_500).map((capture) => capture.signal.kind),
    ["keyActivity"],
  );

  const continuous = new CapturePlanner(scheduling);
  for (let now = 0; now < 30_000; now += 1_000) {
    continuous.push(signal("keyActivity", now), now);
  }
  assert.deepEqual(continuous.takeDue(29_999), []);
  assert.deepEqual(
    continuous.takeDue(30_000).map((capture) => capture.signal.kind),
    ["keyActivity"],
  );
});

test("continuous visual changes settle normally but are capped at ten seconds", () => {
  const planner = new CapturePlanner(scheduling);
  for (let now = 0; now <= 10_000; now += 500) {
    planner.push(signal("visualChanged", now), now);
  }

  assert.deepEqual(planner.takeDue(9_999), []);
  assert.deepEqual(
    planner.takeDue(10_000).map((capture) => capture.signal.kind),
    ["visualChanged"],
  );
});

test("uses capture delays and caps supplied by startup configuration", () => {
  const planner = new CapturePlanner({
    ...scheduling,
    eventDeduplicationWindowMilliseconds: 0,
    delaysMilliseconds: {
      ...scheduling.delaysMilliseconds,
      keyActivity: 10,
    },
    capsMilliseconds: {
      ...scheduling.capsMilliseconds,
      keyActivity: 20,
    },
  });

  planner.push(signal("keyActivity", 0), 0);
  planner.push(signal("keyActivity", 15), 15);
  assert.deepEqual(planner.takeDue(19), []);
  assert.deepEqual(
    planner.takeDue(20).map((capture) => capture.signal.kind),
    ["keyActivity"],
  );
});

test("preserves activity revision and content epoch when a planned capture becomes due", () => {
  const planner = new CapturePlanner(scheduling);
  planner.push(signal("mouseClick", 0), 0, 42, 7);
  const capture = planner.takeDue(400)[0];

  assert.equal(capture?.activityRevision, 42);
  assert.equal(capture?.contentEpoch, 7);
});
