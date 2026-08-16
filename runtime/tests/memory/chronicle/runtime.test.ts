import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";

import {
  MemoryRuntime,
  type ChronicleFrameFeed,
} from "../../../src/memory/runtime.js";
import { ChronicleRepository } from "../../../src/memory/chronicle/repository.js";
import type { ChronicleFrameInput } from "../../../src/memory/chronicle/types.js";
import { openMemoryDatabase } from "../../../src/memory/database.js";

const now = Date.parse("2026-08-15T10:01:15.000Z");
const model = { id: "memory-model" } as Model<string>;

function frame(generationId: string, id: number): ChronicleFrameInput {
  return {
    sourceId: `screenpipe-frame:${generationId}:${id}`,
    generationId,
    frameId: String(id),
    monitorKey: String(id),
    deviceName: `Display ${id}`,
    capturedAt: `2026-08-15T10:00:0${id}.000Z`,
    trigger: "periodic",
    visibleText: `内容 ${generationId} ${id}`,
  };
}

function runtimeConfig() {
  return {
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
      cooldownMilliseconds: 24 * 60 * 60_000,
    },
    retention: {
      chronicleUnreferencedMilliseconds: 90 * 24 * 60 * 60_000,
    },
  };
}

test("starts Memory without running pending model jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  const config = runtimeConfig();
  const memoryRoot = join(root, "memory");
  const database = openMemoryDatabase(memoryRoot);
  const repository = new ChronicleRepository(database, {
    ...config.chronicle,
    worker: {
      leaseMilliseconds: config.worker.leaseMilliseconds,
      retryDelayMilliseconds: config.worker.retryDelayMilliseconds,
      maxAttempts: config.worker.maxAttempts,
    },
  });
  repository.ingest(frame("generation-1", 1), now);
  database.close();
  let modelCalls = 0;
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    memoryRoot,
    env,
    models: {
      completeSimple: async () => {
        modelCalls += 1;
        return {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "chronicle-tool-call",
            name: "submit_chronicle_summary",
            arguments: {
              activities: [{
                summary: "Observed a screen activity.",
                source_frame_ids: ["screenpipe-frame:generation-1:1"],
                application: null,
                window_title: null,
              }],
              source_summary: "Observed screen activity.",
            },
          }],
          api: "test",
          provider: "test",
          model: "memory-model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: now,
        };
      },
    } as unknown as Models,
    model,
    config,
    now: () => now,
  });
  t.after(() => runtime.stop());

  await runtime.start();
  assert.equal(modelCalls, 0);
  await runtime.runOnce();
  assert.equal(modelCalls, 1);
});

test("polls generation-scoped frames, resets on rotation, and resumes a durable cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  let activeGenerationId = "generation-1";
  const byGeneration = new Map<string, ChronicleFrameInput[]>([
    ["generation-1", [frame("generation-1", 1), frame("generation-1", 2)]],
    ["generation-2", [frame("generation-2", 1)]],
  ]);
  const reads: Array<{ generationId: string; cursor: number }> = [];
  const feed: ChronicleFrameFeed = {
    listGenerations: async () => activeGenerationId === "generation-1"
      ? [{ generationId: "generation-1", active: true }]
      : [
          { generationId: "generation-1", active: false },
          { generationId: "generation-2", active: true },
        ],
    readFramesAfter: async (generationId, cursor) => {
      reads.push({ generationId, cursor });
      const frames = (byGeneration.get(generationId) ?? []).filter(
        (candidate) => Number(candidate.frameId) > cursor,
      );
      return {
        generationId,
        frames,
        cursor: frames.length === 0
          ? cursor
          : Number(frames[frames.length - 1]!.frameId),
        hasMore: false,
      };
    },
  };
  let modelCalls = 0;
  const models = {
    completeSimple: async (_model: Model<string>, context: { messages: Array<{ content: unknown }> }) => {
      modelCalls += 1;
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        type: string;
        frames: ChronicleFrameInput[];
      };
      assert.equal(input.type, "chronicle_window");
      return {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "chronicle-tool-call",
          name: "submit_chronicle_summary",
          arguments: {
            activities: [{
              summary: "Observed a screen activity.",
              source_frame_ids: input.frames.map(({ sourceId }) => sourceId),
              application: null,
              window_title: null,
            }],
            source_summary: "Observed screen activity.",
          },
        }],
        api: "test",
        provider: "test",
        model: "memory-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: now,
      };
    },
  } as unknown as Models;
  const options = {
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    memoryRoot: join(root, "memory"),
    env,
    models,
    model,
    config: runtimeConfig(),
    chronicleFrameFeed: feed,
    gitBranch: async () => "feature/chronicle",
    now: () => now,
  };
  const runtime = new MemoryRuntime(options);
  t.after(() => runtime.stop());

  await runtime.start();
  assert.deepEqual(reads, []);
  await runtime.runOnce();
  assert.deepEqual(reads, [{ generationId: "generation-1", cursor: 0 }]);
  assert.equal(modelCalls, 1);

  byGeneration.get("generation-1")?.push(frame("generation-1", 3));
  activeGenerationId = "generation-2";
  await runtime.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-1", cursor: 2 });
  assert.equal(modelCalls, 2);
  assert.equal(runtime.chronicleGenerationComplete("generation-1"), true);

  await runtime.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-2", cursor: 0 });
  assert.equal(modelCalls, 3);
  assert.equal(runtime.chronicleGenerationComplete("generation-2"), false);
  await runtime.stop();

  const restarted = new MemoryRuntime(options);
  t.after(() => restarted.stop());
  await restarted.start();
  const beforeResumeCalls = modelCalls;
  await restarted.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-2", cursor: 1 });
  assert.equal(modelCalls, beforeResumeCalls + 1);
  const rollouts = await readdir(join(root, "memory", "rollout_summaries"));
  assert.equal(rollouts.filter((name) => name.startsWith("chronicle-")).length, 1);
});
