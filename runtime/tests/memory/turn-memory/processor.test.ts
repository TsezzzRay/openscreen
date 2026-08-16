import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Context,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import {
  projectPendingMemoryArtifacts,
} from "../../../src/memory/artifact-projector.js";
import {
  processNextTurnMemory,
} from "../../../src/memory/turn-memory/processor.js";
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

function source(status: TurnMemorySource["status"] = "completed"): TurnMemorySource {
  return {
    sourceId: "turn:session-1:user-1",
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "feature/memory",
    rolloutPath: "/sessions/session-1.jsonl",
    userEntryIds: ["user-1"],
    terminalEntryId: "answer-1",
    startedAt: "2026-08-15T10:00:00.000Z",
    finishedAt: "2026-08-15T10:01:00.000Z",
    occurredAt: "2026-08-15T10:01:00.000Z",
    status,
    user: "记住项目使用 node:sqlite",
    assistant: status === "completed" ? "Implemented." : "",
    sourceFrameIds: ["screenpipe-frame-1"],
    ...(status === "failed" ? { terminalError: "test failed" } : {}),
    tools: [],
  };
}

async function fixture(t: test.TestContext, status: TurnMemorySource["status"] = "completed") {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "db"));
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, policy);
  const projection: TerminalTurnProjection = {
    sources: [source(status)],
    nextEntryId: "answer-1",
    cursorRewound: false,
  };
  repository.commitScan({
    sessionId: "session-1",
    fileVersion: "v1",
    projection,
    scannedAt: Date.parse("2026-08-15T10:01:00.000Z"),
  });
  const batch = database.connection.prepare(`
    SELECT eligible_at FROM turn_memory_batches WHERE status = 'open'
  `).get();
  assert.ok(batch);
  const due = Number(batch.eligible_at);
  repository.sealDueBatches(due);
  return { root, memoryRoot: join(root, "memory"), database, repository, due };
}

