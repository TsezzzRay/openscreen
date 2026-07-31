import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { readActivityRecords } from "../../src/harness/memory/activity/store.js";
import {
  activitySourceKey,
  buildActivityRequest,
  processActivitySource,
} from "../../src/harness/memory/activity/processor.js";
import type {
  ScreenActivitySource,
  TurnActivitySource,
} from "../../src/harness/memory/activity/types.js";

const screen: ScreenActivitySource = {
  type: "screen_observation",
  observation: {
    schemaVersion: 1,
    id: "observation-1",
    occurredAt: "2026-07-27T00:00:00.000Z",
    capturedAt: "2026-07-27T00:00:00.100Z",
    trigger: { type: "focusedWindowChanged" },
    window: {
      processIdentifier: 42,
      applicationName: "Safari",
      title: "OpenScreen",
    },
    screenshot: {
      status: "complete",
      durationMilliseconds: 20,
      mimeType: "image/jpeg",
      dataBase64: "encoded-image",
      width: 1280,
      height: 720,
    },
    accessibility: {
      status: "complete",
      durationMilliseconds: 15,
      snapshot: {
        nodeCount: 1,
        truncated: false,
        root: { role: "AXWindow", title: "OpenScreen" },
      },
    },
    visibleText: "Activity memory design",
    url: "https://example.com/design",
    diagnostics: {
      triggerToCaptureMilliseconds: 100,
      screenshotDurationMilliseconds: 20,
      accessibilityDurationMilliseconds: 15,
    },
  },
};

test("builds one JSON Responses request for a screen observation and its image", () => {
  const request = buildActivityRequest("vision-model", screen, 4096);
  const body = JSON.stringify(request);

  assert.equal(request.model, "vision-model");
  assert.equal(request.max_output_tokens, 4096);
  assert.match(String(request.instructions), /verbatimEvidence/);
  assert.equal((body.match(/encoded-image/g) ?? []).length, 1);

  const input = request.input as Array<{
    content: Array<{ type: string; text?: string; image_url?: string }>;
  }>;
  assert.equal(input.length, 1);
  assert.equal(input[0]?.content[1]?.type, "input_image");
  assert.equal(
    input[0]?.content[1]?.image_url,
    "data:image/jpeg;base64,encoded-image",
  );

  const observation = JSON.parse(input[0]?.content[0]?.text ?? "").observation;
  assert.equal(observation.id, "observation-1");
  assert.equal(observation.visibleText, "Activity memory design");
  assert.equal(observation.screenshot.dataBase64, undefined);
});

test("uses the MiniMax M3 image shape in the same JSON request", () => {
  const request = buildActivityRequest("MiniMax-M3", screen, 4096);
  const input = request.input as Array<{
    content: Array<{ type: string; image_url?: unknown }>;
  }>;

  assert.deepEqual(input[0]?.content[1], {
    type: "input_image",
    image_url: {
      url: "data:image/jpeg;base64,encoded-image",
      detail: "default",
    },
  });
});

test("uses one turn source for a conversation with an Agent Run", () => {
  const source: TurnActivitySource = {
    type: "turn",
    sessionId: "session-1",
    occurredAt: "2026-07-27T01:00:00.000Z",
    turn: {
      id: "turn-1",
      user: "Inspect the repository",
      assistant: "The tests pass.",
      status: "completed",
      startedAt: "2026-07-27T00:58:00.000Z",
      finishedAt: "2026-07-27T01:00:00.000Z",
    },
    agentRuns: [{
      id: "run-1",
      turnId: "turn-1",
      status: "completed",
      startedAt: "2026-07-27T00:59:00.000Z",
      steps: [{
        step: 1,
        outputItems: [],
        toolResults: [{
          callId: "call-1",
          name: "run_tests",
          output: "39 tests passed",
          status: "completed",
        }],
      }],
    }],
  };

  const request = buildActivityRequest("vision-model", source, 4096);
  const input = request.input as Array<{ content: string }>;
  const payload = JSON.parse(input[0]?.content ?? "");

  assert.equal(activitySourceKey(source), "turn:session-1:turn-1");
  assert.equal(payload.turn.id, "turn-1");
  assert.equal(payload.agentRuns[0].id, "run-1");
  assert.equal(payload.agentRuns[0].turnId, "turn-1");
  assert.equal(payload.agentRuns[0].steps[0].toolResults[0].name, "run_tests");
});

test("rejects an Agent Run that does not belong to its turn", () => {
  const source: TurnActivitySource = {
    type: "turn",
    sessionId: "session-1",
    occurredAt: "2026-07-27T01:00:00.000Z",
    turn: {
      id: "turn-1",
      user: "Inspect the repository",
      assistant: "",
      status: "failed",
      startedAt: "2026-07-27T00:58:00.000Z",
      finishedAt: "2026-07-27T01:00:00.000Z",
    },
    agentRuns: [{
      id: "run-1",
      turnId: "other-turn",
      status: "failed",
      startedAt: "2026-07-27T00:59:00.000Z",
      steps: [],
    }],
  };

  assert.throws(() => activitySourceKey(source), /must reference the source Turn/);
});

test("generates and persists one activity record per source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => {
        generations += 1;
        return {
          output_text: JSON.stringify({
            summary: "The user viewed an activity-memory design.",
            application: "Safari",
            windowTitle: "OpenScreen",
            entities: ["OpenScreen"],
            verbatimEvidence: ["Activity memory design"],
          }),
        };
      },
    },
  } as unknown as OpenAI;

  const first = await processActivitySource({
    root,
    client,
    model: "vision-model",
    source: screen,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-27T00:00:01.000Z"),
  });
  const duplicate = await processActivitySource({
    root,
    client,
    model: "vision-model",
    source: screen,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-27T00:00:02.000Z"),
  });

  assert.equal(first.status, "created");
  assert.equal(first.record?.id, "activity:screen_observation:observation-1");
  assert.equal(first.record?.status, "observed");
  assert.deepEqual(first.record?.sources, [{
    type: "screen_observation",
    observationId: "observation-1",
  }]);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(generations, 1);
  assert.equal((await readActivityRecords(root)).length, 1);
});

test("discards an over-limit source without generating or persisting activity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 1000 }),
      },
      create: async () => {
        generations += 1;
        return { output_text: "{}" };
      },
    },
  } as unknown as OpenAI;

  const result = await processActivitySource({
    root,
    client,
    model: "vision-model",
    source: screen,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  });

  assert.equal(result.status, "discarded");
  assert.equal(generations, 0);
  assert.deepEqual(await readActivityRecords(root), []);
});

test("serializes concurrent processing of the same activity source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => {
        generations += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return {
          output_text: JSON.stringify({
            summary: "The user viewed an activity-memory design.",
            entities: [],
            verbatimEvidence: [],
          }),
        };
      },
    },
  } as unknown as OpenAI;
  const options = {
    root,
    client,
    model: "vision-model",
    source: screen,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  };

  const results = await Promise.all([
    processActivitySource(options),
    processActivitySource(options),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["created", "duplicate"],
  );
  assert.equal(generations, 1);
  assert.equal((await readActivityRecords(root)).length, 1);
});

test("persists structurally valid activity output without classifying it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          summary: "A credential was visible.",
          entities: [],
          verbatimEvidence: ["OPENAI_API_KEY=sk-12345678901234567890"],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processActivitySource({
    root,
    client,
    model: "vision-model",
    source: screen,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  });
  assert.equal(result.status, "created");
  assert.deepEqual(
    (await readActivityRecords(root))[0]?.verbatimEvidence,
    ["OPENAI_API_KEY=sk-12345678901234567890"],
  );
});
