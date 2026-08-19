import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";

import type { MemoryConfig } from "../../../src/memory/config.js";
import { openMemoryCursors } from "../../../src/memory/cursors.js";
import { memoryDiagnosticsLogPath } from "../../../src/memory/diagnostics-log.js";
import type { ChronicleFrameInput } from "../../../src/memory/chronicle/types.js";
import {
  MemoryRuntime,
  type ChronicleFrameFeed,
} from "../../../src/memory/runtime.js";

// Never actually sent: satisfies buildObservationalMemoryModel's construction
// check. Enormous observationalMemory thresholds below mean observe() always
// no-ops (confirmed idempotent under threshold in Stage A) — these tests
// exercise Chronicle windowing/summarization, not Observer/Reflector, so no
// real network call happens here.
process.env.MINIMAX_CN_API_KEY ??= "test-key";
const HUGE = 100_000_000;

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

function chronicleToolResponse(sourceFrameIds: string[]) {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "chronicle-tool-call",
      name: "submit_chronicle_summary",
      arguments: {
        activities: [{
          summary: "Observed a screen activity.",
          source_frame_ids: sourceFrameIds,
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
}

test("starts Memory without eagerly summarizing pending windows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  const config = runtimeConfig();
  const memoryRoot = join(root, "memory");

  // Pre-seed a due window directly against cursors.sqlite3, the same way
  // pollChronicleFrames would — mirrors the original test's approach of
  // seeding the repository before constructing the runtime.
  const seedCursors = openMemoryCursors(memoryRoot);
  seedCursors.ingestChronicleFrame(frame("generation-1", 1), config.chronicle, now);
  seedCursors.close();

  let modelCalls = 0;
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    memoryRoot,
    env,
    models: {
      completeSimple: async () => {
        modelCalls += 1;
        return chronicleToolResponse(["screenpipe-frame:generation-1:1"]);
      },
    } as unknown as Models,
    model,
    agent: { provider: "minimax-cn", model: "test-model" },
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
        cursor: frames.length === 0 ? cursor : Number(frames[frames.length - 1]!.frameId),
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
      return chronicleToolResponse(input.frames.map(({ sourceId }) => sourceId));
    },
  } as unknown as Models;
  const options = {
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    memoryRoot: join(root, "memory"),
    env,
    models,
    model,
    agent: { provider: "minimax-cn", model: "test-model" },
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

  // frame 3 (generation-1) lands in the same wall-clock window as frames 1-2,
  // which the first runOnce() already summarized. Per the migration's
  // deliberate design (see cursors.test.ts: "a frame arriving after its
  // window is already summarized is dropped, not re-queued" — Chronicle is a
  // best-effort coverage index, not a guaranteed-complete record), this does
  // NOT trigger a second model call; it's silently dropped. The generation
  // still completes correctly regardless.
  byGeneration.get("generation-1")?.push(frame("generation-1", 3));
  activeGenerationId = "generation-2";
  await runtime.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-1", cursor: 2 });
  assert.equal(modelCalls, 1);
  assert.equal(runtime.chronicleGenerationComplete("generation-1"), true);

  // generation-2's only frame also falls in that same already-summarized
  // window (a same-window cross-generation collision this synthetic test
  // deliberately sets up to exercise the drop path again from the
  // generation-rotation angle) — dropped for the same reason, no new call.
  await runtime.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-2", cursor: 0 });
  assert.equal(modelCalls, 1);
  assert.equal(runtime.chronicleGenerationComplete("generation-2"), false);
  await runtime.stop();

  const restarted = new MemoryRuntime(options);
  t.after(() => restarted.stop());
  await restarted.start();
  const beforeResumeCalls = modelCalls;
  await restarted.runOnce();
  assert.deepEqual(reads.at(-1), { generationId: "generation-2", cursor: 1 });
  // Nothing new to summarize on resume either — the durable generation cursor
  // still correctly advances (proving it survived the restart), it just has
  // nothing left to do.
  assert.equal(modelCalls, beforeResumeCalls);
  const rollouts = await readdir(join(root, "memory", "rollout_summaries"));
  assert.equal(rollouts.filter((name) => name.startsWith("chronicle-")).length, 1);
  const activity = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(root, "memory", "ACTIVITY.md"), "utf8"),
  );
  // No real Observer call happens (huge thresholds), so ACTIVITY.md is
  // written but empty — proves the projector runs without erroring even
  // when there is nothing to project yet.
  assert.equal(activity, "");
});

test("writes the real failure cause to the private diagnostics log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-diagnostics-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(() => env.cleanup());
  const config = runtimeConfig();
  const memoryRoot = join(root, "memory");

  const seedCursors = openMemoryCursors(memoryRoot);
  seedCursors.ingestChronicleFrame(frame("generation-1", 1), config.chronicle, now);
  seedCursors.close();

  // The model invents a source ID, so parseChronicleSummary rejects it — the
  // same class of failure that previously surfaced as a bare
  // "chronicle unavailable" with no recoverable cause.
  const phases: string[] = [];
  const runtime = new MemoryRuntime({
    cwd: root,
    sessionsRoot: join(root, "sessions"),
    memoryRoot,
    env,
    models: {
      completeSimple: async () => chronicleToolResponse(["invented-source-id"]),
    } as unknown as Models,
    model,
    agent: { provider: "minimax-cn", model: "test-model" },
    config,
    now: () => now,
    onDiagnostic: (diagnostic) => phases.push(diagnostic.phase),
  });
  t.after(() => runtime.stop());

  await runtime.start();
  await runtime.runOnce();

  assert.ok(phases.includes("chronicle"), "the chronicle phase reported a failure");
  const log = await readFile(memoryDiagnosticsLogPath(memoryRoot), "utf8");
  assert.match(log, /chronicle Chronicle returned source invented-source-id/);
});
