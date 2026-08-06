import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import { ProducerJobs } from "../../src/harness/memory/shared/producer-jobs.js";
import { testMemoryConfig } from "./test-config.js";

test("claims and retries Chronicle and Turn Memory jobs independently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-producer-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const jobs = new ProducerJobs(database, testMemoryConfig());
  database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining
    ) VALUES (?, ?, ?, 1, 'pending', 1000, 3)
  `).run("chronicle:1", "chronicle_summarization", "window:1");
  database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining
    ) VALUES (?, ?, ?, 1, 'pending', 1000, 3)
  `).run("turn-memory:1", "turn_memory_extraction", "batch:1");

  const chronicle = jobs.claimNext("chronicle_summarization", {
    workerId: "chronicle-worker",
    now: 1_000,
  });
  assert.ok(chronicle);
  assert.equal(jobs.fail(
    chronicle,
    "provider unavailable",
    1_001,
  ), true);

  const turnMemory = jobs.claimNext("turn_memory_extraction", {
    workerId: "turn-worker",
    now: 1_001,
  });
  assert.ok(turnMemory);
  assert.equal(turnMemory.kind, "turn_memory_extraction");
  assert.equal(jobs.heartbeat(turnMemory, 1_002), true);
  assert.equal(jobs.heartbeat(chronicle, 1_002), false);

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at FROM memory_jobs
    WHERE job_key = 'chronicle:1'
  `).get() }, {
    status: "error",
    retry_remaining: 2,
    retry_at: 1_001 + 60 * 60_000,
  });
  assert.equal(database.connection.prepare(`
    SELECT status FROM memory_jobs WHERE job_key = 'turn-memory:1'
  `).get()?.status, "running");
});
