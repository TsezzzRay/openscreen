import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import { TurnMemoryRepository } from "../../src/harness/memory/turn-memory/repository.js";
import type { TurnMemorySource } from "../../src/harness/memory/turn-memory/types.js";
import { testMemoryConfig } from "./test-config.js";

function source(id: string, occurredAt: string): TurnMemorySource {
  return {
    sourceId: `turn:session-1:${id}`,
    occurredAt,
    turn: {
      id,
      user: `Remember ${id}`,
      assistant: "Recorded",
      status: "completed",
      startedAt: new Date(Date.parse(occurredAt) - 60_000).toISOString(),
      finishedAt: occurredAt,
    },
    agentRuns: [],
  };
}

test("batches terminal Turns and commits the three-field extraction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-memory-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, testMemoryConfig());
  const terminalAt = Date.parse("2026-08-04T10:05:00.000Z");
  const ingested = repository.ingestTurn({
    sessionId: "session-1",
    source: source("turn-1", new Date(terminalAt).toISOString()),
    projectedInputTokens: 1_000,
    maxInputTokens: 7_000,
    ingestedAt: terminalAt,
  });
  assert.equal(ingested.status, "open");
  assert.deepEqual(repository.sealDueBatches(ingested.eligibleAt), [ingested.batchId]);

  const claim = repository.claimNext({
    workerId: "turn-memory-worker",
    now: ingested.eligibleAt,
  });
  assert.ok(claim);
  assert.deepEqual(
    repository.loadClaimSources(claim).turns.map(({ turnId }) => turnId),
    ["turn-1"],
  );
  repository.complete(claim, {
    rawMemory: "The user asked OpenScreen to remember turn-1.",
    turnSummary: "The user asked to remember turn-1.",
    turnSlug: "remember-turn-1",
  }, ingested.eligibleAt + 1);

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT raw_memory, turn_summary, turn_slug
    FROM turn_memory_extractions WHERE job_key = ?
  `).get(claim.jobKey) }, {
    raw_memory: "The user asked OpenScreen to remember turn-1.",
    turn_summary: "The user asked to remember turn-1.",
    turn_slug: "remember-turn-1",
  });
  assert.equal(database.connection.prepare(`
    SELECT status FROM memory_jobs WHERE job_key = ?
  `).get(claim.jobKey)?.status, "succeeded");
});

test("seals a Turn Memory batch at its exact input budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-memory-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, testMemoryConfig());
  const terminalAt = Date.parse("2026-08-04T10:05:00.000Z");
  const result = repository.ingestTurn({
    sessionId: "session-1",
    source: source("turn-1", new Date(terminalAt).toISOString()),
    projectedInputTokens: 7_000,
    maxInputTokens: 7_000,
    ingestedAt: terminalAt,
  });

  assert.equal(result.status, "sealed");
  assert.equal(result.closeReason, "budget");
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM memory_jobs
    WHERE kind = 'turn_memory_extraction'
  `).get()?.count, 1);
});
