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
  assert.match(requests[0]?.systemPrompt ?? "", /not evidence of a verified user choice or authorization/);
  assert.match(requests[0]?.systemPrompt ?? "", /Do not call visible text a window title, heading, or UI field/);
  assert.match(requests[0]?.systemPrompt ?? "", /Do not identify visible text as a code comment/);
  assert.match(requests[0]?.systemPrompt ?? "", /Do not assert highlighting, selection, cursor position, or focus from visibleText alone/);
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

test("archives every frame while showing only representatives to the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dup1: ChronicleFrameInput = {
    sourceId: "frame:1",
    generationId: "generation-1",
    frameId: "1",
    monitorKey: "1",
    deviceName: "Display",
    capturedAt: "2026-08-15T10:00:01.000Z",
    trigger: "periodic",
    visibleText: "same terminal, unchanged",
  };
  const distinct: ChronicleFrameInput = {
    sourceId: "frame:2",
    generationId: "generation-1",
    frameId: "2",
    monitorKey: "2",
    deviceName: "Display",
    capturedAt: "2026-08-15T10:00:02.000Z",
    trigger: "periodic",
    visibleText: "a different screen",
  };
  const dup2: ChronicleFrameInput = {
    ...dup1,
    sourceId: "frame:3",
    frameId: "3",
    capturedAt: "2026-08-15T10:00:03.000Z",
  };
  const frames = [dup1, distinct, dup2].map(projectFrame);
  const requestedFrames: Array<Array<{
    sourceId: string;
    frameId: string;
    capturedAt: string;
    visibleText?: string;
  }>> = [];
  const models = {
    completeSimple: async (_model: Model<string>, context: Context) => {
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{
          sourceId: string;
          frameId: string;
          capturedAt: string;
          visibleText?: string;
        }>;
        originalFrameCount?: number;
      };
      requestedFrames.push(input.frames);
      assert.equal(input.originalFrameCount, undefined);
      assert.doesNotMatch(context.systemPrompt ?? "", /visibleTextRef|originalFrameCount/);
      return toolResponse({
        activities: [
          { summary: "Unchanged terminal.", source_frame_ids: ["frame:1"], application: null, window_title: null },
          { summary: "A different screen.", source_frame_ids: ["frame:2"], application: null, window_title: null },
        ],
        source_summary: "Terminal and another screen were observed.",
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
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });

  assert.deepEqual(requestedFrames.map((batch) => batch.map(({ sourceId }) => sourceId)), [["frame:1", "frame:2"]]);
  assert.equal(requestedFrames[0]?.[0]?.visibleText, "same terminal, unchanged");

  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  // Expansion restores the duplicate source without losing its capture record.
  assert.match(rollout, /source_frame_id: frame:1/);
  assert.match(rollout, /source_frame_id: frame:2/);
  assert.match(rollout, /source_frame_id: frame:3/);
  assert.match(rollout, /captured_at: 2026-08-15T10:00:03.000Z/);
  const activity1 = rollout.slice(rollout.indexOf("Unchanged terminal"));
  assert.match(activity1, /- frame:1/);
  assert.match(activity1, /- frame:3/);
});

