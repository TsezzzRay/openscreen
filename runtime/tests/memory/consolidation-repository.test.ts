import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MemoryConfig } from "../../src/memory/config.js";
import {
  ConsolidationRepository,
} from "../../src/memory/consolidate/repository.js";
import {
  deactivateMemorySourcesByEvidenceInTransaction,
  recordMemorySourceInTransaction,
} from "../../src/memory/consolidate/source-repository.js";
import { openMemoryDatabase } from "../../src/memory/database.js";

const config: MemoryConfig = {
  enabled: true,
  worker: {
    intervalMilliseconds: 1_000,
    maxJobsPerTick: 2,
    leaseMilliseconds: 10_000,
    retryDelayMilliseconds: 1_000,
    maxAttempts: 3,
  },
  turnMemory: {
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    idleMilliseconds: 10,
    hardCapMilliseconds: 100,
  },
  chronicle: {
    windowMilliseconds: 60_000,
    graceMilliseconds: 15_000,
    maxSourcesPerRequest: 10,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
  },
  consolidation: {
    maxChangedSourcesPerRun: 2,
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    summaryMaxTokens: 1_000,
    cooldownMilliseconds: 1_000,
  },
  retention: {
    chronicleUnreferencedMilliseconds: 90 * 24 * 60 * 60 * 1_000,
  },
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-consolidation-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  return {
    database,
    repository: new ConsolidationRepository(database, config),
  };
}

function addSource(
  database: ReturnType<typeof openMemoryDatabase>,
  key: string,
  version = 1,
): void {
  database.transaction(() => {
    recordMemorySourceInTransaction(database, {
      sourceKey: key,
      kind: "turn_memory",
      sourceId: `batch:${key}`,
      sourceGeneration: version,
      sourceSummary: `summary ${key} v${version}`,
      rawMemory: `raw ${key} v${version}`,
      artifactPath: `rollout_summaries/turn-${key}.md`,
      contentHash: String(version).repeat(64),
      startedAt: version,
      endedAt: version + 1,
      provenance: "user_turn",
      supportsSuccess: true,
      sourceIds: [`turn:${key}`],
      generatedAt: version + 1,
    }, config.worker.maxAttempts);
  });
}

test("freezes an immutable source snapshot and fences expired owners", async (t) => {
  const { database, repository } = await fixture(t);
  addSource(database, "a");
  const claimed = repository.claim("worker-1", 100);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(claimed.claim.frozenWatermark, 1);
  assert.equal(repository.loadInputs(claimed.claim)[0]?.sourceSummary, "summary a v1");

  addSource(database, "a", 2);
  assert.equal(repository.loadInputs(claimed.claim)[0]?.sourceSummary, "summary a v1");
  assert.deepEqual(repository.claim("worker-2", 101), {
    status: "skipped",
    reason: "running",
  });
  assert.equal(repository.succeed(claimed.claim, new Map(), 102), true);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, input_watermark, last_success_watermark
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "pending",
    input_watermark: 2,
    last_success_watermark: 1,
  });
  assert.equal(repository.heartbeat(claimed.claim, 103), false);

  const next = repository.claim("worker-2", 1_103);
  assert.equal(next.status, "claimed");
  if (next.status !== "claimed") return;
  assert.equal(repository.loadInputs(next.claim)[0]?.sourceSummary, "summary a v2");
  const reclaimed = repository.claim("worker-3", next.claim.leaseUntil);
  assert.equal(reclaimed.status, "claimed");
  if (reclaimed.status !== "claimed") return;
  assert.equal(repository.succeed(next.claim, new Map(), next.claim.leaseUntil), false);
});

test("limits only changed sources while retaining the complete baseline", async (t) => {
  const { database, repository } = await fixture(t);
  for (const key of ["a", "b", "c"]) addSource(database, key);
  const first = repository.claim("worker-1", 100);
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  assert.deepEqual(repository.loadInputs(first.claim).map(({ sourceKey }) => sourceKey), ["a", "b"]);
  assert.equal(first.claim.processedWatermark, 2);
  assert.equal(repository.succeed(first.claim, new Map(), 101), true);

  const second = repository.claim("worker-2", 1_102);
  assert.equal(second.status, "claimed");
  if (second.status !== "claimed") return;
  assert.deepEqual(repository.loadInputs(second.claim).map(({ sourceKey, state }) => [sourceKey, state]), [
    ["a", "retained"],
    ["b", "retained"],
    ["c", "added"],
  ]);
  assert.equal(repository.succeed(second.claim, new Map(), 1_103), true);

  addSource(database, "a", 2);
  addSource(database, "b", 2);
  addSource(database, "d");
  const limitedConfig: MemoryConfig = {
    ...config,
    consolidation: { ...config.consolidation, maxChangedSourcesPerRun: 1 },
  };
  const limited = new ConsolidationRepository(database, limitedConfig);
  const third = limited.claim("worker-3", 2_104);
  assert.equal(third.status, "claimed");
  if (third.status !== "claimed") return;
  const inputs = limited.loadInputs(third.claim);
  assert.equal(inputs.filter(({ state }) => state === "added").length, 1);
  assert.equal(inputs.filter(({ state }) => state === "retained").length, 2);
  assert.equal(inputs.some(({ sourceKey }) => sourceKey === "c"), true);
  assert.equal(third.claim.processedWatermark < third.claim.frozenWatermark, true);
});

test("emits removal only after the underlying source is explicitly deactivated", async (t) => {
  const { database, repository } = await fixture(t);
  addSource(database, "a");
  const first = repository.claim("worker-1", 100);
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  assert.equal(repository.succeed(first.claim, new Map([["task-a", ["a"]]]), 101), true);

  assert.deepEqual(repository.claim("worker-2", 1_102), {
    status: "skipped",
    reason: "up_to_date",
  });
  database.transaction(() => {
    deactivateMemorySourcesByEvidenceInTransaction(
      database,
      ["turn:a"],
      config.worker.maxAttempts,
    );
  });
  const removal = repository.claim("worker-2", 1_103);
  assert.equal(removal.status, "claimed");
  if (removal.status !== "claimed") return;
  assert.deepEqual(repository.loadInputs(removal.claim).map(({ sourceKey, state }) => [
    sourceKey,
    state,
  ]), [["a", "removed"]]);
  assert.deepEqual(repository.activeEvidenceManifest(removal.claim), []);
});

test("backs off failures and keeps the six-hour-style success cooldown", async (t) => {
  const { database, repository } = await fixture(t);
  addSource(database, "a");
  let claimed = repository.claim("worker-1", 100);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(repository.fail(claimed.claim, "model failed", 101), true);
  assert.deepEqual(repository.claim("worker-2", 1_100), {
    status: "skipped",
    reason: "retry",
  });
  claimed = repository.claim("worker-2", 1_101);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(repository.succeed(claimed.claim, new Map(), 1_102), true);
  addSource(database, "b");
  assert.deepEqual(repository.claim("worker-3", 2_101), {
    status: "skipped",
    reason: "cooldown",
  });
  assert.equal(repository.claim("worker-3", 2_102).status, "claimed");
});
