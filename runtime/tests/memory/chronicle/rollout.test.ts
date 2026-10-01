import assert from "node:assert/strict";
import test from "node:test";

import { chronicleObservationText } from "../../../src/memory/chronicle/rollout.js";
import type { ChronicleFrameProjection, ChronicleSummary } from "../../../src/memory/chronicle/types.js";

test("renders source-attributed screen observations with frame times", () => {
  const summary: ChronicleSummary = {
    sourceSummary: "Observed the user editing code and browsing docs.",
    activities: [
      { summary: "Editing runtime/src/memory.", sourceFrameIds: ["a"], application: "Code", windowTitle: "memory.ts" },
      { summary: "Reading Mastra docs.", sourceFrameIds: ["b"] },
    ],
  };
  const frames = [
    { sourceId: "a", capturedAt: "2026-09-01T09:00:00.000Z", application: "Code", windowTitle: "memory.ts" },
    { sourceId: "b", capturedAt: "2026-09-01T09:00:01.000Z", application: "Browser" },
  ] as ChronicleFrameProjection[];
  const text = chronicleObservationText(summary, frames);
  assert.match(text, /SCREEN CAPTURE.*not a statement, choice, or approval by the user/);
  assert.match(text, /captured_at: 2026-09-01T09:00:00.000Z.*frames: a/);
  assert.match(text, /captured_at: 2026-09-01T09:00:01.000Z.*frames: b/);
  assert.match(text, /Displayed: Editing runtime\/src\/memory\./);
  assert.match(text, /app: Code/);
});
