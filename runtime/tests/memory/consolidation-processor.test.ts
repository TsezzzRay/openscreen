import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";

import type { MemoryConfig } from "../../src/memory/config.js";
import {
  processConsolidation,
} from "../../src/memory/consolidate/processor.js";
import { ConsolidationRepository } from "../../src/memory/consolidate/repository.js";
import {
  recordMemorySourceInTransaction,
} from "../../src/memory/consolidate/source-repository.js";
import {
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
} from "../../src/memory/consolidate/workspace.js";
import { openMemoryDatabase } from "../../src/memory/database.js";

const execFileAsync = promisify(execFile);
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
    maxChangedSourcesPerRun: 10,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    summaryMaxTokens: 1_000,
    cooldownMilliseconds: 1_000,
  },
  retention: {
    chronicleUnreferencedMilliseconds: 90 * 24 * 60 * 60 * 1_000,
  },
};
const output = {
  task_groups: [{
    key: "openscreen-memory",
    title: "OpenScreen Memory",
    scope: { type: "project", key: "openscreen", label: "OpenScreen" },
    applies_to: ["/workspace/openscreen"],
    tasks: [{
      key: "use-node-sqlite",
      title: "Use node:sqlite",
      outcome: "success",
      rollout_summary_files: ["rollout_summaries/turn-a.md"],
      keywords: ["node:sqlite", "记住"],
      user_preferences: [],
      reusable_knowledge: ["Use node:sqlite for the Memory database."],
      failure_lessons: [],
    }],
  }],
  summary: {
    user_profile: [],
    user_preferences: [],
    general_tips: ["Search Memory before changing persistence."],
    recent_memory: [{
      date: "2026-08-15",
      scope: "project:openscreen",
      text: "OpenScreen Memory uses node:sqlite.",
      task_group_keys: ["openscreen-memory"],
    }],
    older_memory_topics: [],
  },
};
const model = {
  id: "memory-model",
  api: "anthropic-messages",
} as Model<"anthropic-messages">;

function models(
  beforeResponse?: () => void,
): {
  models: Models;
  context: () => Context | undefined;
  options: () => (SimpleStreamOptions & { toolChoice?: unknown }) | undefined;
  calls: () => number;
} {
  let seenContext: Context | undefined;
  let seen: (SimpleStreamOptions & { toolChoice?: unknown }) | undefined;
  let count = 0;
  return {
    models: {
      complete: async (
        _model: Model<string>,
        context: Context,
        options?: SimpleStreamOptions & { toolChoice?: unknown },
      ) => {
        count += 1;
        seenContext = context;
        seen = options;
        beforeResponse?.();
        return {
          role: "assistant",
          content: [
            { type: "text", text: "Submitting the consolidated Memory." },
            {
              type: "toolCall",
              id: "consolidation-tool-call",
              name: "submit_memory_consolidation",
              arguments: output,
            },
          ],
          api: "test",
          provider: "test",
          model: "memory-model",
          usage: {
            input: 100,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 200,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
      },
      completeSimple: async () => assert.fail("Anthropic consolidation must force its tool choice"),
    } as unknown as Models,
    context: () => seenContext,
    options: () => seen,
    calls: () => count,
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-consolidation-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  await prepareMemoryWorkspace(root);
  const rolloutContent = "# node:sqlite\n";
  database.transaction(() => {
    recordMemorySourceInTransaction(database, {
      sourceKey: "turn:a",
      kind: "turn_memory",
      sourceId: "batch:a",
      sourceGeneration: 1,
      sourceSummary: "The user selected node:sqlite.",
      rawMemory: "Use node:sqlite for Memory.",
      artifactPath: "rollout_summaries/turn-a.md",
      contentHash: createHash("sha256").update(rolloutContent).digest("hex"),
      startedAt: 1,
      endedAt: 2,
      provenance: "user_turn",
      supportsSuccess: true,
      sourceIds: ["turn-entry:a"],
      generatedAt: 2,
    }, config.worker.maxAttempts);
  });
  await writeFile(join(root, "raw_memories.md"), "# Raw Memories\n\nnode:sqlite\n");
  await mkdir(join(root, "rollout_summaries"));
  await writeFile(join(root, "rollout_summaries", "turn-a.md"), rolloutContent);
  return {
    root,
    database,
    repository: new ConsolidationRepository(database, config),
  };
}

test("publishes complete Memory artifacts and a parentless Git baseline", async (t) => {
  const { root, database, repository } = await fixture(t);
  const fake = models();
  const result = await processConsolidation({
    root,
    repository,
    models: fake.models,
    model,
    workerId: "worker-1",
    now: () => 100,
  });

  assert.equal(result.status, "processed");
  assert.equal(fake.options()?.maxTokens, config.consolidation.maxOutputTokens);
  assert.deepEqual(fake.options()?.toolChoice, {
    type: "tool",
    name: "submit_memory_consolidation",
  });
  assert.equal(fake.context()?.tools?.[0]?.name, "submit_memory_consolidation");
  assert.match(await readFile(join(root, "MEMORY.md"), "utf8"), /rollout_summaries\/turn-a\.md/);
  assert.match(await readFile(join(root, "memory_summary.md"), "utf8"), /^v1\n/);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
  assert.equal((await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
    cwd: root,
  })).stdout.trim(), "1");
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, last_success_watermark FROM consolidation_jobs
  `).get() }, { status: "done", last_success_watermark: 1 });
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT memory_key, source_key, artifact_path FROM memory_evidence
  `).get() }, {
    memory_key: "openscreen-memory/use-node-sqlite",
    source_key: "turn:a",
    artifact_path: "rollout_summaries/turn-a.md",
  });
});

