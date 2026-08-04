import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  parseConsolidationOutput,
  processConsolidation,
  renderConsolidatedMemory,
} from "../../src/harness/memory/consolidate/processor.js";
import {
  ConsolidationRepository,
} from "../../src/harness/memory/consolidate/repository.js";
import {
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  resetMemoryWorkspaceBaseline,
  syncConsolidationInputs,
} from "../../src/harness/memory/consolidate/workspace.js";
import { testMemoryConfig } from "./test-config.js";

const memory = testMemoryConfig();

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-consolidation-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const connection = database.connection;
  connection.prepare(`
    INSERT INTO source_items (
      id, source_type, source_key, occurred_at, projection_json, ingested_at
    ) VALUES ('observation:1', 'observation', 'observation:1', 1, '{}', 1)
  `).run();
  connection.prepare(`
    INSERT INTO observation_windows (
      id, start_at, end_at, eligible_at, source_generation, created_at, updated_at
    ) VALUES ('window:1', 0, 60000, 75000, 1, 1, 1)
  `).run();
  connection.prepare(`
    INSERT INTO observation_window_sources (window_id, source_id, ordinal)
    VALUES ('window:1', 'observation:1', 0)
  `).run();
  connection.prepare(`
    INSERT INTO activity_jobs (
      job_key, source_kind, source_id, source_generation, status,
      eligible_at, retry_remaining
    ) VALUES (
      'activity:window:1', 'observation_window', 'window:1', 1,
      'succeeded', 75000, 3
    )
  `).run();
  connection.prepare(`
    INSERT INTO activity_summaries (
      job_key, source_generation, source_updated_at, source_summary,
      raw_memory, scope_json, generated_at
    ) VALUES (
      'activity:window:1', 1, 1,
      'The user reviewed the OpenScreen memory design.',
      'The user is building the OpenScreen memory pipeline.',
      '[{"type":"topic","key":"openscreen-memory"}]', 100000
    )
  `).run();
  connection.prepare(`
    INSERT INTO activity_summary_sources (job_key, source_id)
    VALUES ('activity:window:1', 'observation:1')
  `).run();
  connection.prepare(`
    INSERT INTO consolidation_jobs (
      job_key, status, retry_remaining, input_watermark,
      last_success_watermark
    ) VALUES ('global', 'pending', 3, 1, 0)
  `).run();
  return {
    root,
    database,
    repository: new ConsolidationRepository(database, memory),
  };
}

