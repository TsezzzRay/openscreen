import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import { processNextChronicle } from "../../../src/memory/chronicle/processor.js";
import { ChronicleRepository } from "../../../src/memory/chronicle/repository.js";
import { CHRONICLE_SUMMARY_SCHEMA } from "../../../src/memory/chronicle/summary-schema.js";
import type { ChronicleFrameInput } from "../../../src/memory/chronicle/types.js";

const policy = {
  maxInputTokens: 8_000,
  maxOutputTokens: 2_000,
  windowMilliseconds: 60_000,
  graceMilliseconds: 0,
  maxSourcesPerRequest: 1,
  worker: { leaseMilliseconds: 60_000, retryDelayMilliseconds: 1_000, maxAttempts: 3 },
};

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

const model = { id: "memory-model" } as Model<string>;
const anthropicModel = {
  ...model,
  api: "anthropic-messages",
} as Model<"anthropic-messages">;

function toolResponse(
  output: Record<string, unknown>,
  name = "submit_chronicle_summary",
) {
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

test("processes bounded Chronicle requests and immediately projects its rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "database"));
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, policy);
  const due = Date.parse("2026-08-15T10:01:00.000Z");
  repository.ingest(frame("1"), due);
  repository.ingest(frame("2"), due);
  const requests: Context[] = [];
const models: Models = {
  complete: async (
    _model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions & { toolChoice?: unknown },
  ) => {
      requests.push(context);
      assert.equal(options?.maxTokens, policy.maxOutputTokens);
      assert.deepEqual(options?.toolChoice, {
        type: "tool",
        name: "submit_chronicle_summary",
      });
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{ sourceId: string }>;
      };
      const response = toolResponse({
        activities: [{
          summary: "Viewed a display.",
          source_frame_ids: input.frames.map(({ sourceId }) => sourceId),
          application: null,
          window_title: null,
        }],
        source_summary: "Observed 屏幕内容.",
      });
      return {
        ...response,
        content: [
          { type: "thinking" as const, thinking: "Organizing supplied evidence." },
          { type: "text" as const, text: "Submitting the requested Chronicle summary." },
          ...response.content,
        ],
      };
    },
    completeSimple: async () => assert.fail("Anthropic Chronicle must force its tool choice"),
  } as unknown as Models;

  const memoryRoot = join(root, "memory");
  const result = await processNextChronicle({
    repository,
    models,
    model: anthropicModel,
    workerId: "worker-1",
    memoryRoot,
    now: () => due,
  });
  assert.deepEqual(result, {
    status: "processed",
    jobKey: result.status === "processed" ? result.jobKey : "",
    requestCount: 2,
    projectedArtifacts: 1,
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.systemPrompt ?? "", /submit_chronicle_summary/);
  assert.deepEqual(requests[0]?.tools, [{
    name: "submit_chronicle_summary",
    description: "Submit the factual activity summary for this Chronicle window.",
    parameters: CHRONICLE_SUMMARY_SCHEMA,
  }]);
  const [rolloutName] = await readdir(join(memoryRoot, "rollout_summaries"));
  const rollout = await readFile(join(memoryRoot, "rollout_summaries", rolloutName!), "utf8");
  assert.match(rollout, /frame:1/);
  assert.match(rollout, /屏幕内容/);
});

test("splits a Chronicle chunk when the model reaches its output limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "database"));
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, {
    ...policy,
    maxSourcesPerRequest: 10,
  });
  const due = Date.parse("2026-08-15T10:01:00.000Z");
  repository.ingest(frame("1"), due);
  repository.ingest(frame("2"), due);
  const requestSourceIds: string[][] = [];
  const models = {
    completeSimple: async (_model: Model<string>, context: Context) => {
      const input = JSON.parse(String(context.messages[0]?.content)) as {
        frames: Array<{ sourceId: string }>;
      };
      const sourceIds = input.frames.map(({ sourceId }) => sourceId);
      requestSourceIds.push(sourceIds);
      if (sourceIds.length > 1) {
        return {
          ...toolResponse({}),
          content: [{ type: "text" as const, text: "partial output" }],
          stopReason: "length" as const,
        };
      }
      return toolResponse({
        activities: [{
          summary: `Viewed ${sourceIds[0]}.`,
          source_frame_ids: sourceIds,
          application: null,
          window_title: null,
        }],
        source_summary: `Observed ${sourceIds[0]}.`,
      });
    },
  } as unknown as Models;

  const result = await processNextChronicle({
    repository,
    models,
    model,
    workerId: "worker-1",
    memoryRoot: join(root, "memory"),
    now: () => due,
  });

  assert.equal(result.status, "processed");
  assert.equal(result.status === "processed" ? result.requestCount : 0, 3);
  assert.deepEqual(requestSourceIds, [
    ["frame:1", "frame:2"],
    ["frame:1"],
    ["frame:2"],
  ]);
});

