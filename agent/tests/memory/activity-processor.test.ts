import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  buildActivityRequest,
  processNextActivity,
  activityInputBudget,
} from "../../src/harness/memory/activity/processor.js";
import { ActivityRepository } from "../../src/harness/memory/activity/repository.js";
import type { ActivitySource } from "../../src/harness/memory/activity/types.js";
import type { ScreenObservation } from "../../src/plugins/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

function observation(index: number): ScreenObservation {
  const occurredAt = new Date(
    Date.parse("2026-08-04T10:00:01.000Z") + index,
  ).toISOString();
  return {
    schemaVersion: 1,
    id: `observation-${index}`,
    occurredAt,
    capturedAt: occurredAt,
    trigger: { type: "focusedWindowChanged" },
    window: {
      processIdentifier: 42,
      bundleIdentifier: "com.apple.Safari",
      applicationName: "Safari",
      title: "Memory design",
    },
    screenshot: { status: "complete", durationMilliseconds: 1 },
    accessibility: { status: "complete", durationMilliseconds: 1 },
    visibleText: `Observation ${index}`,
    diagnostics: {
      triggerToCaptureMilliseconds: 1,
      screenshotDurationMilliseconds: 1,
      accessibilityDurationMilliseconds: 1,
    },
  };
}

function turn(index: number): ActivitySource {
  const finishedAt = new Date(
    Date.parse("2026-08-04T11:00:00.000Z") + index * 60_000,
  ).toISOString();
  return {
    sourceId: `turn:session-1:turn-${index}`,
    occurredAt: finishedAt,
    turn: {
      id: `turn-${index}`,
      user: `Request ${index}`,
      assistant: `Result ${index}`,
      status: "completed",
      startedAt: new Date(Date.parse(finishedAt) - 30_000).toISOString(),
      finishedAt,
    },
    agentRuns: [],
  };
}

function responseForRequest(request: { input: Array<{ content: string }> }) {
  const payload = JSON.parse(request.input[0]?.content ?? "{}");
  const sources = payload.type === "observation_window"
    ? payload.observations
    : payload.turns;
  return {
    output_text: JSON.stringify({
      activities: [{
        summary: "The user worked on the OpenScreen memory design.",
        source_ids: sources.map(({ sourceId }: { sourceId: string }) => sourceId),
        entities: ["OpenScreen"],
        verbatim_evidence: [],
        scope_hints: [{ type: "topic", key: "openscreen-memory" }],
      }],
      source_summary: `A summary of ${sources.length} sources.`,
      raw_memory: null,
      scope_hints: [{ type: "topic", key: "openscreen-memory" }],
    }),
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-processor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  return {
    database,
    repository: new ActivityRepository(database, testMemoryConfig()),
  };
}

test("builds an Activity request that asks for factual activities and memory candidates", () => {
  const request = buildActivityRequest("summary-model", {
    type: "observation_window",
    observations: [{
      type: "observation",
      sourceId: "observation:1",
      occurredAt: "2026-08-04T10:00:01.000Z",
      capturedAt: "2026-08-04T10:00:01.000Z",
      application: { name: "Safari" },
      visibleText: "Memory design",
    }],
  }, 2_000);

  assert.equal(request.model, "summary-model");
  assert.equal(request.max_output_tokens, 2_000);
  assert.match(String(request.instructions), /source_ids/);
  assert.match(String(request.instructions), /passive screen content/i);
  assert.match(String(request.instructions), /English/);
  assert.doesNotMatch(String(request.instructions), /fallback|prompt.?version/i);
});

test("calculates the seventy-percent Activity budget without floating-point loss", () => {
  assert.equal(activityInputBudget({
    contextWindowTokens: 90,
    maxInputTokens: 90,
    maxOutputTokens: 1,
  }), 63);
});

test("processes a busy Observation window in stable requests of at most thirty", async (t) => {
  const { database, repository } = await fixture(t);
  for (let index = 30; index >= 0; index -= 1) {
    repository.ingestObservation(observation(index));
  }
  const requestSizes: number[] = [];
  const client = {
    responses: {
      inputTokens: {
        count: async (request: { input: Array<{ content: string }> }) => {
          const payload = JSON.parse(request.input[0]?.content ?? "{}");
          requestSizes.push(payload.observations.length);
          return { input_tokens: 100 };
        },
      },
      create: async (request: { input: Array<{ content: string }> }) =>
        responseForRequest(request),
    },
  } as unknown as OpenAI;

  const result = await processNextActivity({
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => Date.parse("2026-08-04T10:01:15.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(requestSizes, [30, 1]);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_records",
  ).get()?.count, 2);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_record_sources",
  ).get()?.count, 31);
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM model_attempts WHERE status = 'succeeded'",
  ).get()?.count, 2);
});

