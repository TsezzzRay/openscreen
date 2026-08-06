import assert from "node:assert/strict";
import test from "node:test";

import { projectTurnMemoryBatch } from "../../src/harness/memory/turn-memory/model-projection.js";
import type { TurnMemorySource } from "../../src/harness/memory/turn-memory/types.js";

function source(): TurnMemorySource {
  return {
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
      outputItems: [],
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
          output: `npm test\n169 tests passed\n${"irrelevant output ".repeat(300)}`,
        }],
      }],
    }],
  };
}

test("projects terminal Turns without reasoning, images, or protocol fields", () => {
  const projection = projectTurnMemoryBatch("session-1", [source()]);
  const result = projection.turns[0]?.agentRuns[0]?.tools[0]?.result ?? "";

  assert.equal(projection.type, "turn_memory_batch");
  assert.equal(projection.turns[0]?.status, "completed");
  assert.equal(Array.from(result).length, 2_000);
  assert.match(result, /169 tests passed/);
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

test("rejects Agent Runs attached to another Turn", () => {
  const invalid = source();
  invalid.agentRuns[0]!.turnId = "turn-2";
  assert.throws(
    () => projectTurnMemoryBatch("session-1", [invalid]),
    /must reference the projected Turn/i,
  );
});