test("fails invalid source coverage without publishing a rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "database"));
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, { ...policy, maxSourcesPerRequest: 10 });
  const due = Date.parse("2026-08-15T10:01:00.000Z");
  repository.ingest(frame("1"), due);
  const models = {
    completeSimple: async () => toolResponse({
      activities: [{
        summary: "Invented.",
        source_frame_ids: ["invented"],
        application: null,
        window_title: null,
      }],
      source_summary: "Invalid.",
    }),
  } as unknown as Models;
  const result = await processNextChronicle({
    repository,
    models,
    model,
    workerId: "worker-1",
    memoryRoot: join(root, "memory"),
    now: () => due,
  });
  assert.equal(result.status, "failed");
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM memory_artifacts WHERE kind = 'chronicle_rollout'
  `).get()?.count, 0);
});

test("rejects one source larger than the input token budget before model use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "database"));
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, {
    ...policy,
    maxInputTokens: 10,
    maxOutputTokens: 2,
  });
  const due = Date.parse("2026-08-15T10:01:00.000Z");
  repository.ingest(frame("1"), due);
  let called = false;
  const result = await processNextChronicle({
    repository,
    models: {
      completeSimple: async () => {
        called = true;
        return toolResponse({});
      },
    } as unknown as Models,
    model,
    workerId: "worker-1",
    memoryRoot: join(root, "memory"),
    now: () => due,
  });
  assert.equal(result.status, "failed");
  assert.equal(called, false);
  assert.match(result.status === "failed" ? result.error : "", /single Chronicle source.*budget/i);
});

test("does not publish when an aborting model ignores the signal and returns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(join(root, "database"));
  t.after(() => database.close());
  const repository = new ChronicleRepository(database, {
    ...policy,
    maxSourcesPerRequest: 10,
  });
  const due = Date.parse("2026-08-15T10:01:00.000Z");
  repository.ingest(frame("1"), due);
  const controller = new AbortController();
  const result = await processNextChronicle({
    repository,
    models: {
      completeSimple: async () => {
        controller.abort("stop Chronicle");
        return toolResponse({
          activities: [{
            summary: "Must not publish.",
            source_frame_ids: ["frame:1"],
            application: null,
            window_title: null,
          }],
          source_summary: "Must not publish.",
        });
      },
    } as unknown as Models,
    model,
    workerId: "worker-1",
    memoryRoot: join(root, "memory"),
    now: () => due,
    signal: controller.signal,
  });
  assert.equal(result.status, "failed");
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM memory_artifacts WHERE kind = 'chronicle_rollout'
  `).get()?.count, 0);
});

test("rejects text, a wrong tool, and multiple Chronicle tool calls", async (t) => {
  const valid = {
    activities: [{
      summary: "Viewed a display.",
      source_frame_ids: ["frame:1"],
      application: null,
      window_title: null,
    }],
    source_summary: "One display frame was observed.",
  };
  const cases = [
    { name: "text", response: textResponse(valid), error: /exactly one Chronicle tool call/i },
    {
      name: "wrong tool",
      response: toolResponse(valid, "other_tool"),
      error: /unexpected Chronicle tool other_tool/i,
    },
    {
      name: "multiple tools",
      response: {
        ...toolResponse(valid),
        content: [
          toolResponse(valid).content[0]!,
          { ...toolResponse(valid).content[0]!, id: "second-call" },
        ],
      },
      error: /exactly one Chronicle tool call/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), "openscreen-chronicle-processor-"));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const database = openMemoryDatabase(join(root, "database"));
      subtest.after(() => database.close());
      const repository = new ChronicleRepository(database, {
        ...policy,
        maxSourcesPerRequest: 10,
      });
      const due = Date.parse("2026-08-15T10:01:00.000Z");
      repository.ingest(frame("1"), due);
      const result = await processNextChronicle({
        repository,
        models: {
          completeSimple: async () => item.response,
        } as unknown as Models,
        model,
        workerId: "worker-1",
        memoryRoot: join(root, "memory"),
        now: () => due,
      });
      assert.equal(result.status, "failed");
      assert.match(result.status === "failed" ? result.error : "", item.error);
      assert.equal(database.connection.prepare(`
        SELECT count(*) AS count FROM memory_artifacts WHERE kind = 'chronicle_rollout'
      `).get()?.count, 0);
    });
  }
});
