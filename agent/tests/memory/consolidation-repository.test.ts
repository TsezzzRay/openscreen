import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  ConsolidationRepository,
} from "../../src/harness/memory/consolidate/repository.js";
import { testMemoryConfig } from "./test-config.js";

const memory = testMemoryConfig();

async function fixture(t: test.TestContext, inputWatermark = 1) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-consolidation-repository-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  database.connection.prepare(`
    INSERT INTO consolidation_jobs (
      job_key, status, retry_remaining, input_watermark,
      last_success_watermark
    ) VALUES ('global', 'pending', 3, ?, 0)
  `).run(inputWatermark);
  return {
    database,
    repository: new ConsolidationRepository(database, memory),
  };
}

test("claims the singleton Consolidation job and fences an expired owner", async (t) => {
  const { repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");

  const first = repository.claim("worker-1", now);
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  assert.equal(first.claim.inputWatermark, 1);
  assert.equal(first.claim.leaseUntil, now + memory.worker.leaseMilliseconds);
  assert.deepEqual(repository.claim("worker-2", now + 1), {
    status: "skipped",
    reason: "running",
  });

  const reclaimed = repository.claim(
    "worker-2",
    now + memory.worker.leaseMilliseconds,
  );
  assert.equal(reclaimed.status, "claimed");
  if (reclaimed.status !== "claimed") return;
  assert.notEqual(reclaimed.claim.ownershipToken, first.claim.ownershipToken);
  assert.equal(repository.heartbeat(
    first.claim,
    now + memory.worker.leaseMilliseconds + 1,
  ), false);
  assert.equal(repository.succeed(
    first.claim,
    now + memory.worker.leaseMilliseconds + 1,
  ), false);
});

test("backs off after three consecutive expired Consolidation leases", async (t) => {
  const { database, repository } = await fixture(t);
  let now = Date.parse("2026-08-04T12:00:00.000Z");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = repository.claim(`worker-${attempt}`, now);
    assert.equal(claimed.status, "claimed");
    if (claimed.status !== "claimed") return;
    now = claimed.claim.leaseUntil;
  }

  assert.deepEqual(repository.claim("worker-3", now), {
    status: "skipped",
    reason: "retry",
  });
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at, abandonment_count
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "error",
    retry_remaining: 3,
    retry_at: now + memory.worker.retryDelayMilliseconds,
    abandonment_count: 3,
  });
  assert.deepEqual(repository.claim(
    "worker-4",
    now + memory.worker.retryDelayMilliseconds - 1,
  ), {
    status: "skipped",
    reason: "retry",
  });
  assert.equal(repository.claim(
    "worker-4",
    now + memory.worker.retryDelayMilliseconds,
  ).status, "claimed");
});

