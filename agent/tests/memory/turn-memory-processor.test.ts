import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import { processNextTurnMemory } from "../../src/harness/memory/turn-memory/processor.js";
import { TurnMemoryRepository } from "../../src/harness/memory/turn-memory/repository.js";
import type { TurnMemorySource } from "../../src/harness/memory/turn-memory/types.js";
import { testMemoryConfig } from "./test-config.js";

function source(): TurnMemorySource {
  return {
    sourceId: "turn:session-1:turn-1",
    occurredAt: "2026-08-04T10:05:00.000Z",
    turn: {
      id: "turn-1",
      user: "Review this without remembering it",
      assistant: "Done",
      status: "completed",
      startedAt: "2026-08-04T10:04:00.000Z",
      finishedAt: "2026-08-04T10:05:00.000Z",
    },
    agentRuns: [],
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-memory-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, testMemoryConfig());
  const ingested = repository.ingestTurn({
    sessionId: "session-1",
    source: source(),
    projectedInputTokens: 100,
    maxInputTokens: 7_000,
  });
  repository.sealDueBatches(ingested.eligibleAt);
  return { database, repository, due: ingested.eligibleAt };
}

test("persists a valid empty Turn Memory extraction", async (t) => {
  const { database, repository, due } = await fixture(t);
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async () => ({
        status: "completed",
        output_text: JSON.stringify({
          raw_memory: "",
          turn_summary: "",
          turn_slug: "",
        }),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
    },
  } as unknown as OpenAI;

  assert.equal((await processNextTurnMemory({
    repository,
    client,
    model: "summary-model",
    workerId: "turn-memory-worker",
    contextWindowTokens: 10_000,
    now: () => due,
  })).status, "processed");
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT raw_memory, turn_summary, turn_slug FROM turn_memory_extractions
  `).get() }, { raw_memory: "", turn_summary: "", turn_slug: "" });
});

test("does not submit Turn Memory when token counting returns zero", async (t) => {
  const { repository, due } = await fixture(t);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 0 }) },
      create: async () => {
        generations += 1;
        return { output_text: "{}" };
      },
    },
  } as unknown as OpenAI;

  const result = await processNextTurnMemory({
    repository,
    client,
    model: "summary-model",
    workerId: "turn-memory-worker",
    contextWindowTokens: 10_000,
    now: () => due,
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /zero input tokens/i);
  assert.equal(generations, 0);
});
