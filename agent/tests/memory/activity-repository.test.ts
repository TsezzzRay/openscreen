import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import { ActivityRepository } from "../../src/harness/memory/activity/repository.js";
import type { ActivityOutput, ActivitySource } from "../../src/harness/memory/activity/types.js";
import type { ScreenObservation } from "../../src/plugins/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

function screenObservation(id: string, occurredAt: string): ScreenObservation {
  return {
    schemaVersion: 1,
    id,
    occurredAt,
    capturedAt: new Date(Date.parse(occurredAt) + 100).toISOString(),
    trigger: { type: "focusedWindowChanged" },
    window: {
      processIdentifier: 42,
      bundleIdentifier: "com.apple.Safari",
      applicationName: "Safari",
      title: "Memory design",
    },
    screenshot: {
      status: "complete",
      durationMilliseconds: 10,
      dataBase64: "raw-image",
      mimeType: "image/jpeg",
    },
    accessibility: {
      status: "complete",
      durationMilliseconds: 5,
    },
    visibleText: `Observation ${id}`,
    diagnostics: {
      triggerToCaptureMilliseconds: 100,
      screenshotDurationMilliseconds: 10,
      accessibilityDurationMilliseconds: 5,
    },
  };
}

function turnSource(
  id: string,
  occurredAt: string,
  status: ActivitySource["turn"]["status"] = "completed",
): ActivitySource {
  return {
    sourceId: `turn:session-1:${id}`,
    occurredAt,
    turn: {
      id,
      user: `User ${id}`,
      assistant: `Assistant ${id}`,
      status,
      startedAt: new Date(Date.parse(occurredAt) - 60_000).toISOString(),
      finishedAt: occurredAt,
    },
    agentRuns: [],
  };
}

function outputFor(sourceIds: string[]): ActivityOutput {
  return {
    activities: [{
      summary: "The user reviewed the memory design.",
      sourceIds,
      application: "Safari",
      windowTitle: "Memory design",
      entities: ["OpenScreen"],
      verbatimEvidence: [],
      scopeHints: [{ type: "application", key: "com.apple.Safari", label: "Safari" }],
    }],
    sourceSummary: "The sources describe work on the memory design.",
    rawMemory: "The user is building OpenScreen's memory pipeline.",
    scopeHints: [{ type: "topic", key: "openscreen-memory", label: "OpenScreen Memory" }],
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  return {
    database,
    repository: new ActivityRepository(database, testMemoryConfig()),
  };
}

test("persists an Observation once and queues its closed UTC minute window", async (t) => {
  const { database, repository } = await fixture(t);
  const now = Date.parse("2026-08-04T10:01:20.000Z");
  const observation = screenObservation("observation-1", "2026-08-04T10:00:42.000Z");

  const first = repository.ingestObservation(observation, now);
  const duplicate = repository.ingestObservation(observation, now + 1);

  assert.equal(first.duplicate, false);
  assert.equal(first.sourceGeneration, 1);
  assert.equal(first.eligibleAt, Date.parse("2026-08-04T10:01:15.000Z"));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sourceGeneration, 1);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM source_items",
  ).get()?.count, 1);
  const job = database.connection.prepare(`
    SELECT status, source_generation, eligible_at
    FROM activity_jobs WHERE source_id = ?
  `).get(first.windowId) as Record<string, unknown>;
  assert.deepEqual({ ...job }, {
    status: "pending",
    source_generation: 1,
    eligible_at: first.eligibleAt,
  });
  const projection = JSON.parse(String(database.connection.prepare(
    "SELECT projection_json FROM source_items WHERE id = ?",
  ).get(first.sourceId)?.projection_json));
  assert.equal(projection.visibleText, "Observation observation-1");
  assert.equal(JSON.stringify(projection).includes("raw-image"), false);
});

test("a late Observation requeues the window and fences its previous worker", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const claim = repository.claimNext({
    workerId: "worker-1",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);

  const late = repository.ingestObservation(
    screenObservation("observation-2", "2026-08-04T10:00:50.000Z"),
    Date.parse("2026-08-04T10:01:20.000Z"),
  );

  assert.equal(late.sourceGeneration, 2);
  assert.equal(repository.heartbeat(
    claim.jobKey,
    claim.ownershipToken,
    Date.parse("2026-08-04T10:01:21.000Z"),
  ), false);
  assert.throws(() => repository.complete(
    claim.jobKey,
    claim.ownershipToken,
    outputFor(["observation:observation-1"]),
    Date.parse("2026-08-04T10:01:22.000Z"),
  ), /Activity ownership lost/);
  assert.equal(database.connection.prepare(
    "SELECT status FROM activity_jobs WHERE job_key = ?",
  ).get(claim.jobKey)?.status, "pending");
});