test("an expired Consolidation owner cannot fail the job", async (t) => {
  const { database, repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const claimed = repository.claim("worker-1", now);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;

  assert.equal(repository.fail(
    claimed.claim,
    "too late",
    now + memory.worker.leaseMilliseconds,
  ), false);
  assert.equal(database.connection.prepare(`
    SELECT status FROM consolidation_jobs
    WHERE job_key = 'global'
  `).get()?.status, "running");
});

test("an expired Consolidation owner cannot enter the filesystem publication callback", async (t) => {
  const { repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const claimed = repository.claim("worker-1", now);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(repository.preparePublication(claimed.claim, {
    stagingName: "staged",
    memorySha256: "memory",
    summarySha256: "summary",
    evidence: {},
    createdAt: now,
  }, now), true);
  assert.equal(repository.beginPublication(claimed.claim, now), true);
  let callbacks = 0;

  assert.equal(repository.finalizePublication(
    claimed.claim,
    now + memory.worker.leaseMilliseconds,
    new Map(),
    () => {
      callbacks += 1;
    },
  ), false);
  assert.equal(callbacks, 0);
});

test("materializes an immutable Memory source snapshot when Consolidation claims", async (t) => {
  const { database, repository } = await fixture(t);
  database.connection.prepare(`
    INSERT INTO chronicle_sources (
      id, source_key, occurred_at, captured_at, projection_json, ingested_at
    ) VALUES ('observation:1', 'observation:1', 1, 1, '{}', 1)
  `).run();
  database.connection.prepare(`
    INSERT INTO chronicle_windows (
      id, start_at, end_at, eligible_at, source_generation, created_at, updated_at
    ) VALUES ('window:1', 1, 2, 2, 1, 1, 1)
  `).run();
  database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining
    ) VALUES ('chronicle:window:1', 'chronicle_summarization', 'window:1', 1,
              'succeeded', 1, 3)
  `).run();
  database.connection.prepare(`
    INSERT INTO chronicle_summaries (
      job_key, source_generation, source_updated_at, source_summary, generated_at
    ) VALUES ('chronicle:window:1', 1, 1, 'old summary', 1)
  `).run();
  database.connection.prepare(`
    INSERT INTO chronicle_summary_sources (job_key, source_id)
    VALUES ('chronicle:window:1', 'observation:1')
  `).run();
  const claimed = repository.claim("worker-1", 100);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;

  database.transaction(() => {
    database.connection.prepare(`
      UPDATE chronicle_summaries SET source_generation = 2, source_updated_at = 2,
        source_summary = 'new summary', generated_at = 2
      WHERE job_key = 'chronicle:window:1'
    `).run();
    database.connection.prepare(`
      UPDATE consolidation_jobs SET input_watermark = 2
      WHERE job_key = 'global'
    `).run();
  });

  const inputs = repository.loadInputs(claimed.claim);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.sourceSummary, "old summary");
  assert.equal(inputs[0]?.sourceUpdatedAt, 1);
  assert.equal(inputs[0]?.state, "added");
  assert.equal(inputs[0]?.provenance, "passive_screen");
  assert.match(inputs[0]?.artifactPath ?? "", /^rollout_summaries\/chronicle-/);
  assert.doesNotThrow(() => database.connection.prepare(`
    DELETE FROM chronicle_summaries WHERE job_key = 'chronicle:window:1'
  `).run());
  assert.equal(repository.loadInputs(claimed.claim).length, 1);
  assert.equal(repository.succeed(claimed.claim, 101), true);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM consolidation_source_baseline
  `).get()?.count, 1);
  database.connection.prepare(`
    UPDATE consolidation_jobs SET status = 'pending', input_watermark = 2
    WHERE job_key = 'global'
  `).run();
  const forgetting = repository.claim(
    "worker-2",
    102 + memory.consolidation.cooldownMilliseconds,
  );
  assert.equal(forgetting.status, "claimed");
  if (forgetting.status !== "claimed") return;
  assert.equal(repository.loadInputs(forgetting.claim)[0]?.state, "removed");
});

test("enforces six-hour success cooldown even when new Memory input is pending", async (t) => {
  const { database, repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const claimed = repository.claim("worker-1", now);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(repository.succeed(claimed.claim, now + 1), true);
  assert.deepEqual(repository.claim("worker-2", now + 2), {
    status: "skipped",
    reason: "up_to_date",
  });

  database.connection.prepare(`
    UPDATE consolidation_jobs SET status = 'pending', input_watermark = input_watermark + 1
    WHERE job_key = 'global'
  `).run();
  assert.deepEqual(repository.claim(
    "worker-2",
    now + memory.consolidation.cooldownMilliseconds,
  ), {
    status: "skipped",
    reason: "cooldown",
  });
  assert.equal(
    repository.claim(
      "worker-2",
      now + memory.consolidation.cooldownMilliseconds + 1,
    ).status,
    "claimed",
  );
});

test("keeps Memory input that arrives during a Consolidation run for the next snapshot", async (t) => {
  const { database, repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const claimed = repository.claim("worker-1", now);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;

  database.connection.prepare(`
    UPDATE consolidation_jobs SET input_watermark = 2
    WHERE job_key = 'global'
  `).run();
  assert.equal(repository.succeed(claimed.claim, now + 1), true);

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, input_watermark, last_success_watermark, finished_at
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "pending",
    input_watermark: 2,
    last_success_watermark: 1,
    finished_at: now + 1,
  });
});

test("backs off Consolidation failures for one hour and stops after three attempts", async (t) => {
  const { database, repository } = await fixture(t);
  let now = Date.parse("2026-08-04T12:00:00.000Z");
  for (let remaining = 2; remaining >= 0; remaining -= 1) {
    const claimed = repository.claim("worker-1", now);
    assert.equal(claimed.status, "claimed");
    if (claimed.status !== "claimed") return;
    assert.equal(repository.fail(claimed.claim, "model failed", now + 1), true);
    const row = database.connection.prepare(`
      SELECT retry_remaining, retry_at FROM consolidation_jobs
      WHERE job_key = 'global'
    `).get();
    assert.equal(row?.retry_remaining, remaining);
    assert.equal(
      row?.retry_at,
      remaining > 0
        ? now + 1 + memory.worker.retryDelayMilliseconds
        : null,
    );
    if (remaining > 0) {
      assert.deepEqual(repository.claim("worker-2", now + 2), {
        status: "skipped",
        reason: "retry",
      });
      now += 1 + memory.worker.retryDelayMilliseconds;
    }
  }
  assert.deepEqual(repository.claim("worker-2", now + 1), {
    status: "skipped",
    reason: "retry_exhausted",
  });
});
