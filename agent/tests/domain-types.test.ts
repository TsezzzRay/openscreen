import assert from "node:assert/strict";
import test from "node:test";

import type { LongTermMemory } from "../src/harness/memory/types.js";
import type { AgentRun, Turn } from "../src/harness/session/types.js";
import type {
  RetrieveMemoryArguments,
  RetrieveMemoryResult,
} from "../src/tools/retrieve-memory/types.js";

// @ts-expect-error A durable Turn requires identity, timing, and terminal status.
const incompleteTurn: Turn = { user: "Question", assistant: "Answer" };
void incompleteTurn;

// @ts-expect-error An Agent Run must identify its owning Turn.
const detachedRun: AgentRun = {
  id: "run-1",
  status: "completed",
  startedAt: "2026-07-31T00:00:00.000Z",
  finishedAt: "2026-07-31T00:00:01.000Z",
  steps: [],
};
void detachedRun;

const unsupportedMemory: LongTermMemory = {
  id: "memory-without-evidence",
  topic: "Unsupported",
  content: "This memory has no evidence.",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  // @ts-expect-error Long-term memory requires at least one Activity Record.
  evidenceActivityIds: [],
};
void unsupportedMemory;

test("connects the public Turn, Run, memory, and retrieval contracts", () => {
  const turn: Turn = {
    id: "turn-1",
    user: "What changed?",
    assistant: "The boundary changed.",
    status: "completed",
    startedAt: "2026-07-31T00:00:00.000Z",
    finishedAt: "2026-07-31T00:00:01.000Z",
  };
  const run: AgentRun = {
    id: "run-1",
    turnId: turn.id,
    status: "completed",
    startedAt: "2026-07-31T00:00:00.100Z",
    finishedAt: "2026-07-31T00:00:00.900Z",
    steps: [],
  };
  const memory: LongTermMemory = {
    id: "memory-1",
    topic: "Architecture",
    content: "Screen observation is an Agent plugin.",
    createdAt: "2026-07-31T00:00:02.000Z",
    updatedAt: "2026-07-31T00:00:02.000Z",
    evidenceActivityIds: ["activity-1"],
  };
  const argumentsValue: RetrieveMemoryArguments = {
    query: "screen observation boundary",
    limit: 5,
  };
  const result: RetrieveMemoryResult = {
    memories: [{
      memoryId: memory.id,
      topic: memory.topic,
      content: memory.content,
      evidence: [{
        activityId: memory.evidenceActivityIds[0]!,
        occurredAt: "2026-07-31T00:00:00.000Z",
        summary: "The screen observation boundary was decided.",
      }],
    }],
  };

  assert.equal(run.turnId, turn.id);
  assert.equal(argumentsValue.limit, result.memories.length + 4);
});
