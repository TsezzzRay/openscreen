import assert from "node:assert/strict";
import test from "node:test";

import { parseMemorySourceSnapshot } from "../../src/harness/memory/shared/memory-source.js";

const hash = "a".repeat(64);

test("validates the generic source snapshot passed to consolidation", () => {
  assert.deepEqual(parseMemorySourceSnapshot({
    id: "chronicle:2026-08-06T10:00Z",
    kind: "chronicle",
    artifactPath: "rollout_summaries/chronicle-1000.md",
    contentHash: hash,
    startedAt: 1_000,
    endedAt: 2_000,
    provenance: "passive_screen",
    sourceIds: ["observation:1", "observation:2"],
    state: "added",
  }), {
    id: "chronicle:2026-08-06T10:00Z",
    kind: "chronicle",
    artifactPath: "rollout_summaries/chronicle-1000.md",
    contentHash: hash,
    startedAt: 1_000,
    endedAt: 2_000,
    provenance: "passive_screen",
    sourceIds: ["observation:1", "observation:2"],
    state: "added",
  });
});

test("rejects invalid source boundaries, paths, provenance, and duplicate evidence", () => {
  const base = {
    id: "turn-memory:1",
    kind: "turn_memory",
    artifactPath: "rollout_summaries/turn-1.md",
    contentHash: hash,
    startedAt: 1_000,
    endedAt: 2_000,
    provenance: "user_turn",
    sourceIds: ["turn:1"],
    state: "retained",
  };

  assert.throws(
    () => parseMemorySourceSnapshot({ ...base, endedAt: 999 }),
    /time bounds/i,
  );
  assert.throws(
    () => parseMemorySourceSnapshot({ ...base, artifactPath: "../MEMORY.md" }),
    /artifact path/i,
  );
  assert.throws(
    () => parseMemorySourceSnapshot({ ...base, provenance: "assistant" }),
    /provenance/i,
  );
  assert.throws(
    () => parseMemorySourceSnapshot({ ...base, sourceIds: ["turn:1", "turn:1"] }),
    /source ids/i,
  );
});