test("claims one due Activity job and reclaims it only after its lease expires", async (t) => {
  const { repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const due = Date.parse("2026-08-04T10:01:15.000Z");

  const first = repository.claimNext({
    workerId: "worker-1",
    now: due,
  });
  const blocked = repository.claimNext({
    workerId: "worker-2",
    now: due + 59_999,
  });
  const reclaimed = repository.claimNext({
    workerId: "worker-2",
    now: due + 60_000,
  });

  assert.ok(first);
  assert.equal(blocked, null);
  assert.ok(reclaimed);
  assert.equal(reclaimed.jobKey, first.jobKey);
  assert.notEqual(reclaimed.ownershipToken, first.ownershipToken);
  assert.equal(repository.heartbeat(
    first.jobKey,
    first.ownershipToken,
    due + 60_001,
  ), false);
});

test("backs off after three consecutive expired Activity leases", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  let now = Date.parse("2026-08-04T10:01:15.000Z");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = repository.claimNext({
      workerId: `worker-${attempt}`,
      now,
    });
    assert.ok(claim);
    now = claim.leaseUntil;
  }

  assert.equal(repository.claimNext({
    workerId: "worker-3",
    now,
  }), null);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at, abandonment_count
    FROM activity_jobs
  `).get() }, {
    status: "error",
    retry_remaining: 3,
    retry_at: now + 60 * 60_000,
    abandonment_count: 3,
  });
  assert.equal(repository.claimNext({
    workerId: "worker-4",
    now: now + 60 * 60_000 - 1,
  }), null);
  assert.ok(repository.claimNext({
    workerId: "worker-4",
    now: now + 60 * 60_000,
  }));
});

test("an expired Activity owner cannot complete or fail a job", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const due = Date.parse("2026-08-04T10:01:15.000Z");
  const claim = repository.claimNext({
    workerId: "worker-1",
    now: due,
  });
  assert.ok(claim);

  assert.throws(() => repository.complete(
    claim.jobKey,
    claim.ownershipToken,
    outputFor(["observation:observation-1"]),
    due + 60_000,
  ), /Activity ownership lost/);
  assert.equal(repository.fail(
    claim.jobKey,
    claim.ownershipToken,
    "too late",
    due + 60_000,
  ), false);
  assert.equal(database.connection.prepare(
    "SELECT status FROM activity_jobs WHERE job_key = ?",
  ).get(claim.jobKey)?.status, "running");
});

test("waits for Turn idle time, seals at budget, and starts later Turns in a new batch", async (t) => {
  const { database, repository } = await fixture(t);
  const firstAt = Date.parse("2026-08-04T10:05:00.000Z");
  const first = repository.ingestTurn({
    sessionId: "session-1",
    source: turnSource("turn-1", new Date(firstAt).toISOString()),
    projectedInputTokens: 3_000,
    maxInputTokens: 7_000,
    ingestedAt: firstAt,
  });
  assert.equal(first.status, "open");
  assert.equal(first.eligibleAt, firstAt + 30 * 60_000);
  assert.deepEqual(repository.sealDueTurnBatches(first.eligibleAt - 1), []);
  assert.deepEqual(repository.sealDueTurnBatches(first.eligibleAt), [first.batchId]);

  const secondAt = first.eligibleAt + 1;
  const second = repository.ingestTurn({
    sessionId: "session-1",
    source: turnSource("turn-2", new Date(secondAt).toISOString()),
    projectedInputTokens: 7_000,
    maxInputTokens: 7_000,
    ingestedAt: secondAt,
  });
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(second.status, "sealed");
  assert.equal(second.closeReason, "budget");
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_jobs WHERE source_kind = 'turn_batch'",
  ).get()?.count, 2);
});

test("restarts a Turn batch when a lower effective budget no longer fits", async (t) => {
  const { database, repository } = await fixture(t);
  const firstAt = Date.parse("2026-08-04T10:05:00.000Z");
  const first = repository.ingestTurn({
    sessionId: "session-1",
    source: turnSource("turn-1", new Date(firstAt).toISOString()),
    projectedInputTokens: 6_000,
    maxInputTokens: 7_000,
    ingestedAt: firstAt,
  });
  assert.equal(first.status, "open");

  const preview = repository.previewTurnBatch(
    "session-1",
    turnSource("turn-2", new Date(firstAt + 1).toISOString()),
    5_000,
  );

  assert.deepEqual(preview?.turns.map(({ turnId }) => turnId), ["turn-2"]);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, close_reason FROM turn_batches WHERE id = ?
  `).get(first.batchId) }, { status: "sealed", close_reason: "recovery" });
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM activity_jobs WHERE source_id = ?
  `).get(first.batchId)?.count, 1);
});

test("commits Activity output atomically and wakes the singleton Consolidation job", async (t) => {
  const { database, repository } = await fixture(t);
  const sourceId = "observation:observation-1";
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const claim = repository.claimNext({
    workerId: "worker-1",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);

  repository.complete(
    claim.jobKey,
    claim.ownershipToken,
    outputFor([sourceId]),
    Date.parse("2026-08-04T10:01:20.000Z"),
  );

  assert.equal(database.connection.prepare(
    "SELECT status FROM activity_jobs WHERE job_key = ?",
  ).get(claim.jobKey)?.status, "succeeded");
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_records",
  ).get()?.count, 1);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_record_sources WHERE source_id = ?",
  ).get(sourceId)?.count, 1);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, input_watermark, last_success_watermark
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "pending",
    input_watermark: 1,
    last_success_watermark: 0,
  });
});

test("late Observation replaces the current Activity result without keeping versions", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  const first = repository.claimNext({
    workerId: "worker-1",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(first);
  repository.complete(
    first.jobKey,
    first.ownershipToken,
    outputFor(["observation:observation-1"]),
    Date.parse("2026-08-04T10:01:16.000Z"),
  );

  repository.ingestObservation(
    screenObservation("observation-2", "2026-08-04T10:00:50.000Z"),
    Date.parse("2026-08-04T10:02:00.000Z"),
  );
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_records",
  ).get()?.count, 1, "the previous result remains readable until replacement commits");
  const replacement = repository.claimNext({
    workerId: "worker-2",
    now: Date.parse("2026-08-04T10:02:00.000Z"),
  });
  assert.ok(replacement);
  repository.complete(
    replacement.jobKey,
    replacement.ownershipToken,
    outputFor([
      "observation:observation-1",
      "observation:observation-2",
    ]),
    Date.parse("2026-08-04T10:02:01.000Z"),
  );

  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_records",
  ).get()?.count, 1);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_record_sources",
  ).get()?.count, 2);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT source_generation, source_updated_at FROM activity_summaries
  `).get() }, { source_generation: 2, source_updated_at: 2 });
  assert.equal(database.connection.prepare(`
    SELECT input_watermark FROM consolidation_jobs
    WHERE job_key = 'global'
  `).get()?.input_watermark, 2);
});

