import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import {
  recordMemorySourceInTransaction,
} from "../../../src/memory/consolidate/source-repository.js";
import {
  TurnMemoryRepository,
} from "../../../src/memory/turn-memory/repository.js";
import type {
  TerminalTurnProjection,
  TurnMemorySource,
} from "../../../src/memory/turn-memory/types.js";

const policy = {
  maxInputTokens: 8_000,
  maxOutputTokens: 2_000,
  idleMilliseconds: 30 * 60_000,
  hardCapMilliseconds: 2 * 60 * 60_000,
  worker: {
    leaseMilliseconds: 60_000,
    retryDelayMilliseconds: 1_000,
    maxAttempts: 3,
  },
};

function source(
  id: string,
  occurredAt: string,
  overrides: Partial<TurnMemorySource> = {},
): TurnMemorySource {
  return {
    sourceId: `turn:session-1:${id}`,
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "feature/memory",
    rolloutPath: "/sessions/session-1.jsonl",
    userEntryIds: [id],
    terminalEntryId: `answer-${id}`,
    startedAt: new Date(Date.parse(occurredAt) - 60_000).toISOString(),
    finishedAt: occurredAt,
    occurredAt,
    status: "completed",
    user: `Remember ${id}`,
    assistant: "Recorded",
    sourceFrameIds: [],
    tools: [],
    ...overrides,
  };
}

function projection(
  sources: TurnMemorySource[],
  nextEntryId: string | undefined,
  cursorRewound = false,
): TerminalTurnProjection {
  return {
    sources,
    ...(nextEntryId === undefined ? {} : { nextEntryId }),
    cursorRewound,
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  return {
    database,
    repository: new TurnMemoryRepository(database, policy),
  };
}

test("atomically ingests terminal sources and advances the durable cursor", async (t) => {
  const { database, repository } = await fixture(t);
  const terminalAt = "2026-08-15T10:05:00.000Z";
  const result = repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection: projection([source("user-1", terminalAt)], "answer-user-1"),
    scannedAt: Date.parse(terminalAt),
  });

  assert.deepEqual(result, { ingested: 1, updated: 0, deactivated: 0 });
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM turn_memory_sources
  `).get()?.count, 1);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT file_version, last_terminal_entry_id, status
    FROM turn_memory_session_scans WHERE session_id = 'session-1'
  `).get() }, {
    file_version: "v1",
    last_terminal_entry_id: "answer-user-1",
    status: "valid",
  });

  assert.deepEqual(repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v2",
    projection: projection([source("user-1", terminalAt)], "answer-user-1"),
    scannedAt: Date.parse(terminalAt) + 1,
  }), { ingested: 0, updated: 0, deactivated: 0 });
});

test("does not advance the cursor when a later source fails ingestion", async (t) => {
  const { database, repository } = await fixture(t);
  const valid = source("user-1", "2026-08-15T10:05:00.000Z");
  const invalid = source("user-2", "2026-08-15T10:06:00.000Z", {
    occurredAt: "not-a-time",
  });

  assert.throws(() => repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection: projection([valid, invalid], "answer-user-2"),
    scannedAt: 1,
  }), /Invalid Turn occurrence/);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM turn_memory_sources
  `).get()?.count, 0);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM turn_memory_session_scans
  `).get()?.count, 0);
});

test("deactivates abandoned branch sources during a cursor rewind", async (t) => {
  const { database, repository } = await fixture(t);
  const first = source("old-1", "2026-08-15T10:05:00.000Z");
  const abandoned = source("old-2", "2026-08-15T10:10:00.000Z");
  repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection: projection([first, abandoned], "answer-old-2"),
    scannedAt: 1,
  });
  const revised = source("new-2", "2026-08-15T10:11:00.000Z");

  const result = repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v2",
    projection: projection([first, revised], "answer-new-2", true),
    scannedAt: 2,
  });

  assert.deepEqual(result, { ingested: 1, updated: 0, deactivated: 1 });
  assert.deepEqual(database.connection.prepare(`
    SELECT id, active FROM turn_memory_sources ORDER BY id
  `).all().map((row) => ({ id: row.id, active: row.active })), [
    { id: "turn:session-1:new-2", active: 1 },
    { id: "turn:session-1:old-1", active: 1 },
    { id: "turn:session-1:old-2", active: 0 },
  ]);
});

test("seals an idle batch and queues one extraction job", async (t) => {
  const { database, repository } = await fixture(t);
  const terminalAt = Date.parse("2026-08-15T10:05:00.000Z");
  repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection: projection([
      source("user-1", new Date(terminalAt).toISOString()),
    ], "answer-user-1"),
    scannedAt: terminalAt,
  });
  const batch = database.connection.prepare(`
    SELECT id, eligible_at FROM turn_memory_batches WHERE status = 'open'
  `).get();
  assert.ok(batch);

  assert.deepEqual(repository.sealDueBatches(Number(batch.eligible_at)), [batch.id]);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT kind, source_id, status FROM memory_jobs
  `).get() }, {
    kind: "turn_memory_extraction",
    source_id: batch.id,
    status: "pending",
  });
});

test("deactivates Turn and consolidation sources when a Pi Session disappears", async (t) => {
  const { database, repository } = await fixture(t);
  const turn = source("user-1", "2026-08-15T10:05:00.000Z");
  repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection: projection([turn], "answer-user-1"),
    scannedAt: 1,
  });
  database.transaction(() => {
    recordMemorySourceInTransaction(database, {
      sourceKey: "turn-memory:batch-1",
      kind: "turn_memory",
      sourceId: "batch-1",
      sourceGeneration: 1,
      sourceSummary: "remembered",
      rawMemory: "remembered",
      artifactPath: "rollout_summaries/turn-session-1.md",
      contentHash: "a".repeat(64),
      startedAt: 1,
      endedAt: 2,
      provenance: "user_turn",
      supportsSuccess: false,
      sourceIds: [turn.sourceId],
      generatedAt: 2,
    }, policy.worker.maxAttempts);
  });

  assert.equal(repository.reconcileSessions([], 3), 1);
  assert.equal(database.connection.prepare(`
    SELECT active FROM turn_memory_sources WHERE id = ?
  `).get(turn.sourceId)?.active, 0);
  assert.equal(database.connection.prepare(`
    SELECT active FROM memory_sources WHERE source_key = 'turn-memory:batch-1'
  `).get()?.active, 0);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT file_version, status, last_error FROM turn_memory_session_scans
  `).get() }, {
    file_version: "missing",
    status: "invalid",
    last_error: "Pi Session no longer exists",
  });
});