test("validates structured consolidation output and renders current Markdown", () => {
  const output = parseConsolidationOutput(JSON.stringify({
    memories: [{
      key: "openscreen-memory-pipeline",
      title: "OpenScreen memory pipeline",
      scope: { type: "topic", key: "openscreen-memory", label: "OpenScreen Memory" },
      content: "The user is building the OpenScreen memory pipeline.",
      evidence_source_ids: ["activity:window:1"],
    }],
    summary: [{
      memory_key: "openscreen-memory-pipeline",
      text: "OpenScreen memory pipeline design and decisions.",
    }],
  }), new Set(["activity:window:1"]));
  const rendered = renderConsolidatedMemory(output);

  assert.match(rendered.memory, /^# OpenScreen Memory/m);
  assert.match(rendered.memory, /scope: topic:openscreen-memory/);
  assert.match(rendered.memory, /evidence: activity:window:1/);
  assert.match(rendered.summary, /^v1\n/);
  assert.match(rendered.summary, /openscreen-memory-pipeline/);

  assert.throws(() => parseConsolidationOutput(JSON.stringify({
    memories: [{
      key: "bad",
      title: "Bad",
      scope: { type: "cwd", key: "/repo" },
      content: "Bad",
      evidence_source_ids: ["unknown"],
    }],
    summary: [],
  }), new Set(["activity:window:1"])), /unsupported memory scope|unknown evidence/);
});

test("consolidates Activity inputs, publishes fenced artifacts, and resets the baseline", async (t) => {
  const { root, database, repository } = await fixture(t);
  let generations = 0;
  let countedInput = "";
  const client = {
    responses: {
      inputTokens: {
        count: async (request: { input: Array<{ content: string }> }) => {
          countedInput = request.input[0]?.content ?? "";
          return { input_tokens: 500 };
        },
      },
      create: async (request: { instructions: string }) => {
        generations += 1;
        assert.match(request.instructions, /passive screen content/i);
        assert.match(request.instructions, /conflict/i);
        return {
          output_text: JSON.stringify({
            memories: [{
              key: "openscreen-memory-pipeline",
              title: "OpenScreen memory pipeline",
              scope: { type: "topic", key: "openscreen-memory" },
              content: "The user is building the OpenScreen memory pipeline.",
              evidence_source_ids: ["activity:window:1"],
            }],
            summary: [{
              memory_key: "openscreen-memory-pipeline",
              text: "OpenScreen memory pipeline work.",
            }],
          }),
          usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
        };
      },
    },
  } as unknown as OpenAI;
  const now = Date.parse("2026-08-04T12:00:00.000Z");

  const result = await processConsolidation({
    root,
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => now,
  });

  assert.equal(result.status, "processed");
  assert.equal(generations, 1);
  assert.match(countedInput, /workspaceDiff/);
  assert.match(countedInput, /OpenScreen memory pipeline/);
  assert.match(await readFile(join(root, "MEMORY.md"), "utf8"), /evidence: activity:window:1/);
  assert.match(await readFile(join(root, "memory_summary.md"), "utf8"), /^v1\n/);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
  assert.equal((await memoryWorkspaceDiff(root)).commitCount, 1);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, last_success_watermark FROM consolidation_jobs
    WHERE job_key = 'global'
  `).get() }, { status: "done", last_success_watermark: 1 });
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM memory_evidence WHERE memory_key = ?",
  ).get("openscreen-memory-pipeline")?.count, 1);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM consolidation_publications",
  ).get()?.count, 0);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM model_attempts WHERE stage = 'consolidation' AND status = 'succeeded'",
  ).get()?.count, 1);
});

test("uses the injected clock for Consolidation heartbeats", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { root, repository } = await fixture(t);
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  let heartbeatAt: number | undefined;
  repository.heartbeat = (_claim, at = Date.now()) => {
    heartbeatAt = at;
    return true;
  };
  let started!: () => void;
  const counting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    responses: {
      inputTokens: { count: async () => {
        started();
        await released;
        return { input_tokens: 100 };
      } },
      create: async () => ({
        output_text: JSON.stringify({ memories: [], summary: [] }),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
    },
  } as unknown as OpenAI;

  const processing = processConsolidation({
    root,
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => now,
  });
  await counting;
  t.mock.timers.tick(90_000);

  assert.equal(heartbeatAt, now);
  release();
  assert.equal((await processing).status, "processed");
});

test("skips the model when synced inputs match a valid Git baseline", async (t) => {
  const { root, database, repository } = await fixture(t);
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async () => ({ output_text: "{}" }),
    },
  } as unknown as OpenAI;
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const first = await processConsolidation({
    root,
    repository,
    client: {
      responses: {
        inputTokens: { count: async () => ({ input_tokens: 100 }) },
        create: async () => ({
          output_text: JSON.stringify({ memories: [], summary: [] }),
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        }),
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => now,
  });
  assert.equal(first.status, "processed");
  database.connection.prepare(`
    UPDATE consolidation_jobs SET status = 'pending', finished_at = NULL
    WHERE job_key = 'global'
  `).run();
  let generations = 0;
  (client.responses.create as unknown as () => Promise<unknown>) = async () => {
    generations += 1;
    return { output_text: "{}" };
  };

  const second = await processConsolidation({
    root,
    repository,
    client,
    model: "summary-model",
    workerId: "worker-2",
    contextWindowTokens: 10_000,
    now: () => now + 1,
  });

  assert.equal(second.status, "no_changes");
  assert.equal(generations, 0);
});

test("keeps a complete over-budget Consolidation diff retryable without advancing the baseline", async (t) => {
  const { root, database, repository } = await fixture(t);
  let generations = 0;
  const result = await processConsolidation({
    root,
    repository,
    client: {
      responses: {
        inputTokens: { count: async () => ({ input_tokens: 8_001 }) },
        create: async () => {
          generations += 1;
          return { output_text: "{}" };
        },
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => Date.parse("2026-08-04T12:00:00.000Z"),
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /8001 > 8000/);
  assert.equal(generations, 0);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, true);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, last_success_watermark FROM consolidation_jobs
    WHERE job_key = 'global'
  `).get() }, { status: "error", last_success_watermark: 0 });
});

test("recovers a partially published stale owner from the Git baseline", async (t) => {
  const { root, repository } = await fixture(t);
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  await prepareMemoryWorkspace(root);
  const stale = repository.claim("stale-worker", startedAt);
  assert.equal(stale.status, "claimed");
  if (stale.status !== "claimed") return;
  await syncConsolidationInputs(root, repository.loadInputs(stale.claim));
  await writeFile(join(root, "MEMORY.md"), "stale partial publication\n", { mode: 0o600 });
  assert.equal(repository.preparePublication(stale.claim, {
    stagingName: "stale-staging",
    memorySha256: "stale-memory",
    summarySha256: "stale-summary",
    evidence: {},
    createdAt: startedAt,
  }, startedAt), true);
  assert.equal(repository.beginPublication(stale.claim, startedAt), true);

  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async () => ({
        output_text: JSON.stringify({ memories: [], summary: [] }),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
    },
  } as unknown as OpenAI;
  const result = await processConsolidation({
    root,
    repository,
    client,
    model: "summary-model",
    workerId: "replacement-worker",
    contextWindowTokens: 10_000,
    now: () => startedAt + memory.worker.leaseMilliseconds,
  });

  assert.equal(result.status, "processed");
  assert.doesNotMatch(await readFile(join(root, "MEMORY.md"), "utf8"), /stale partial/);
  assert.equal(repository.publication(), null);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
});