test("new Activity output revives an exhausted consolidation job", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  database.connection.prepare(`
    INSERT INTO consolidation_jobs (
      job_key, status, retry_remaining, input_watermark,
      last_success_watermark, finished_at, last_error
    ) VALUES (
      'global', 'error', 0, 4, 3,
      1000, 'old failure'
    )
  `).run();
  const claim = repository.claimNext({
    workerId: "worker",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);
  repository.complete(
    claim.jobKey,
    claim.ownershipToken,
    outputFor(["observation:observation-1"]),
    Date.parse("2026-08-04T10:01:16.000Z"),
  );

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at, input_watermark,
           finished_at, last_error
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "pending",
    retry_remaining: 3,
    retry_at: null,
    input_watermark: 5,
    finished_at: null,
    last_error: null,
  });
});

test("new Activity output preserves an active Consolidation retry backoff", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(
    screenObservation("observation-1", "2026-08-04T10:00:10.000Z"),
    Date.parse("2026-08-04T10:00:10.100Z"),
  );
  database.connection.prepare(`
    INSERT INTO consolidation_jobs (
      job_key, status, retry_remaining, retry_at, input_watermark,
      last_success_watermark, finished_at, last_error
    ) VALUES (
      'global', 'error', 2, 5000, 4, 3,
      1000, 'transient failure'
    )
  `).run();
  const claim = repository.claimNext({
    workerId: "worker",
    now: Date.parse("2026-08-04T10:01:15.000Z"),
  });
  assert.ok(claim);
  repository.complete(
    claim.jobKey,
    claim.ownershipToken,
    outputFor(["observation:observation-1"]),
    Date.parse("2026-08-04T10:01:16.000Z"),
  );

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at, input_watermark,
           finished_at, last_error
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "error",
    retry_remaining: 2,
    retry_at: 5000,
    input_watermark: 5,
    finished_at: 1000,
    last_error: "transient failure",
  });
});