test("deduplicates per monitor, but not after an intervening frame or across metadata changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { ...frame("1"), monitorKey: "left", application: "Terminal", windowTitle: "Tests", url: "file:///tests", visibleText: "12 passed" };
  const frames = [
    projectFrame(base),
    projectFrame({ ...base, sourceId: "frame:2", frameId: "2", monitorKey: "right" }),
    projectFrame({ ...base, sourceId: "frame:3", frameId: "3" }),
    projectFrame({ ...base, sourceId: "frame:4", frameId: "4", visibleText: "Editor" }),
    projectFrame({ ...base, sourceId: "frame:5", frameId: "5" }),
    projectFrame({ ...base, sourceId: "frame:6", frameId: "6", windowTitle: "Other" }),
    projectFrame({ ...base, sourceId: "frame:7", frameId: "7", application: "Browser" }),
    projectFrame({ ...base, sourceId: "frame:8", frameId: "8", url: "file:///other" }),
    projectFrame({ ...base, sourceId: "frame:9", frameId: "9", visibleText: "" }),
    projectFrame({ ...base, sourceId: "frame:10", frameId: "10", visibleText: "" }),
  ];
  const seen: string[][] = [];
  const models = { completeSimple: async (_model: Model<string>, context: Context) => {
    const input = JSON.parse(String(context.messages[0]?.content)) as { frames: Array<{ sourceId: string }> };
    const ids = input.frames.map(({ sourceId }) => sourceId);
    seen.push(ids);
    return toolResponse({ activities: ids.map((id) => ({ summary: "Observed.", source_frame_ids: [id], application: null, window_title: null })), source_summary: "Observed screen changes." });
  } } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 10 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });
  assert.deepEqual(seen, [["frame:1", "frame:2", "frame:4", "frame:5", "frame:6", "frame:7", "frame:8", "frame:9", "frame:10"]]);
});

test("keeps duplicate groups intact across request boundaries and output-limit splits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { ...frame("1"), monitorKey: "left", application: "Terminal", visibleText: "12 passed" };
  const frames = [
    projectFrame(base),
    projectFrame({ ...base, sourceId: "frame:2", frameId: "2" }),
    projectFrame({ ...base, sourceId: "frame:3", frameId: "3", visibleText: "next command" }),
    projectFrame({ ...base, sourceId: "frame:4", frameId: "4", visibleText: "done" }),
    projectFrame({ ...base, sourceId: "frame:5", frameId: "5", visibleText: "done" }),
  ];
  const seen: string[][] = [];
  const models = { completeSimple: async (_model: Model<string>, context: Context) => {
    const input = JSON.parse(String(context.messages[0]?.content)) as { frames: Array<{ sourceId: string }> };
    const ids = input.frames.map(({ sourceId }) => sourceId);
    seen.push(ids);
    if (ids.length > 1) return { ...toolResponse({}), stopReason: "length" as const };
    return toolResponse({ activities: [{ summary: `Observed ${ids[0]}.`, source_frame_ids: ids, application: null, window_title: null }], source_summary: "Observed terminal state." });
  } } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 2 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 4 });
  });
  assert.deepEqual(seen, [["frame:1", "frame:3"], ["frame:1"], ["frame:3"], ["frame:4"]]);
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /## Activity 1[\s\S]*?source_frame_ids:\n- frame:1\n- frame:2\n## Activity 2/);
  assert.match(rollout, /## Activity 3[\s\S]*?source_frame_ids:\n- frame:4\n- frame:5/);
});

test("keeps blank text and unrelated monitor frames separate across requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [
    projectFrame({ ...frame("1"), visibleText: "same content" }),
    projectFrame({ ...frame("2"), visibleText: "" }),
    projectFrame({ ...frame("3"), visibleText: "same content" }),
    projectFrame({ ...frame("4"), visibleText: "" }),
  ];
  const seen: Array<Array<{ sourceId: string; visibleText?: string; visibleTextRef?: string }>> = [];
  const models = {
    completeSimple: async (_model: Model<string>, context: Context) => {
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{ sourceId: string; visibleText?: string; visibleTextRef?: string }>;
      };
      seen.push(input.frames);
      return toolResponse({
        activities: [{
          summary: "Observed the screens.",
          source_frame_ids: input.frames.map(({ sourceId }) => sourceId),
          application: null,
          window_title: null,
        }],
        source_summary: "The screens were observed.",
      });
    },
  } as unknown as Models;

  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({
      windowId: "chronicle-window:2026-08-15T10:01:00.000Z",
      frames,
      policy: { ...policy, maxSourcesPerRequest: 2 },
      models,
      model,
      writePath,
    });
    assert.deepEqual(result, { status: "summarized", requestCount: 2 });
  });
  assert.deepEqual(seen.map((batch) => batch.map(({ sourceId }) => sourceId)), [["frame:1", "frame:2"], ["frame:3", "frame:4"]]);
  assert.equal(seen[1]?.[0]?.visibleText, "same content");
  assert.equal(seen[1]?.[0]?.visibleTextRef, undefined);
  assert.equal(seen[0]?.[1]?.visibleText, "");
  assert.equal(seen[1]?.[1]?.visibleText, "");
});

