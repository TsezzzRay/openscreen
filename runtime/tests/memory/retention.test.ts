import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MemoryConfig } from "../../src/memory/config.js";
import {
  deactivateMemorySourceKeysInTransaction,
  recordMemorySourceInTransaction,
  type MemorySourceKind,
} from "../../src/memory/consolidate/source-repository.js";
import { prepareMemoryWorkspace } from "../../src/memory/consolidate/workspace.js";
import { openMemoryDatabase } from "../../src/memory/database.js";
import { collectMemoryGarbage } from "../../src/memory/retention.js";

const DAY = 24 * 60 * 60 * 1_000;
const config = {
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
    maxChangedSourcesPerRun: 10,
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    summaryMaxTokens: 1_000,
    cooldownMilliseconds: 1_000,
  },
  retention: { chronicleUnreferencedMilliseconds: 90 * DAY },
} satisfies MemoryConfig;

test("collects only unreferenced expired Chronicle and inactive Turn rollouts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  await prepareMemoryWorkspace(root);
  await mkdir(join(root, "rollout_summaries"));
  const now = 100 * DAY;

  function add(key: string, kind: MemorySourceKind, endedAt: number): void {
    database.transaction(() => {
      recordMemorySourceInTransaction(database, {
        sourceKey: key,
        kind,
        sourceId: `source:${key}`,
        sourceGeneration: 1,
        sourceSummary: key,
        rawMemory: kind === "turn_memory" ? key : null,
        artifactPath: `rollout_summaries/${key}.md`,
        contentHash: "a".repeat(64),
        startedAt: endedAt - 1,
        endedAt,
        provenance: kind === "turn_memory" ? "user_turn" : "passive_screen",
        supportsSuccess: false,
        sourceIds: [`evidence:${key}`],
        generatedAt: endedAt,
      }, config.worker.maxAttempts);
    });
  }
  for (const [key, kind, endedAt] of [
    ["chronicle-90", "chronicle", now - 90 * DAY],
    ["chronicle-89", "chronicle", now - 90 * DAY + 1],
    ["chronicle-protected", "chronicle", now - 91 * DAY],
    ["turn-gone", "turn_memory", now - DAY],
    ["turn-protected", "turn_memory", now - DAY],
  ] as const) {
    add(key, kind, endedAt);
    await writeFile(join(root, "rollout_summaries", `${key}.md`), `${key}\n`);
  }
  database.transaction(() => {
    deactivateMemorySourceKeysInTransaction(
      database,
      ["turn-gone", "turn-protected"],
      config.worker.maxAttempts,
    );
    database.connection.prepare(`
      INSERT INTO memory_evidence (memory_key, source_key, artifact_path)
      VALUES ('protected-chronicle', 'chronicle-protected',
              'rollout_summaries/chronicle-protected.md'),
             ('protected-turn', 'turn-protected',
              'rollout_summaries/turn-protected.md')
    `).run();
  });

  assert.deepEqual(await collectMemoryGarbage({ root, database, config, now }), [
    "chronicle-90",
    "turn-gone",
  ]);
  await assert.rejects(access(join(root, "rollout_summaries", "chronicle-90.md")));
  await assert.rejects(access(join(root, "rollout_summaries", "turn-gone.md")));
  for (const key of ["chronicle-89", "chronicle-protected", "turn-protected"]) {
    await access(join(root, "rollout_summaries", `${key}.md`));
  }

  database.connection.prepare("DELETE FROM memory_evidence").run();
  assert.deepEqual(await collectMemoryGarbage({ root, database, config, now }), [
    "chronicle-protected",
    "turn-protected",
  ]);
});
