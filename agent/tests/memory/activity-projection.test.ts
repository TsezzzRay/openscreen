import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActivityOutput,
  projectObservation,
  projectTurnBatch,
} from "../../src/harness/memory/activity/projection.js";
import type { ScreenObservation } from "../../src/plugins/screen-observation/types.js";

const observation: ScreenObservation = {
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
    title: "OpenScreen design",
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
      nodeCount: 2,
      truncated: false,
      root: {
        role: "AXWindow",
        title: "OpenScreen design",
        children: [{ role: "AXStaticText", value: "raw AX child" }],
      },
    },
  },
  focusedElement: {
    role: "AXTextField",
    title: "Search",
    value: "Codex Memory",
    identifier: "search-field",
    frame: { x: 1, y: 2, width: 3, height: 4 },
    focused: true,
  },
  visibleText: "Memory pipeline notes",
  url: "https://example.com/design",
  diagnostics: {
    triggerToCaptureMilliseconds: 150,
    screenshotDurationMilliseconds: 20,
    accessibilityDurationMilliseconds: 15,
  },
};

test("projects only useful Observation fields for Activity", () => {
  const projection = projectObservation(observation);

  assert.deepEqual(projection, {
    type: "observation",
    sourceId: "observation:observation-1",
    occurredAt: "2026-08-04T10:00:01.000Z",
    capturedAt: "2026-08-04T10:00:01.150Z",
    application: {
      name: "Safari",
      bundleIdentifier: "com.apple.Safari",
    },
    windowTitle: "OpenScreen design",
    url: "https://example.com/design",
    focusedElement: {
      role: "AXTextField",
      title: "Search",
      value: "Codex Memory",
      identifier: "search-field",
      focused: true,
    },
    visibleText: "Memory pipeline notes",
  });

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

test("projects terminal Turns without reasoning, protocol fields, or full tool output", () => {
  const projection = projectTurnBatch("session-1", [{
    sourceId: "turn:session-1:turn-1",
    occurredAt: "2026-08-04T11:02:00.000Z",
    turn: {
      id: "turn-1",
      user: "Run the memory tests",
      assistant: "The focused tests pass.",
      reasoning: "private chain of thought",
      status: "completed",
      startedAt: "2026-08-04T11:00:00.000Z",
      finishedAt: "2026-08-04T11:02:00.000Z",
      images: [{ id: "image-1", source: "user_upload", path: "/private/image.png" }],
      outputItems: [{
        type: "reasoning",
        id: "reasoning-1",
        summary: [],
      }],
    },
    agentRuns: [{
      id: "run-1",
      turnId: "turn-1",
      status: "completed",
      startedAt: "2026-08-04T11:00:01.000Z",
      finishedAt: "2026-08-04T11:01:59.000Z",
      steps: [{
        step: 1,
        responseId: "response-secret",
        totalTokens: 1234,
        outputItems: [],
        toolResults: [{
          callId: "call-secret",
          name: "run_tests",
          status: "completed",
          output: `npm test\n112 tests passed\n${"irrelevant output ".repeat(300)}`,
        }],
      }],
    }],
  }]);

  assert.equal(projection.type, "turn_batch");
  assert.equal(projection.sessionId, "session-1");
  assert.equal(projection.turns[0]?.status, "completed");
  assert.equal(projection.turns[0]?.agentRuns[0]?.tools[0]?.name, "run_tests");
  assert.match(
    projection.turns[0]?.agentRuns[0]?.tools[0]?.result ?? "",
    /112 tests passed/,
  );
  assert.ok(
    (projection.turns[0]?.agentRuns[0]?.tools[0]?.result.length ?? 0) <= 2_000,
  );

  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    "private chain of thought",
    "/private/image.png",
    "response-secret",
    "call-secret",
    "totalTokens",
    "outputItems",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("does not split a Unicode surrogate pair when compacting tool output", () => {
  const projection = projectTurnBatch("session-1", [{
    sourceId: "turn:session-1:turn-1",
    occurredAt: "2026-08-04T11:02:00.000Z",
    turn: {
      id: "turn-1",
      user: "Inspect Unicode output",
      assistant: "Done",
      status: "completed",
      startedAt: "2026-08-04T11:00:00.000Z",
      finishedAt: "2026-08-04T11:02:00.000Z",
    },
    agentRuns: [{
      id: "run-1",
      turnId: "turn-1",
      status: "completed",
      startedAt: "2026-08-04T11:00:01.000Z",
      steps: [{
        step: 1,
        outputItems: [],
        toolResults: [{
          callId: "call-1",
          name: "unicode_output",
          status: "completed",
          output: `${"a".repeat(1_399)}😀${"b".repeat(1_000)}`,
        }],
      }],
    }],
  }]);
  const result = projection.turns[0]?.agentRuns[0]?.tools[0]?.result ?? "";

  assert.ok(result.length <= 2_000);
  assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  assert.doesNotMatch(result, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test("rejects Agent Runs that belong to another Turn", () => {
  assert.throws(() => projectTurnBatch("session-1", [{
    sourceId: "turn:session-1:turn-1",
    occurredAt: "2026-08-04T11:02:00.000Z",
    turn: {
      id: "turn-1",
      user: "Run tests",
      assistant: "",
      status: "failed",
      startedAt: "2026-08-04T11:00:00.000Z",
      finishedAt: "2026-08-04T11:02:00.000Z",
    },
    agentRuns: [{
      id: "run-1",
      turnId: "another-turn",
      status: "failed",
      startedAt: "2026-08-04T11:00:01.000Z",
      steps: [],
    }],
  }]), /must reference the projected Turn/);
});

test("accepts a complete Activity output and normalizes optional raw memory", () => {
  const parsed = parseActivityOutput(JSON.stringify({
    activities: [{
      summary: "The user reviewed the OpenScreen memory design in Safari.",
      source_ids: ["observation:observation-1"],
      application: "Safari",
      window_title: "OpenScreen design",
      entities: ["OpenScreen"],
      verbatim_evidence: ["Memory pipeline notes"],
      scope_hints: [{ type: "application", key: "com.apple.Safari", label: "Safari" }],
    }],
    source_summary: "A Safari observation about the OpenScreen memory pipeline.",
    raw_memory: "",
    scope_hints: [{ type: "topic", key: "openscreen-memory", label: "OpenScreen Memory" }],
  }), new Set(["observation:observation-1"]));

  assert.equal(parsed.rawMemory, null);
  assert.deepEqual(parsed.activities[0]?.sourceIds, ["observation:observation-1"]);
  assert.equal(parsed.activities[0]?.windowTitle, "OpenScreen design");
  assert.equal(parsed.scopeHints[0]?.type, "topic");
});

test("Activity output must cover every source exactly once and cannot invent sources", () => {
  const base = {
    source_summary: "summary",
    raw_memory: null,
    scope_hints: [],
  };
  const activity = {
    summary: "summary",
    application: null,
    window_title: null,
    entities: [],
    verbatim_evidence: [],
    scope_hints: [],
  };

  assert.throws(() => parseActivityOutput(JSON.stringify({
    ...base,
    activities: [{ ...activity, source_ids: ["source-1"] }],
  }), new Set(["source-1", "source-2"])), /missing source source-2/);

  assert.throws(() => parseActivityOutput(JSON.stringify({
    ...base,
    activities: [
      { ...activity, source_ids: ["source-1"] },
      { ...activity, source_ids: ["source-1"] },
    ],
  }), new Set(["source-1"])), /more than once/);

  assert.throws(() => parseActivityOutput(JSON.stringify({
    ...base,
    activities: [{ ...activity, source_ids: ["unknown"] }],
  }), new Set(["source-1"])), /unknown source unknown/);
});

test("Activity output only accepts supported logical memory scopes", () => {
  assert.throws(() => parseActivityOutput(JSON.stringify({
    activities: [{
      summary: "summary",
      source_ids: ["source-1"],
      entities: [],
      verbatim_evidence: [],
      scope_hints: [],
    }],
    source_summary: "summary",
    raw_memory: null,
    scope_hints: [{ type: "cwd", key: "/repo", label: "repo" }],
  }), new Set(["source-1"])), /unsupported memory scope/);
});
