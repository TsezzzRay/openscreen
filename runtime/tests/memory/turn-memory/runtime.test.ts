import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  MemoryRuntime,
} from "../../../src/memory/runtime.js";

test("scans Pi Sessions, processes due batches, and recovers pending artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  const sessionsRoot = join(root, "sessions");
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
  const session = await repo.create({ cwd: root });
  await session.appendMessage({
    role: "user",
    content: "记住使用 node:sqlite",
    timestamp: Date.parse("2026-08-15T10:00:00.000Z"),
  });
  const answer = fauxAssistantMessage("Implemented.");
  answer.timestamp = Date.parse("2026-08-15T10:00:01.000Z");
  await session.appendMessage(answer);

  const faux = fauxProvider({
    provider: `faux-${Math.random().toString(36).slice(2)}`,
    models: [{ id: "memory-model" }],
  });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_turn_memory", {
    raw_memory: "The project uses node:sqlite.",
    turn_summary: "The user requested node:sqlite and it was implemented.",
    turn_slug: "use-node-sqlite",
    tasks: [{
      title: "Use node:sqlite",
      outcome: "success",
      preference_signals: [],
      reusable_knowledge: ["Use node:sqlite for the Memory database."],
      failure_lessons: [],
      references: [],
      keywords: ["node:sqlite", "记住"],
    }],
  }), { stopReason: "toolUse" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  let now = Date.now();
  const memoryRoot = join(root, "memory");
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot,
    memoryRoot,
    env,
    models,
    model: faux.getModel(),
    config: {
      enabled: true,
      worker: {
        intervalMilliseconds: 60_000,
        maxJobsPerTick: 2,
        leaseMilliseconds: 10_000,
        retryDelayMilliseconds: 1_000,
        maxAttempts: 3,
      },
      turnMemory: {
        maxInputTokens: 8_000,
        maxOutputTokens: 2_000,
        idleMilliseconds: 10,
        hardCapMilliseconds: 1_000,
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
      retention: {
        chronicleUnreferencedMilliseconds: 90 * 24 * 60 * 60 * 1_000,
      },
    },
    gitBranch: async () => "feature/memory",
    now: () => now,
  });
  t.after(() => runtime.stop());

  await runtime.start();
  now += 11;
  await runtime.runOnce();

  assert.match(
    await readFile(join(memoryRoot, "raw_memories.md"), "utf8"),
    /node:sqlite/,
  );
  assert.equal(faux.state.callCount, 1);
  const [rollout] = await readdir(join(memoryRoot, "rollout_summaries"));
  assert.ok(rollout);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_memory_consolidation", {
    task_groups: [{
      key: "openscreen-memory",
      title: "OpenScreen Memory",
      scope: { type: "project", key: "openscreen", label: "OpenScreen" },
      applies_to: [root],
      tasks: [{
        key: "use-node-sqlite",
        title: "Use node:sqlite",
        outcome: "success",
        rollout_summary_files: [`rollout_summaries/${rollout}`],
        keywords: ["node:sqlite", "记住"],
        user_preferences: [],
        reusable_knowledge: ["Use node:sqlite for Memory."],
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
  }), { stopReason: "toolUse" })]);
  await runtime.runOnce();
  assert.match(
    await readFile(join(memoryRoot, "MEMORY.md"), "utf8"),
    /node:sqlite/,
  );
  assert.equal(faux.state.callCount, 2);
  await runtime.stop();

  const restarted = new MemoryRuntime({
    cwd: root,
    sessionsRoot,
    memoryRoot,
    env,
    models,
    model: faux.getModel(),
    config: runtime.config,
    gitBranch: async () => "feature/memory",
    now: () => now,
  });
  t.after(() => restarted.stop());
  await restarted.start();
  assert.equal(faux.state.callCount, 2);
});
