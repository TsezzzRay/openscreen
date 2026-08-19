import assert from "node:assert/strict";
import test from "node:test";

import { parseChronicleSummary } from "../../../src/memory/chronicle/summary-schema.js";

interface Overrides {
  summary?: unknown;
  sourceFrameIds?: unknown;
  application?: unknown;
  windowTitle?: unknown;
  sourceSummary?: unknown;
}

// Uses key presence rather than `??` so an explicitly-passed null (a realistic
// model output for a required field) reaches validation instead of silently
// falling back to the default.
function pick(overrides: Overrides, key: keyof Overrides, fallback: unknown): unknown {
  return key in overrides ? overrides[key] : fallback;
}

function output(overrides: Overrides = {}) {
  return {
    activities: [{
      summary: pick(overrides, "summary", "Viewed a terminal."),
      source_frame_ids: pick(overrides, "sourceFrameIds", ["frame:1"]),
      application: pick(overrides, "application", null),
      window_title: pick(overrides, "windowTitle", null),
    }],
    source_summary: pick(overrides, "sourceSummary", "One frame observed."),
  };
}

const expected = new Set(["frame:1"]);

test("accepts a long activity summary unchanged — length is bounded by maxOutputTokens, not here", () => {
  const long = "字".repeat(5_000);
  const result = parseChronicleSummary(output({ summary: long }), expected);
  assert.equal(result.activities[0]!.summary, long);
  assert.doesNotMatch(result.activities[0]!.summary, /…$/, "must not be truncated");
});

test("accepts a long source_summary, application, and window_title unchanged", () => {
  const result = parseChronicleSummary(
    output({
      sourceSummary: "s".repeat(9_000),
      application: "a".repeat(900),
      windowTitle: "w".repeat(1_500),
    }),
    expected,
  );
  assert.equal(Array.from(result.sourceSummary).length, 9_000);
  assert.equal(Array.from(result.activities[0]!.application!).length, 900);
  assert.equal(Array.from(result.activities[0]!.windowTitle!).length, 1_500);
});

test("trims surrounding whitespace but preserves interior content", () => {
  const result = parseChronicleSummary(
    output({ summary: "  Ran `npm ci`, then git commit.  " }),
    expected,
  );
  assert.equal(result.activities[0]!.summary, "Ran `npm ci`, then git commit.");
});

test("still rejects a missing, empty, or non-string activity summary", () => {
  for (const summary of [null, "", "   ", 42]) {
    assert.throws(
      () => parseChronicleSummary(output({ summary }), expected),
      /Invalid Chronicle activity summary/,
    );
  }
});

test("still rejects an absurdly long source frame ID — identifiers stay bounded and exact", () => {
  // A shortened ID could collide with a different real frame, so identifiers are
  // never truncated; a length far beyond any real ID signals a malformed response.
  assert.throws(
    () => parseChronicleSummary(
      output({ sourceFrameIds: ["f".repeat(1_200)] }),
      new Set(["f".repeat(1_200)]),
    ),
    /Invalid Chronicle activity source_frame_id/,
  );
});

test("semantic validation stays strict regardless of summary length", () => {
  const long = "字".repeat(5_000);
  assert.throws(
    () => parseChronicleSummary(output({ summary: long, sourceFrameIds: ["invented"] }), expected),
    /Chronicle returned source invented/,
  );
  assert.throws(
    () => parseChronicleSummary(
      output({ summary: long, sourceFrameIds: ["frame:1"] }),
      new Set(["frame:1", "frame:2"]),
    ),
    /missing source frame:2/,
  );
  assert.throws(
    () => parseChronicleSummary(
      { activities: [], source_summary: "none" },
      expected,
    ),
    /Invalid Chronicle activities/,
  );
});

test("schema still advertises maxLength as guidance to the model", async () => {
  const { CHRONICLE_SUMMARY_SCHEMA } = await import(
    "../../../src/memory/chronicle/summary-schema.js"
  );
  // Intentional: the model is told to aim short, but overrunning is not punished
  // locally. Keeping these in sync with the doc comment guards against someone
  // "fixing" the apparent inconsistency by re-adding local enforcement.
  assert.equal(CHRONICLE_SUMMARY_SCHEMA.properties.activities.items.properties.summary.maxLength, 2_000);
  assert.equal(CHRONICLE_SUMMARY_SCHEMA.properties.source_summary.maxLength, 4_000);
});
