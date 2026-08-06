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
  validateConsolidationEvidence,
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
    INSERT INTO turn_memory_sources (
      id, source_key, session_id, turn_id, occurred_at,
      projection_json, ingested_at
    ) VALUES ('turn:1', 'turn:1', 'session:1', 'turn:1', 1, '{}', 1)
  `).run();
  connection.prepare(`
    INSERT INTO turn_memory_batches (
      id, session_id, first_pending_at, last_terminal_at, eligible_at,
      status, close_reason, max_input_tokens, source_generation,
      created_at, updated_at
    ) VALUES (
      'batch:1', 'session:1', 1, 1, 1, 'sealed', 'idle', 8000, 1, 1, 1
    )
  `).run();
  connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining
    ) VALUES (
      'turn-memory:batch:1', 'turn_memory_extraction', 'batch:1', 1,
      'succeeded', 1, 3
    )
  `).run();
  connection.prepare(`
    INSERT INTO turn_memory_extractions (
      job_key, source_generation, source_updated_at, raw_memory,
      turn_summary, turn_slug, generated_at
    ) VALUES (
      'turn-memory:batch:1', 1, 1,
      'The user is building the OpenScreen memory pipeline.',
      'The user reviewed the OpenScreen memory design.',
      'openscreen-memory-design', 100000
    )
  `).run();
  connection.prepare(`
    INSERT INTO turn_memory_extraction_sources (job_key, source_id)
    VALUES ('turn-memory:batch:1', 'turn:1')
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

test("does not consolidate a Turn summary without durable raw memory", async (t) => {
  const { database, repository } = await fixture(t);
  database.connection.prepare(`
    UPDATE turn_memory_extractions
    SET raw_memory = ''
    WHERE job_key = 'turn-memory:batch:1'
  `).run();

  const claimed = repository.claim("worker-1", 2);

  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.deepEqual(repository.loadInputs(claimed.claim), []);
});

test("validates structured consolidation output and renders current Markdown", () => {
  const output = parseConsolidationOutput(JSON.stringify({
    memories: [{
      key: "openscreen-memory-pipeline",
      title: "OpenScreen memory pipeline",
      scope: { type: "topic", key: "openscreen-memory", label: "OpenScreen Memory" },
      content: "The user is building the OpenScreen memory pipeline.",
      evidence_source_ids: ["turn-memory:batch:1"],
    }],
    summary: [{
      memory_key: "openscreen-memory-pipeline",
      text: "OpenScreen memory pipeline design and decisions.",
    }],
  }), new Set(["turn-memory:batch:1"]));
  const rendered = renderConsolidatedMemory(output);

  assert.match(rendered.memory, /^# OpenScreen Memory/m);
  assert.match(rendered.memory, /scope: topic:openscreen-memory/);
  assert.match(rendered.memory, /evidence: turn-memory:batch:1/);
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
  }), new Set(["turn-memory:batch:1"])), /unsupported memory scope|unknown evidence/);
});

test("requires corroboration before passive Chronicle evidence becomes durable Memory", () => {
  const output = parseConsolidationOutput(JSON.stringify({
    memories: [{
      key: "screen-fact",
      title: "Screen fact",
      scope: { type: "topic", key: "screen-fact" },
      content: "A durable fact inferred from the screen.",
      evidence_source_ids: ["chronicle:one"],
    }],
    summary: [],
  }), new Set(["chronicle:one"]));

  assert.throws(() => validateConsolidationEvidence(output, new Map([
    ["chronicle:one", "passive_screen"],
  ])), /passive Chronicle evidence requires corroboration/i);
  assert.doesNotThrow(() => validateConsolidationEvidence(output, new Map([
    ["chronicle:one", "user_turn"],
  ])));
});

test("consolidates Memory source inputs, publishes fenced artifacts, and resets the baseline", async (t) => {
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
      create: async (request: {
        instructions: string;
        text?: { format?: { type?: string; strict?: boolean } };
      }) => {
        generations += 1;
        assert.match(request.instructions, /passive screen content/i);
        assert.match(request.instructions, /conflict/i);
        assert.equal(request.text?.format?.type, "json_schema");
        assert.equal(request.text?.format?.strict, true);
        return {
          output_text: JSON.stringify({
            memories: [{
              key: "openscreen-memory-pipeline",
              title: "OpenScreen memory pipeline",
              scope: { type: "topic", key: "openscreen-memory" },
              content: "The user is building the OpenScreen memory pipeline.",
              evidence_source_ids: ["turn-memory:batch:1"],
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
  assert.match(await readFile(join(root, "MEMORY.md"), "utf8"), /evidence: turn-memory:batch:1/);
  assert.match(await readFile(join(root, "memory_summary.md"), "utf8"), /^v1\n/);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
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
    "SELECT count(*) AS count FROM model_attempts WHERE operation = 'global_memory_consolidation' AND status = 'succeeded'",
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
      evidenceSourceIds: ["turn-memory:batch:1"],
    }],
    summary: [{ memoryKey: "openscreen-memory", text: "OpenScreen memory work." }],
  });
  await writeFile(join(root, "MEMORY.md"), rendered.memory, { mode: 0o600 });
  await writeFile(join(root, "memory_summary.md"), rendered.summary, { mode: 0o600 });
  assert.equal(repository.preparePublication(stale.claim, {
    stagingName: "stale-after-baseline",
    memorySha256: "memory-hash",
    summarySha256: "summary-hash",
    evidence: { "openscreen-memory": ["turn-memory:batch:1"] },
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
            evidence_source_ids: ["turn-memory:batch:1"],
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
