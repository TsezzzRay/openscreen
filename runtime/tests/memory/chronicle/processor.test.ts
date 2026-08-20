import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { summarizeChronicleWindow } from "../../../src/memory/chronicle/processor.js";
import { CHRONICLE_SUMMARY_SCHEMA } from "../../../src/memory/chronicle/summary-schema.js";
import type { ChronicleFrameInput, ChronicleFrameProjection } from "../../../src/memory/chronicle/types.js";
import { createMemoryProjector } from "../../../src/memory/mastra/projector.js";
import { openMastraMemoryStore, type MastraMemoryStore } from "../../../src/memory/mastra/store.js";
import type { WritePathDeps } from "../../../src/memory/mastra/write-path.js";
import type { MemoryConfig } from "../../../src/memory/config.js";

// Never actually sent: the fake API key only needs to satisfy construction.
// Thresholds below are set enormous so observe() always no-ops (confirmed
// idempotent under threshold in the migration's Stage A spike) — no test
// here makes a real network call.
process.env.MINIMAX_CN_API_KEY ??= "test-key";

const HUGE = 100_000_000;

function observationalMemoryConfig(): MemoryConfig["observationalMemory"] {
  return {
    interactive: { messageTokens: HUGE, observationTokens: HUGE },
    screenActivity: { messageTokens: HUGE, observationTokens: HUGE },
  };
}

async function withWritePath(
  root: string,
  fn: (writePath: WritePathDeps, store: MastraMemoryStore) => Promise<void>,
): Promise<void> {
  const store = openMastraMemoryStore(
    root,
    {
      enabled: true,
      worker: { intervalMilliseconds: 5_000, maxChronicleWindowsPerTick: 2 },
      chronicle: { windowMilliseconds: 60_000, graceMilliseconds: 0, maxSourcesPerRequest: 10, maxInputTokens: 8_000, maxOutputTokens: 2_000 },
      observationalMemory: observationalMemoryConfig(),
      retention: { chronicleRolloutMaxAgeMilliseconds: HUGE },
    },
    {
      provider: "minimax-cn",
      id: "test-model",
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    },
  );
  try {
    const projector = createMemoryProjector(root, store);
    await fn({ store, projector }, store);
  } finally {
    await store.close();
  }
}

const policy = { maxSourcesPerRequest: 1, maxInputTokens: 8_000, maxOutputTokens: 2_000 };
const model = { id: "memory-model" } as Model<string>;
const anthropicModel = { ...model, api: "anthropic-messages" } as Model<"anthropic-messages">;

function frame(id: string): ChronicleFrameInput {
  return {
    sourceId: `frame:${id}`,
    generationId: "generation-1",
    frameId: id,
    monitorKey: id,
    deviceName: "Display",
    capturedAt: `2026-08-15T10:00:0${id}.000Z`,
    trigger: "periodic",
    visibleText: `屏幕内容 ${id}`,
  };
}

function projectFrame(input: ChronicleFrameInput): ChronicleFrameProjection {
  return { type: "screenpipe_frame", ...input };
}

function toolResponse(output: Record<string, unknown>, name = "submit_chronicle_summary") {
  return {
    role: "assistant" as const,
    content: [{
      type: "toolCall" as const,
      id: "chronicle-tool-call",
      name,
      arguments: output,
    }],
    api: "test",
    provider: "test",
    model: "memory-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
}

function textResponse(output: unknown) {
  return {
    ...toolResponse({}),
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    stopReason: "stop" as const,
  };
}

test("summarizes a Chronicle window and immediately archives its rollout + observation text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1")), projectFrame(frame("2"))];
  const requests: Context[] = [];
  const models: Models = {
    complete: async (
      _model: Model<string>,
      context: Context,
      options?: SimpleStreamOptions & { toolChoice?: unknown },
    ) => {
      requests.push(context);
      assert.equal(options?.maxTokens, policy.maxOutputTokens);
      assert.deepEqual(options?.toolChoice, { type: "tool", name: "submit_chronicle_summary" });
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{ sourceId: string }>;
      };
      return toolResponse({
        activities: [{
          summary: "Viewed a display.",
          source_frame_ids: input.frames.map(({ sourceId }) => sourceId),
          application: null,
          window_title: null,
        }],
        source_summary: "Observed 屏幕内容.",
      });
    },
    completeSimple: async () => assert.fail("Anthropic Chronicle must force its tool choice"),
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 1 },
      models,
      model: anthropicModel,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.deepEqual(result, { status: "summarized", requestCount: 2 });
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0]?.systemPrompt ?? "", /submit_chronicle_summary/);
  assert.deepEqual(requests[0]?.tools, [{
    name: "submit_chronicle_summary",
    description: "Submit the factual activity summary for this Chronicle window.",
    parameters: CHRONICLE_SUMMARY_SCHEMA,
  }]);
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /frame:1/);
  assert.match(rollout, /屏幕内容/);
});

test("splits a Chronicle chunk when the model reaches its output limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1")), projectFrame(frame("2"))];
  const requestSourceIds: string[][] = [];
  const models = {
    completeSimple: async (_model: Model<string>, context: Context) => {
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{ sourceId: string }>;
      };
      const sourceIds = input.frames.map(({ sourceId }) => sourceId);
      requestSourceIds.push(sourceIds);
      if (sourceIds.length > 1) {
        return { ...toolResponse({}), content: [{ type: "text" as const, text: "partial output" }], stopReason: "length" as const };
      }
      return toolResponse({
        activities: [{ summary: `Viewed ${sourceIds[0]}.`, source_frame_ids: sourceIds, application: null, window_title: null }],
        source_summary: `Observed ${sourceIds[0]}.`,
      });
    },
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 10 },
      models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.deepEqual(result, { status: "summarized", requestCount: 3 });
  });
  assert.deepEqual(requestSourceIds, [
    ["frame:1", "frame:2"],
    ["frame:1"],
    ["frame:2"],
  ]);
});

