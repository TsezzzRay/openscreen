import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";

import type { MemoryConfig } from "../../../src/memory/config.js";
import { MemoryRuntime } from "../../../src/memory/runtime.js";

// Never actually sent; huge observationalMemory thresholds below mean no
// Observer/Reflector call is ever triggered in this test, and nothing here
// exercises Chronicle's model call either — Turn Memory no longer has its
// own extraction model call at all (that judgment now belongs to Mastra's
// Observer, exercised separately/manually in the migration's Stage A spike).
process.env.MINIMAX_CN_API_KEY ??= "test-key";
const HUGE = 100_000_000;

function runtimeConfig(): MemoryConfig {
  return {
    enabled: true,
    worker: { intervalMilliseconds: 60_000, maxChronicleWindowsPerTick: 2 },
    chronicle: {
      windowMilliseconds: 60_000,
      graceMilliseconds: 15_000,
      maxSourcesPerRequest: 10,
      maxInputTokens: 8_000,
      maxOutputTokens: 2_000,
    },
    observationalMemory: {
      interactive: { messageTokens: HUGE, observationTokens: HUGE },
      screenActivity: { messageTokens: HUGE, observationTokens: HUGE },
    },
    retention: { chronicleRolloutMaxAgeMilliseconds: 90 * 24 * 60 * 60_000 },
  };
}

const unusedModels = {
  complete: async () => assert.fail("no Chronicle model call expected in this test"),
  completeSimple: async () => assert.fail("no Chronicle model call expected in this test"),
} as unknown as Models;
const unusedModel = { id: "unused" } as Model<string>;

test("scans a completed Turn, writes it to Mastra, and archives its rollout — no extraction model call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-memory-runtime-"));
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
  const answer = fauxAssistantMessage("Implemented with node:sqlite.");
  answer.timestamp = Date.parse("2026-08-15T10:00:01.000Z");
  await session.appendMessage(answer);

  const memoryRoot = join(root, "memory");
  let now = Date.now();
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot,
    memoryRoot,
    env,
    models: unusedModels,
    model: unusedModel,
    agent: { provider: "minimax-cn", model: "test-model" },
    config: runtimeConfig(),
    gitBranch: async () => "feature/memory",
    now: () => now,
  });
  t.after(() => runtime.stop());

  await runtime.start();
  now += 11;
  await runtime.runOnce();

  const [rolloutName] = await readdir(join(memoryRoot, "rollout_summaries"));
  assert.ok(rolloutName?.startsWith("turn-"));
  const rollout = await readFile(join(memoryRoot, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /记住使用 node:sqlite/);
  assert.match(rollout, /Implemented with node:sqlite\./);
  assert.match(rollout, /rollout_id: turn:/);

  // Huge thresholds mean observe() no-ops, so MEMORY.md exists but is empty —
  // proves the write actually reached Mastra (a thread was created and a
  // message saved) and the projector ran without erroring.
  assert.equal(await readFile(join(memoryRoot, "MEMORY.md"), "utf8"), "");

  await runtime.stop();
  const restarted = new MemoryRuntime({
    cwd: root,
    sessionsRoot,
    memoryRoot,
    env,
    models: unusedModels,
    model: unusedModel,
    agent: { provider: "minimax-cn", model: "test-model" },
    config: runtime.config,
    gitBranch: async () => "feature/memory",
    now: () => now,
  });
  t.after(() => restarted.stop());
  await restarted.start();
  await restarted.runOnce();
  // Same Turn, already scanned: no new rollout file.
  const rolloutsAfterRestart = await readdir(join(memoryRoot, "rollout_summaries"));
  assert.equal(rolloutsAfterRestart.length, 1);
});

test("notifySession scans on demand without waiting for the interval tick", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-turn-memory-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  const sessionsRoot = join(root, "sessions");
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
  const session = await repo.create({ cwd: root });
  const metadata = await session.getMetadata();
  await session.appendMessage({
    role: "user",
    content: "Ping",
    timestamp: Date.parse("2026-08-15T10:00:00.000Z"),
  });
  const answer = fauxAssistantMessage("Pong.");
  answer.timestamp = Date.parse("2026-08-15T10:00:01.000Z");
  await session.appendMessage(answer);

  const memoryRoot = join(root, "memory");
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot,
    memoryRoot,
    env,
    models: unusedModels,
    model: unusedModel,
    agent: { provider: "minimax-cn", model: "test-model" },
    config: runtimeConfig(),
    gitBranch: async () => "feature/memory",
    now: () => Date.now(),
  });
  t.after(() => runtime.stop());
  await runtime.start();

  await runtime.notifySession(metadata.id);
  const [rolloutName] = await readdir(join(memoryRoot, "rollout_summaries"));
  assert.ok(rolloutName?.startsWith("turn-"));
});
