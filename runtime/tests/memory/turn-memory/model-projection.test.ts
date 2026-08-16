import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTurnMemoryBatch,
} from "../../../src/memory/turn-memory/model-projection.js";
import type {
  TurnMemorySource,
} from "../../../src/memory/turn-memory/types.js";

function source(overrides: Partial<TurnMemorySource> = {}): TurnMemorySource {
  return {
    sourceId: "turn:session-1:user-1",
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "feature/memory",
    rolloutPath: "/sessions/session-1.jsonl",
    userEntryIds: ["user-1"],
    terminalEntryId: "answer-1",
    startedAt: "2026-08-15T10:00:00.000Z",
    finishedAt: "2026-08-15T10:01:00.000Z",
    occurredAt: "2026-08-15T10:01:00.000Z",
    status: "completed",
    user: "记住这个项目使用 node:sqlite",
    assistant: "Implemented and verified.",
    sourceFrameIds: ["screenpipe-frame-2", "screenpipe-frame-1"],
    compactionSummary: "Earlier context selected SQLite.",
    tools: [{ name: "bash", status: "completed", result: "219 tests passed" }],
    ...overrides,
  };
}

test("projects code-owned provenance and compact terminal Turn evidence", () => {
  const projection = projectTurnMemoryBatch([source()]);

  assert.deepEqual(projection, {
    type: "turn_memory_batch",
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "feature/memory",
    rolloutPath: "/sessions/session-1.jsonl",
    sourceIds: ["turn:session-1:user-1"],
    startedAt: "2026-08-15T10:00:00.000Z",
    finishedAt: "2026-08-15T10:01:00.000Z",
    turns: [{
      sourceId: "turn:session-1:user-1",
      status: "completed",
      startedAt: "2026-08-15T10:00:00.000Z",
      finishedAt: "2026-08-15T10:01:00.000Z",
      user: "记住这个项目使用 node:sqlite",
      assistant: "Implemented and verified.",
      sourceFrameIds: ["screenpipe-frame-2", "screenpipe-frame-1"],
      compactionSummary: "Earlier context selected SQLite.",
      tools: [{ name: "bash", status: "completed", result: "219 tests passed" }],
    }],
  });
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /userEntryIds|terminalEntryId/);
});

test("rejects a batch that mixes code-owned Session provenance", () => {
  assert.throws(
    () => projectTurnMemoryBatch([
      source(),
      source({
        sourceId: "turn:session-2:user-2",
        sessionId: "session-2",
        threadId: "session-2",
      }),
    ]),
    /same Session provenance/i,
  );
});