test("keeps a source arriving during the model call for the next run", async (t) => {
  const { root, database, repository } = await fixture(t);
  const fake = models(() => {
    database.transaction(() => {
      recordMemorySourceInTransaction(database, {
        sourceKey: "turn:b",
        kind: "turn_memory",
        sourceId: "batch:b",
        sourceGeneration: 1,
        sourceSummary: "A newer source.",
        rawMemory: "newer",
        artifactPath: "rollout_summaries/turn-b.md",
        contentHash: "b".repeat(64),
        startedAt: 3,
        endedAt: 4,
        provenance: "user_turn",
        supportsSuccess: false,
        sourceIds: ["turn-entry:b"],
        generatedAt: 4,
      }, config.worker.maxAttempts);
    });
  });

  assert.equal((await processConsolidation({
    root,
    repository,
    models: fake.models,
    model,
    workerId: "worker-1",
    now: () => 100,
  })).status, "processed");

  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, input_watermark, last_success_watermark
    FROM consolidation_jobs
  `).get() }, {
    status: "pending",
    input_watermark: 2,
    last_success_watermark: 1,
  });
});

test("recovers a crash after baseline publication by finalizing SQLite", async (t) => {
  const { root, database, repository } = await fixture(t);
  const fake = models();
  const result = await processConsolidation({
    root,
    repository,
    models: fake.models,
    model,
    workerId: "worker-1",
    now: () => 100,
    onPublicationPhase: (phase) => {
      if (phase === "baseline_published") throw new Error("simulated crash");
    },
  });

  assert.deepEqual(result, { status: "processed", recovered: true });
  assert.equal(database.connection.prepare(
    "SELECT status FROM consolidation_jobs",
  ).get()?.status, "done");
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM consolidation_publications",
  ).get()?.count, 0);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
});

test("rolls back a crash before baseline publication without losing the pending source", async (t) => {
  const { root, database, repository } = await fixture(t);
  const result = await processConsolidation({
    root,
    repository,
    models: models().models,
    model,
    workerId: "worker-1",
    now: () => 100,
    onPublicationPhase: (phase) => {
      if (phase === "artifacts_published") throw new Error("simulated crash");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(database.connection.prepare(
    "SELECT status FROM consolidation_jobs",
  ).get()?.status, "pending");
  assert.equal(database.connection.prepare(
    "SELECT active FROM memory_sources WHERE source_key = 'turn:a'",
  ).get()?.active, 1);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM consolidation_publications",
  ).get()?.count, 0);
  assert.equal((await memoryWorkspaceDiff(root)).hasChanges, false);
});

test("rejects text, a wrong tool, and multiple consolidation tool calls", async (t) => {
  const toolCall = {
    type: "toolCall" as const,
    id: "consolidation-call",
    name: "submit_memory_consolidation",
    arguments: {},
  };
  const response = (content: unknown[], stopReason: "stop" | "toolUse") => ({
    role: "assistant" as const,
    content,
    api: "test",
    provider: "test",
    model: "memory-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  });
  const cases = [
    {
      name: "text",
      value: response([{ type: "text", text: "{}" }], "stop"),
      error: /exactly one consolidation tool call/i,
    },
    {
      name: "wrong tool",
      value: response([{ ...toolCall, name: "other_tool" }], "toolUse"),
      error: /unexpected consolidation tool other_tool/i,
    },
    {
      name: "multiple tools",
      value: response([toolCall, { ...toolCall, id: "second-call" }], "toolUse"),
      error: /exactly one consolidation tool call/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const { root, repository } = await fixture(subtest);
      let context: Context | undefined;
      const result = await processConsolidation({
        root,
        repository,
        models: {
          completeSimple: async (_model: Model<string>, value: Context) => {
            context = value;
            return item.value;
          },
        } as unknown as Models,
        model: { id: "generic-memory-model" } as Model<string>,
        workerId: "worker-1",
        now: () => 100,
      });
      assert.equal(context?.tools?.[0]?.name, "submit_memory_consolidation");
      assert.equal(result.status, "failed");
      assert.match(result.status === "failed" ? result.error : "", item.error);
    });
  }
});
