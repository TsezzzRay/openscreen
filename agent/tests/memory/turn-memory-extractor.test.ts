import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTurnMemoryExtractionRequest,
  parseTurnMemoryExtraction,
} from "../../src/harness/memory/turn-memory/extractor.js";

const input = {
  type: "turn_memory_batch" as const,
  sessionId: "session-1",
  turns: [{
    sourceId: "turn:session-1:turn-1",
    turnId: "turn-1",
    occurredAt: "2026-08-04T11:02:00.000Z",
    startedAt: "2026-08-04T11:00:00.000Z",
    finishedAt: "2026-08-04T11:02:00.000Z",
    status: "completed" as const,
    user: "Remember that this project uses node:sqlite.",
    assistant: "Implemented and tested.",
    agentRuns: [],
  }],
};

test("builds strict Codex-style Turn Memory extraction requests", () => {
  const request = buildTurnMemoryExtractionRequest("summary-model", input, 2_000);

  assert.equal(request.text?.format?.type, "json_schema");
  assert.equal(request.text?.format?.name, "turn_memory_extraction");
  assert.equal(request.text?.format?.strict, true);
  assert.match(String(request.instructions), /explicit user/i);
  assert.match(String(request.instructions), /failed|cancelled|interrupted/i);
  assert.doesNotMatch(String(request.instructions), /fallback|prompt.?version/i);
});

test("parses only raw memory, Turn summary, and Turn slug", () => {
  assert.deepEqual(parseTurnMemoryExtraction(JSON.stringify({
    raw_memory: "The OpenScreen project uses node:sqlite.",
    turn_summary: "The user selected and implemented node:sqlite.",
    turn_slug: "use-node-sqlite",
  })), {
    rawMemory: "The OpenScreen project uses node:sqlite.",
    turnSummary: "The user selected and implemented node:sqlite.",
    turnSlug: "use-node-sqlite",
  });
  assert.deepEqual(parseTurnMemoryExtraction(JSON.stringify({
    raw_memory: "",
    turn_summary: "",
    turn_slug: "",
  })), { rawMemory: "", turnSummary: "", turnSlug: "" });
  assert.throws(() => parseTurnMemoryExtraction(JSON.stringify({
    raw_memory: "memory",
    turn_summary: "summary",
    turn_slug: "turn",
    source_ids: ["turn:session-1:turn-1"],
  })), /unexpected field source_ids/i);
  assert.throws(() => parseTurnMemoryExtraction(JSON.stringify({
    raw_memory: "x".repeat(12_001),
    turn_summary: "summary",
    turn_slug: "turn",
  })), /too long/i);
});