test("fails invalid source coverage without publishing a rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1"))];
  const models = {
    completeSimple: async () => toolResponse({
      activities: [{ summary: "Invented.", source_frame_ids: ["invented"], application: null, window_title: null }],
      source_summary: "Invalid.",
    }),
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 10 },
      models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.equal(result.status, "failed");
  });
  await assert.rejects(() => readdir(join(root, "rollout_summaries")), { code: "ENOENT" });
});

test("rejects one source larger than the input token budget before model use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1"))];
  let called = false;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { maxSourcesPerRequest: 10, maxInputTokens: 10, maxOutputTokens: 2 },
      models: {
        completeSimple: async () => {
          called = true;
          return toolResponse({});
        },
      } as unknown as Models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.equal(result.status, "failed");
    assert.match(result.status === "failed" ? result.error : "", /single Chronicle source.*budget/i);
  });
  assert.equal(called, false);
});

test("does not publish when an aborting model ignores the signal and returns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1"))];
  const controller = new AbortController();

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 10 },
      models: {
        completeSimple: async () => {
          controller.abort("stop Chronicle");
          return toolResponse({
            activities: [{ summary: "Must not publish.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
            source_summary: "Must not publish.",
          });
        },
      } as unknown as Models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
      signal: controller.signal,
    });
    assert.equal(result.status, "failed");
  });
  await assert.rejects(() => readdir(join(root, "rollout_summaries")), { code: "ENOENT" });
});

test("repairs a rejected tool call by resubmitting with the rejection reason", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1"))];
  let calls = 0;
  const seenContexts: Context[] = [];
  const models = {
    completeSimple: async (_model: Model<string>, context: Context) => {
      seenContexts.push(context);
      calls += 1;
      if (calls === 1) {
        // Duplicate the source across two activities — a real failure mode
        // observed in production diagnostics.log.
        return toolResponse({
          activities: [
            { summary: "First.", source_frame_ids: ["frame:1"], application: null, window_title: null },
            { summary: "Second.", source_frame_ids: ["frame:1"], application: null, window_title: null },
          ],
          source_summary: "Duplicated.",
        });
      }
      return toolResponse({
        activities: [{ summary: "Fixed.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
        source_summary: "Corrected after rejection.",
      });
    },
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 10 },
      models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.deepEqual(result, { status: "summarized", requestCount: 2 });
  });
  assert.equal(calls, 2);
  const repairMessages = seenContexts[1]?.messages ?? [];
  const toolResult = repairMessages.find((entry) => entry.role === "toolResult");
  assert.ok(toolResult, "repair request must include the rejected tool result");
  assert.equal((toolResult as { isError?: boolean }).isError, true);
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /Corrected after rejection/);
});

test("abandons a batch after exhausting repair attempts on a persistently invalid model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame(frame("1"))];
  let calls = 0;
  const models = {
    completeSimple: async () => {
      calls += 1;
      return toolResponse({
        activities: [{ summary: "Invented.", source_frame_ids: ["invented"], application: null, window_title: null }],
        source_summary: "Invalid.",
      });
    },
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 10 },
      models,
      model,
      writePath,
      now: () => Date.parse("2026-08-15T10:01:00.000Z"),
    });
    assert.equal(result.status, "failed");
    assert.match(result.status === "failed" ? result.error : "", /Chronicle returned source invented/i);
  });
  // Initial attempt + MAX_REPAIR_ATTEMPTS (2) resubmissions, all rejected.
  assert.equal(calls, 3);
  await assert.rejects(() => readdir(join(root, "rollout_summaries")), { code: "ENOENT" });
});

test("rejects text, a wrong tool, and multiple Chronicle tool calls", async (t) => {
  const valid = {
    activities: [{ summary: "Viewed a display.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
    source_summary: "One display frame was observed.",
  };
  const cases = [
    { name: "text", response: textResponse(valid), error: /exactly one Chronicle tool call/i },
    { name: "wrong tool", response: toolResponse(valid, "other_tool"), error: /unexpected Chronicle tool other_tool/i },
    {
      name: "multiple tools",
      response: {
        ...toolResponse(valid),
        content: [toolResponse(valid).content[0]!, { ...toolResponse(valid).content[0]!, id: "second-call" }],
      },
      error: /exactly one Chronicle tool call/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const frames = [projectFrame(frame("1"))];
      await withWritePath(root, async (writePath) => {
        const result = await summarizeChronicleWindow({
          windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
          frames,
          policy: { ...policy, maxSourcesPerRequest: 10 },
          models: { completeSimple: async () => item.response } as unknown as Models,
          model,
          writePath,
          now: () => Date.parse("2026-08-15T10:01:00.000Z"),
        });
        assert.equal(result.status, "failed");
        assert.match(result.status === "failed" ? result.error : "", item.error);
      });
      await assert.rejects(() => readdir(join(root, "rollout_summaries")), { code: "ENOENT" });
    });
  }
});
