import assert from "node:assert/strict";
import test from "node:test";

import { chronicleObservationText } from "../../../src/memory/chronicle/rollout.js";
import type { ChronicleSummary } from "../../../src/memory/chronicle/types.js";

test("renders a plain-text observation body with no provenance header", () => {
  const summary: ChronicleSummary = {
    sourceSummary: "Observed the user editing code and browsing docs.",
    activities: [
      { summary: "Editing runtime/src/memory.", sourceFrameIds: ["a"], application: "Code", windowTitle: "memory.ts" },
      { summary: "Reading Mastra docs.", sourceFrameIds: ["b"] },
    ],
  };
  const text = chronicleObservationText(summary);
  assert.match(text, /^Observed the user editing code and browsing docs\.$/m);
  assert.match(text, /^Activity 1: Editing runtime\/src\/memory\. \(application: Code\) \(window: memory\.ts\)$/m);
  assert.match(text, /^Activity 2: Reading Mastra docs\.$/m);
  assert.doesNotMatch(text, /sourceFrameIds|source_frame_ids/);
});