test("splits an over-budget Turn request only between whole Turns", async (t) => {
  const { repository } = await fixture(t);
  for (let index = 1; index <= 3; index += 1) {
    repository.ingestTurn({
      sessionId: "session-1",
      source: turn(index),
      projectedInputTokens: 100,
      maxInputTokens: 10_000,
    });
  }
  repository.sealDueTurnBatches(Date.parse("2026-08-04T11:33:00.000Z"));
  const generatedTurnGroups: string[][] = [];
  const client = {
    responses: {
      inputTokens: {
        count: async (request: { input: Array<{ content: string }> }) => {
          const payload = JSON.parse(request.input[0]?.content ?? "{}");
          return { input_tokens: payload.turns.length === 3 ? 8_000 : 5_000 };
        },
      },
      create: async (request: { input: Array<{ content: string }> }) => {
        const payload = JSON.parse(request.input[0]?.content ?? "{}");
        generatedTurnGroups.push(payload.turns.map(
          ({ turnId }: { turnId: string }) => turnId,
        ));
        return responseForRequest(request);
      },
    },
  } as unknown as OpenAI;

  const result = await processNextActivity({
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => Date.parse("2026-08-04T11:33:00.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(generatedTurnGroups, [
    ["turn-1", "turn-2"],
    ["turn-3"],
  ]);
});

test("persists an oversized single source as a retryable error without a fallback", async (t) => {
  const { database, repository } = await fixture(t);
  repository.ingestObservation(observation(1));
  let generations = 0;
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 8_000 }) },
      create: async () => {
        generations += 1;
        return { output_text: "{}" };
      },
    },
  } as unknown as OpenAI;
  const now = Date.parse("2026-08-04T10:01:15.000Z");

  const result = await processNextActivity({
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => now,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /single source exceeds/i);
  assert.equal(generations, 0);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, retry_remaining, retry_at, last_error FROM activity_jobs
  `).get() }, {
    status: "error",
    retry_remaining: 2,
    retry_at: now + 60 * 60_000,
    last_error: result.error,
  });
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM activity_records",
  ).get()?.count, 0);
});

test("does not count an oversized first source twice while finding a fitting prefix", async (t) => {
  const { repository } = await fixture(t);
  repository.ingestObservation(observation(1));
  repository.ingestObservation(observation(2));
  let countCalls = 0;
  const client = {
    responses: {
      inputTokens: { count: async () => {
        countCalls += 1;
        return { input_tokens: 8_000 };
      } },
      create: async () => {
        throw new Error("model generation should not run");
      },
    },
  } as unknown as OpenAI;

  const result = await processNextActivity({
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => Date.parse("2026-08-04T10:01:15.000Z"),
  });

  assert.equal(result.status, "failed");
  assert.equal(countCalls, 2);
});

test("uses the injected clock for Activity heartbeats", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { repository } = await fixture(t);
  repository.ingestObservation(observation(1));
  const now = Date.parse("2026-08-04T10:01:15.000Z");
  let heartbeatAt: number | undefined;
  repository.heartbeat = (
    _jobKey: string,
    _ownershipToken: string,
    at: number,
  ) => {
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
      create: async (request: { input: Array<{ content: string }> }) =>
        responseForRequest(request),
    },
  } as unknown as OpenAI;

  const processing = processNextActivity({
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

test("marks a model attempt failed when one activity combines different Turn statuses", async (t) => {
  const { database, repository } = await fixture(t);
  const completed = turn(1);
  const failed = turn(2);
  failed.turn.status = "failed";
  repository.ingestTurn({
    sessionId: "session-1",
    source: completed,
    projectedInputTokens: 100,
    maxInputTokens: 10_000,
  });
  repository.ingestTurn({
    sessionId: "session-1",
    source: failed,
    projectedInputTokens: 200,
    maxInputTokens: 10_000,
  });
  const now = Date.parse("2026-08-04T11:33:00.000Z");
  repository.sealDueTurnBatches(now);
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async (request: { input: Array<{ content: string }> }) =>
        responseForRequest(request),
    },
  } as unknown as OpenAI;

  const result = await processNextActivity({
    repository,
    client,
    model: "summary-model",
    workerId: "worker-1",
    contextWindowTokens: 10_000,
    now: () => now,
  });

  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /different statuses/i);
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT status, error FROM model_attempts
  `).get() }, {
    status: "failed",
    error: "One activity cannot combine sources with different statuses",
  });
});
