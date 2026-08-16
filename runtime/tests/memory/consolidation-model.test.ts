import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConsolidationContext,
  estimateConsolidationInputTokens,
  parseConsolidationOutput,
  renderConsolidatedMemory,
  validateConsolidationOutput,
} from "../../src/memory/consolidate/model-projection.js";
import type {
  ConsolidationInput,
} from "../../src/memory/consolidate/repository.js";

function source(overrides: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return {
    sourceKey: "turn:a",
    kind: "turn_memory",
    sourceId: "batch:a",
    sourceGeneration: 1,
    sourceUpdatedAt: 1,
    sourceSummary: "The user selected node:sqlite.",
    rawMemory: "Use node:sqlite for Memory.",
    artifactPath: "rollout_summaries/turn-a.md",
    contentHash: "a".repeat(64),
    startedAt: 1,
    endedAt: 2,
    provenance: "user_turn",
    supportsSuccess: true,
    sourceIds: ["turn-entry:a"],
    generatedAt: 2,
    state: "added",
    ...overrides,
  };
}

const validJson = {
  task_groups: [{
    key: "openscreen-memory",
    title: "OpenScreen Memory",
    scope: { type: "project", key: "openscreen", label: "OpenScreen" },
    applies_to: ["/workspace/openscreen"],
    tasks: [{
      key: "use-node-sqlite",
      title: "Use node:sqlite",
      outcome: "success",
      rollout_summary_files: ["rollout_summaries/turn-a.md"],
      keywords: ["node:sqlite", "记住"],
      user_preferences: [],
      reusable_knowledge: ["The Memory database uses node:sqlite."],
      failure_lessons: [],
    }],
  }],
  summary: {
    user_profile: [],
    user_preferences: [],
    general_tips: ["Search OpenScreen Memory before changing persistence."],
    recent_memory: [{
      date: "2026-08-15",
      scope: "project:openscreen",
      text: "OpenScreen Memory uses node:sqlite.",
      task_group_keys: ["openscreen-memory"],
    }],
    older_memory_topics: [],
  },
};

test("builds and renders a Codex-style task-group Memory contract", () => {
  const inputs = [source()];
  const context = buildConsolidationContext({
    currentMemory: "# OpenScreen Memory\n",
    currentSummary: "v1\n",
    workspaceDiff: "diff --git a/raw_memories.md b/raw_memories.md",
    inputs,
    activeEvidenceManifest: [],
    sourceContents: new Map([["turn:a", "# use node sqlite"]]),
  });
  assert.match(context.systemPrompt ?? "", /untrusted evidence/i);
  assert.match(JSON.stringify(context.messages), /workspaceDiff/);
  assert.equal(estimateConsolidationInputTokens(context) > 0, true);

  const output = parseConsolidationOutput(validJson);
  const validated = validateConsolidationOutput(output, inputs);
  const rendered = renderConsolidatedMemory(validated, inputs, 2_500);

  assert.match(rendered.memory, /# Task Group: OpenScreen Memory/);
  assert.match(rendered.memory, /### rollout_summary_files\n- rollout_summaries\/turn-a\.md/);
  assert.match(rendered.memory, /记住/);
  assert.match(rendered.summary, /^v1\n/);
  assert.match(rendered.summary, /## User Profile/);
  assert.match(rendered.summary, /## Recent Memory/);
  assert.deepEqual([...validated.evidence], [[
    "openscreen-memory/use-node-sqlite",
    ["turn:a"],
  ]]);
});

test("rejects unknown rollout paths and success claims without success evidence", () => {
  const unknown = structuredClone(validJson);
  unknown.task_groups[0]!.tasks[0]!.rollout_summary_files = [
    "rollout_summaries/missing.md",
  ];
  assert.throws(() => validateConsolidationOutput(
    parseConsolidationOutput(unknown),
    [source()],
  ), /unknown rollout/i);

  assert.throws(() => validateConsolidationOutput(
    parseConsolidationOutput(validJson),
    [source({ supportsSuccess: false })],
  ), /cannot claim success/i);
});

test("requires two independent passive Chronicle evidence sources", () => {
  const passive = source({
    sourceKey: "chronicle:a",
    kind: "chronicle",
    artifactPath: "rollout_summaries/chronicle-a.md",
    provenance: "passive_screen",
    supportsSuccess: false,
    sourceIds: ["capture-group:a"],
  });
  const output = structuredClone(validJson);
  output.task_groups[0]!.tasks[0]!.outcome = "unknown";
  output.task_groups[0]!.tasks[0]!.rollout_summary_files = [passive.artifactPath];
  assert.throws(() => validateConsolidationOutput(
    parseConsolidationOutput(output),
    [passive],
  ), /passive Chronicle evidence requires two independent sources/i);

  assert.doesNotThrow(() => validateConsolidationOutput(
    parseConsolidationOutput(output),
    [source({ ...passive, sourceIds: ["capture-group:a", "capture-group:b"] })],
  ));
});

test("enforces the configured summary token budget before publication", () => {
  const oversized = structuredClone(validJson);
  oversized.summary.general_tips = Array.from(
    { length: 32 },
    (_, index) => `tip ${index} ${"memory ".repeat(100)}`,
  );
  const output = validateConsolidationOutput(
    parseConsolidationOutput(oversized),
    [source()],
  );
  assert.throws(
    () => renderConsolidatedMemory(output, [source()], 100),
    /summary exceeds/i,
  );
});