test("uses captured metadata instead of model-invented window titles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [
    projectFrame({ ...frame("1"), application: "Editor", windowTitle: "Actual title" }),
    projectFrame({ ...frame("2"), application: "Terminal" }),
  ];
  const models = {
    completeSimple: async () => toolResponse({
      activities: [
        { summary: "Edited a file.", source_frame_ids: ["frame:1"], application: "Invented app", window_title: "Invented title" },
        { summary: "Viewed a command.", source_frame_ids: ["frame:2"], application: "Terminal", window_title: "Visible terminal text" },
      ],
      source_summary: "Two observed activities.",
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
    });
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });

  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /Application: Editor/);
  assert.match(rollout, /Window title: Actual title/);
  assert.match(rollout, /Application: Terminal/);
  assert.doesNotMatch(rollout, /Invented app|Invented title|Visible terminal text/);
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

test("repairs unsupported capture-count claims instead of archiving them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame({ ...frame("1"), visibleText: "npm test: 12 passed" })];
  let calls = 0;
  const models = { completeSimple: async (_model: Model<string>, context: Context) => {
    calls += 1;
    if (calls > 1) assert.match(JSON.stringify(context.messages), /capture counts/i);
    return toolResponse({
      activities: [{ summary: calls === 1 ? "Two screen frames were captured showing npm test: 12 passed." : "Terminal showed npm test: 12 passed.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
      source_summary: "Terminal showed npm test: 12 passed.",
    });
  } } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 10 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 2 });
  });
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.doesNotMatch(rollout, /Two screen frames/);
});

test("rebuilds a counted source summary from grounded activities without retrying", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame({ ...frame("1"), visibleText: "npm test: 12 passed" })];
  let calls = 0;
  const models = { completeSimple: async () => {
    calls += 1;
    return toolResponse({
      activities: [{ summary: "Terminal showed npm test: 12 passed.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
      source_summary: "Two screen captures were observed; npm test: 12 passed.",
    });
  } } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 10 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });
  assert.equal(calls, 1);
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /Source summary: Terminal showed npm test: 12 passed\./);
  assert.doesNotMatch(rollout, /Two screen captures/);
});

test("rebuilds an ordinal frame narration from grounded activities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame({ ...frame("1"), application: "Browser", visibleText: "Deployment dashboard status: failed" })];
  let calls = 0;
  const models = { completeSimple: async () => {
    calls += 1;
    return toolResponse({
      activities: [{ summary: "Browser displayed deployment status: failed.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
      source_summary: "The first frame showed a deployment dashboard status of failed.",
    });
  } } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 10 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });
  assert.equal(calls, 1);
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /Source summary: Browser displayed deployment status: failed\./);
  assert.doesNotMatch(rollout, /first frame/);
});

test("removes per-application frame counts from the source summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = [projectFrame({ ...frame("1"), application: "Terminal", visibleText: "npm test: 12 passed" })];
  const models = { completeSimple: async () => toolResponse({
    activities: [{ summary: "Terminal displayed npm test: 12 passed.", source_frame_ids: ["frame:1"], application: null, window_title: null }],
    source_summary: "One terminal frame shows npm test: 12 passed.",
  }) } as unknown as Models;
  await withWritePath(root, async (writePath) => {
    const result = await summarizeChronicleWindow({ windowId: "chronicle-window:2026-08-15T10:01:00.000Z", frames, policy: { ...policy, maxSourcesPerRequest: 10 }, models, model, writePath });
    assert.deepEqual(result, { status: "summarized", requestCount: 1 });
  });
  const [rolloutName] = await readdir(join(root, "rollout_summaries"));
  const rollout = await readFile(join(root, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /Source summary: Terminal displayed npm test: 12 passed\./);
  assert.doesNotMatch(rollout, /One terminal frame/);
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
