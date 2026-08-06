import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChronicleSummaryRequest,
  parseChronicleSummary,
} from "../../src/harness/memory/chronicle/summarizer.js";

const input = {
  type: "chronicle_window" as const,
  observations: [{
    type: "screen_observation" as const,
    sourceId: "observation:1",
    occurredAt: "2026-08-04T10:00:01.000Z",
    capturedAt: "2026-08-04T10:00:01.100Z",
    application: { name: "Safari" },
    visibleText: "OpenScreen architecture",
  }],
};

test("builds Chronicle requests with strict activity-only output", () => {
  const request = buildChronicleSummaryRequest("summary-model", input, 2_000);

  assert.equal(request.text?.format?.type, "json_schema");
  assert.equal(request.text?.format?.name, "chronicle_summary");
  assert.equal(request.text?.format?.strict, true);
  assert.match(String(request.instructions), /passive screen activity/i);
  assert.doesNotMatch(String(request.instructions), /raw_memory|memory candidate/i);
});

test("parses Chronicle activities and cannot accept long-term memory fields", () => {
  const summary = parseChronicleSummary(JSON.stringify({
    activities: [{
      summary: "The user viewed the OpenScreen architecture in Safari.",
      source_ids: ["observation:1"],
      application: "Safari",
      window_title: null,
    }],
    source_summary: "The user reviewed OpenScreen architecture material.",
  }), new Set(["observation:1"]));

  assert.equal("rawMemory" in summary, false);
  assert.deepEqual(summary.activities[0]?.sourceIds, ["observation:1"]);
  assert.throws(() => parseChronicleSummary(JSON.stringify({
    activities: [{
      summary: "Viewed a page.",
      source_ids: ["observation:1"],
      application: null,
      window_title: null,
    }],
    source_summary: "Viewed a page.",
    raw_memory: "The user prefers Safari.",
  }), new Set(["observation:1"])), /unexpected field raw_memory/i);
  assert.throws(() => parseChronicleSummary(JSON.stringify({
    activities: [{
      summary: "x".repeat(2_001),
      source_ids: ["observation:1"],
      application: null,
      window_title: null,
    }],
    source_summary: "Viewed a page.",
  }), new Set(["observation:1"])), /too long/i);
});

test("Chronicle output must cover each supplied source exactly once", () => {
  const output = (sourceIds: string[]) => JSON.stringify({
    activities: [{
      summary: "Viewed a page.",
      source_ids: sourceIds,
      application: null,
      window_title: null,
    }],
    source_summary: "Viewed a page.",
  });

  assert.throws(
    () => parseChronicleSummary(output(["observation:2"]), new Set(["observation:1"])),
    /unknown source observation:2/i,
  );
  assert.throws(
    () => parseChronicleSummary(output([]), new Set(["observation:1"])),
    /source_ids|missing source/i,
  );
});