test("restores evidence if a crash happens after the Git baseline reset", async (t) => {
  const { root, database, repository } = await fixture(t);
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  await prepareMemoryWorkspace(root);
  const stale = repository.claim("stale-worker", startedAt);
  assert.equal(stale.status, "claimed");
  if (stale.status !== "claimed") return;
  await syncConsolidationInputs(root, repository.loadInputs(stale.claim));
  const rendered = renderConsolidatedMemory({
    memories: [{
      key: "openscreen-memory",
      title: "OpenScreen memory",
      scope: { type: "topic", key: "openscreen-memory" },
      content: "The user is building OpenScreen memory.",
      evidenceSourceIds: ["activity:window:1"],
    }],
    summary: [{ memoryKey: "openscreen-memory", text: "OpenScreen memory work." }],
  });
  await writeFile(join(root, "MEMORY.md"), rendered.memory, { mode: 0o600 });
  await writeFile(join(root, "memory_summary.md"), rendered.summary, { mode: 0o600 });
  assert.equal(repository.preparePublication(stale.claim, {
    stagingName: "stale-after-baseline",
    memorySha256: "memory-hash",
    summarySha256: "summary-hash",
    evidence: { "openscreen-memory": ["activity:window:1"] },
    createdAt: startedAt,
  }, startedAt), true);
  assert.equal(repository.beginPublication(stale.claim, startedAt), true);
  await resetMemoryWorkspaceBaseline(root);

  let generations = 0;
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async () => {
        generations += 1;
        return { output_text: "{}" };
      },
    },
  } as unknown as OpenAI;
  const result = await processConsolidation({
    root,
    repository,
    client,
    model: "summary-model",
    workerId: "replacement-worker",
    contextWindowTokens: 10_000,
    now: () => startedAt + memory.worker.leaseMilliseconds,
  });

  assert.equal(result.status, "no_changes");
  assert.equal(generations, 0);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM memory_evidence
    WHERE memory_key = 'openscreen-memory'
  `).get()?.count, 1);
  assert.equal(repository.publication(), null);
});

test("retains publication evidence when SQLite completion fails after the new baseline", async (t) => {
  const { root, database, repository } = await fixture(t);
  const startedAt = Date.parse("2026-08-04T12:00:00.000Z");
  class CommitFailureRepository extends ConsolidationRepository {
    override finalizePublication(
      claim: Parameters<ConsolidationRepository["finalizePublication"]>[0],
      finishedAt: number,
      evidence: Parameters<ConsolidationRepository["finalizePublication"]>[2],
      publish: () => void,
    ): boolean {
      void claim;
      void finishedAt;
      void evidence;
      publish();
      throw new Error("simulated SQLite commit failure");
    }
  }
  const failing = new CommitFailureRepository(database, memory);
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async () => ({
        output_text: JSON.stringify({
          memories: [{
            key: "openscreen-memory",
            title: "OpenScreen memory",
            scope: { type: "topic", key: "openscreen-memory" },
            content: "The user is building OpenScreen memory.",
            evidence_source_ids: ["activity:window:1"],
          }],
          summary: [{
            memory_key: "openscreen-memory",
            text: "OpenScreen memory work.",
          }],
        }),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
    },
  } as unknown as OpenAI;

  const first = await processConsolidation({
    root,
    repository: failing,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => startedAt,
  });
  assert.equal(first.status, "failed");
  assert.notEqual(repository.publication(), null);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);

  let retryGenerations = 0;
  const second = await processConsolidation({
    root,
    repository,
    client: {
      responses: {
        inputTokens: { count: async () => ({ input_tokens: 100 }) },
        create: async () => {
          retryGenerations += 1;
          return { output_text: "{}" };
        },
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "worker-2",
    contextWindowTokens: 10_000,
    now: () => startedAt + memory.worker.retryDelayMilliseconds,
  });

  assert.equal(second.status, "no_changes");
  assert.equal(retryGenerations, 0);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM memory_evidence
    WHERE memory_key = 'openscreen-memory'
  `).get()?.count, 1);
  assert.equal(repository.publication(), null);
});