function models(
  output: unknown,
  inspect?: (context: Context, options: unknown) => void,
): Models {
  return {
    complete: async (
      _model: Model<string>,
      context: Context,
      options?: SimpleStreamOptions & { toolChoice?: unknown },
    ) => {
      inspect?.(context, options);
      return {
        role: "assistant",
        content: [
          { type: "text", text: "Submitting the extracted Turn Memory." },
          {
            type: "toolCall",
            id: "turn-memory-tool-call",
            name: "submit_turn_memory",
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
    completeSimple: async () => assert.fail("Anthropic Turn Memory must force its tool choice"),
  } as unknown as Models;
}

const model = {
  id: "memory-model",
  api: "anthropic-messages",
} as Model<"anthropic-messages">;

test("extracts Turn Memory and immediately projects searchable rollout files", async (t) => {
  const { memoryRoot, database, repository, due } = await fixture(t);
  let options: unknown;
  const result = await processNextTurnMemory({
    repository,
    models: models({
      raw_memory: "The project uses node:sqlite.",
      turn_summary: "The user selected and implemented node:sqlite.",
      turn_slug: "use-node-sqlite",
      tasks: [{
        title: "Use node:sqlite",
        outcome: "success",
        preference_signals: [],
        reusable_knowledge: ["The Memory database uses node:sqlite."],
        failure_lessons: [],
        references: ["npm run test:runtime"],
        keywords: ["node:sqlite", "项目内存", "记住"],
      }],
    }, (context, value) => {
      options = value;
      assert.equal(context.tools?.[0]?.name, "submit_turn_memory");
    }),
    model,
    workerId: "worker-1",
    memoryRoot,
    now: () => due,
  });

  assert.equal(result.status, "processed");
  assert.equal((options as { maxTokens?: number }).maxTokens, 2_000);
  assert.deepEqual((options as { toolChoice?: unknown }).toolChoice, {
    type: "tool",
    name: "submit_turn_memory",
  });
  assert.equal(database.connection.prepare(`
    SELECT status FROM memory_jobs
  `).get()?.status, "succeeded");
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT kind, provenance, active FROM memory_sources
  `).get() }, {
    kind: "turn_memory",
    provenance: "user_turn",
    active: 1,
  });
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, input_watermark, retry_remaining
    FROM consolidation_jobs WHERE job_key = 'global'
  `).get() }, {
    status: "pending",
    input_watermark: 1,
    retry_remaining: 3,
  });
  const rolloutDirectory = join(memoryRoot, "rollout_summaries");
  const rolloutFiles = await readdir(rolloutDirectory);
  assert.equal(rolloutFiles.length, 1);
  const rollout = await readFile(join(rolloutDirectory, rolloutFiles[0]!), "utf8");
  assert.match(rollout, /thread_id: session-1/);
  assert.match(rollout, /rollout_path: \/sessions\/session-1\.jsonl/);
  assert.match(rollout, /source_ids:\n- turn:session-1:user-1/);
  assert.match(rollout, /source_frame_ids:\n- screenpipe-frame-1/);
  assert.match(rollout, /Outcome: success/);
  assert.match(rollout, /项目内存|记住/);
  assert.match(await readFile(join(memoryRoot, "raw_memories.md"), "utf8"), /node:sqlite/);
  assert.equal(existsSync(join(memoryRoot, ".git")), false);
});

test("rejects a success claim for a failed-only batch", async (t) => {
  const { memoryRoot, database, repository, due } = await fixture(t, "failed");
  const result = await processNextTurnMemory({
    repository,
    models: models({
      raw_memory: "",
      turn_summary: "Succeeded.",
      turn_slug: "fix-test",
      tasks: [{
        title: "Fix test",
        outcome: "success",
        preference_signals: [],
        reusable_knowledge: [],
        failure_lessons: [],
        references: [],
        keywords: ["test"],
      }],
    }),
    model,
    workerId: "worker-1",
    memoryRoot,
    now: () => due,
  });

  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /cannot claim success/i);
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM turn_memory_extractions
  `).get()?.count, 0);
});

test("recovers filesystem projection from committed SQLite truth", async (t) => {
  const { root, repository, due } = await fixture(t);
  const blockedRoot = join(root, "blocked-memory-root");
  await writeFile(blockedRoot, "not a directory");
  const result = await processNextTurnMemory({
    repository,
    models: models({
      raw_memory: "",
      turn_summary: "The completed Turn was recorded.",
      turn_slug: "record-turn",
      tasks: [],
    }),
    model,
    workerId: "worker-1",
    memoryRoot: blockedRoot,
    now: () => due,
  });

  assert.equal(result.status, "processed");
  assert.match(
    result.status === "processed" ? result.projectionError ?? "" : "",
    /not a directory|EEXIST/i,
  );
  assert.equal(repository.pendingArtifacts().length, 2);

  await rm(blockedRoot);
  assert.equal(
    await projectPendingMemoryArtifacts(blockedRoot, repository, due + 1),
    2,
  );
  assert.equal(repository.pendingArtifacts().length, 0);
  assert.match(
    await readFile(join(blockedRoot, "raw_memories.md"), "utf8"),
    /recorded/,
  );
});

test("removes inactive Session evidence from raw memories", async (t) => {
  const { memoryRoot, repository, due } = await fixture(t);
  const result = await processNextTurnMemory({
    repository,
    models: models({
      raw_memory: "The project uses node:sqlite.",
      turn_summary: "The user selected node:sqlite.",
      turn_slug: "use-node-sqlite",
      tasks: [{
        title: "Use node:sqlite",
        outcome: "success",
        preference_signals: [],
        reusable_knowledge: ["The Memory database uses node:sqlite."],
        failure_lessons: [],
        references: [],
        keywords: ["node:sqlite"],
      }],
    }),
    model,
    workerId: "worker-1",
    memoryRoot,
    now: () => due,
  });
  assert.equal(result.status, "processed");
  assert.match(
    await readFile(join(memoryRoot, "raw_memories.md"), "utf8"),
    /node:sqlite/,
  );

  assert.equal(repository.reconcileSessions([], due + 1), 1);
  assert.equal(
    await projectPendingMemoryArtifacts(memoryRoot, repository, due + 1),
    1,
  );
  assert.doesNotMatch(
    await readFile(join(memoryRoot, "raw_memories.md"), "utf8"),
    /node:sqlite/,
  );
});

test("reclaims an expired worker lease after restart", async (t) => {
  const { repository, due } = await fixture(t);
  const first = repository.claimNext({ workerId: "worker-1", now: due });
  assert.ok(first);
  const second = repository.claimNext({
    workerId: "worker-2",
    now: due + policy.worker.leaseMilliseconds + 1,
  });
  assert.ok(second);
  assert.equal(second.workerId, "worker-2");
  assert.notEqual(second.ownershipToken, first.ownershipToken);
});

test("rejects text, a wrong tool, and multiple Turn Memory tool calls", async (t) => {
  const toolCall = {
    type: "toolCall" as const,
    id: "turn-memory-call",
    name: "submit_turn_memory",
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
      error: /exactly one Turn Memory tool call/i,
    },
    {
      name: "wrong tool",
      value: response([{ ...toolCall, name: "other_tool" }], "toolUse"),
      error: /unexpected Turn Memory tool other_tool/i,
    },
    {
      name: "multiple tools",
      value: response([toolCall, { ...toolCall, id: "second-call" }], "toolUse"),
      error: /exactly one Turn Memory tool call/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const { memoryRoot, repository, due } = await fixture(subtest);
      let context: Context | undefined;
      const result = await processNextTurnMemory({
        repository,
        models: {
          completeSimple: async (_model: Model<string>, value: Context) => {
            context = value;
            return item.value;
          },
        } as unknown as Models,
        model: { id: "generic-memory-model" } as Model<string>,
        workerId: "worker-1",
        memoryRoot,
        now: () => due,
      });
      assert.equal(context?.tools?.[0]?.name, "submit_turn_memory");
      assert.equal(result.status, "failed");
      assert.match(result.status === "failed" ? result.error : "", item.error);
    });
  }
});
