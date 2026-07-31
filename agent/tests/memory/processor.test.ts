import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import {
  appendMemoryEvent,
  readMemoryEvents,
} from "../../src/harness/memory/store.js";
import { appendActivityRecord } from "../../src/harness/memory/activity/store.js";
import {
  processMemoryIfDue,
  readActiveMemories,
} from "../../src/harness/memory/processor.js";
import type { ActivityRecord } from "../../src/harness/memory/activity/types.js";

const timeline: ActivityRecord = {
  schemaVersion: 1,
  id: "activity:turn:session-1:turn-1",
  occurredAt: "2026-07-27T00:00:00.000Z",
  createdAt: "2026-07-27T00:00:01.000Z",
  sources: [{
    type: "turn",
    turnId: "turn-1",
    sessionId: "session-1",
    agentRunIds: [],
  }],
  status: "completed",
  summary: "The user decided to run activity memory every 24 hours.",
  entities: ["activity memory"],
  verbatimEvidence: ["暂定每24小时请求"],
};

type MemoryOptions = Parameters<typeof processMemoryIfDue>[0];

function processMemory(
  options: Omit<MemoryOptions, "processingIntervalMinutes"> &
    Partial<Pick<MemoryOptions, "processingIntervalMinutes">>,
) {
  return processMemoryIfDue({
    processingIntervalMinutes: 1_440,
    ...options,
  });
}

test("processes pending activity records after the configured memory interval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async (request: { instructions: string }) => {
        generations += 1;
        assert.match(request.instructions, /evidenceActivityIds/);
        return {
          output_text: JSON.stringify({
            decisions: [{
              action: "create",
              topic: "Activity memory schedule",
              content: "The user chose a 24-hour memory processing interval.",
              evidenceActivityIds: [timeline.id],
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;

  const early = await processMemory({
    root,
    client,
    model: "vision-model",
    processingIntervalMinutes: 60,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-27T01:00:00.000Z"),
  });
  const due = await processMemory({
    root,
    client,
    model: "vision-model",
    processingIntervalMinutes: 60,
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-27T01:00:01.000Z"),
  });

  assert.equal(early.status, "not_due");
  assert.equal(due.status, "processed");
  assert.equal(generations, 1);
  const events = await readMemoryEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "processed");
  assert.deepEqual(events[0]?.activityIds, [timeline.id]);
  assert.equal(events[0]?.changes[0]?.action, "create");
});

test("records an empty due cycle without calling the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
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
            decisions: [{
              action: "create",
              topic: "Activity memory schedule",
              content: "The user chose a 24-hour memory processing interval.",
              evidenceActivityIds: [timeline.id],
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;
  const options = {
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  };
  await processMemory({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  const empty = await processMemory({
    ...options,
    now: () => new Date("2026-07-29T00:00:01.000Z"),
  });
  const shortlyAfter = await processMemory({
    ...options,
    now: () => new Date("2026-07-29T00:01:01.000Z"),
  });

  assert.equal(empty.status, "no_pending");
  assert.equal(shortlyAfter.status, "not_due");
  assert.equal(generations, 1);
  const events = await readMemoryEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.status, "no_pending");
  assert.deepEqual(events[1]?.activityIds, []);
});

test("marks skipped activity records as processed without creating memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [{
            action: "skip",
            evidenceActivityIds: [timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
  const [event] = await readMemoryEvents(root);
  assert.deepEqual(event?.activityIds, [timeline.id]);
  assert.deepEqual(event?.changes, []);
});

test("supersedes an active memory using new activity evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  let generation = 0;
  let oldMemoryId = "";
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async (request: { input: Array<{ content: string }> }) => {
        generation += 1;
        if (generation === 1) {
          return {
            output_text: JSON.stringify({
              decisions: [{
                action: "create",
                topic: "Activity memory schedule",
                content: "The user chose a 24-hour memory processing interval.",
                evidenceActivityIds: [timeline.id],
              }],
            }),
          };
        }
        const payload = JSON.parse(request.input[0]?.content ?? "");
        assert.equal(payload.activeMemories.length, 1);
        assert.equal(payload.activeMemories[0].id, oldMemoryId);
        assert.deepEqual(
          payload.activityRecords.map(({ id }: { id: string }) => id),
          ["activity:turn:session-1:turn-2"],
        );
        return {
          output_text: JSON.stringify({
            decisions: [{
              action: "supersede",
              memoryId: oldMemoryId,
              topic: "Activity memory schedule",
              content: "The user chose a 12-hour memory processing interval.",
              evidenceActivityIds: ["activity:turn:session-1:turn-2"],
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;
  const options = {
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  };

  await processMemory({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  oldMemoryId = (await readActiveMemories(root))[0]!.id;
  await appendActivityRecord(root, {
    ...timeline,
    id: "activity:turn:session-1:turn-2",
    occurredAt: "2026-07-28T01:00:00.000Z",
    createdAt: "2026-07-28T01:00:01.000Z",
    sources: [{
      type: "turn",
      turnId: "turn-2",
      sessionId: "session-1",
      agentRunIds: [],
    }],
    summary: "The user changed the activity-memory interval to 12 hours.",
    verbatimEvidence: ["改成每12小时"],
  });

  const result = await processMemory({
    ...options,
    now: () => new Date("2026-07-29T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
  const active = await readActiveMemories(root);
  assert.equal(active.length, 1);
  assert.notEqual(active[0]?.id, oldMemoryId);
  assert.match(active[0]?.content ?? "", /12-hour/);
  assert.deepEqual(active[0]?.evidenceActivityIds, [
    timeline.id,
    "activity:turn:session-1:turn-2",
  ]);
});

test("splits one due memory run when all pending activities exceed context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const second: ActivityRecord = {
    ...timeline,
    id: "activity:turn:session-1:turn-2",
    occurredAt: "2026-07-27T00:01:00.000Z",
    createdAt: "2026-07-27T00:01:01.000Z",
    sources: [{
      type: "turn" as const,
      turnId: "turn-2",
      sessionId: "session-1",
      agentRunIds: [],
    }],
  };
  await appendActivityRecord(root, timeline);
  await appendActivityRecord(root, second);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async (request: { input: Array<{ content: string }> }) => {
          const payload = JSON.parse(request.input[0]?.content ?? "");
          return {
            input_tokens: payload.activityRecords.length === 1 ? 500 : 1500,
          };
        },
      },
      create: async (request: { input: Array<{ content: string }> }) => {
        generations += 1;
        const payload = JSON.parse(request.input[0]?.content ?? "");
        return {
          output_text: JSON.stringify({
            decisions: [{
              action: "skip",
              evidenceActivityIds: payload.activityRecords.map(
                ({ id }: { id: string }) => id,
              ),
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:01:01.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.equal(generations, 2);
  const events = await readMemoryEvents(root);
  assert.deepEqual(
    events.map(({ activityIds }) => activityIds),
    [[timeline.id], [second.id]],
  );
});

test("records a failed memory attempt and waits until the next interval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => {
        generations += 1;
        throw new Error("Provider unavailable");
      },
    },
  } as unknown as OpenAI;
  const options = {
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
  };

  const failed = await processMemory({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  const shortlyAfter = await processMemory({
    ...options,
    now: () => new Date("2026-07-28T00:01:01.000Z"),
  });

  assert.equal(failed.status, "failed");
  assert.equal(shortlyAfter.status, "not_due");
  assert.equal(generations, 1);
  const [event] = await readMemoryEvents(root);
  assert.equal(event?.status, "failed");
  assert.deepEqual(event?.activityIds, [timeline.id]);
  assert.match(event?.error ?? "", /Provider unavailable/);
});

test("accepts structurally valid memory content without classifying it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [{
            action: "create",
            topic: "API key",
            content: "OPENAI_API_KEY=sk-12345678901234567890",
            evidenceActivityIds: [timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(
    (await readActiveMemories(root)).map(({ topic, content }) => ({ topic, content })),
    [{
      topic: "API key",
      content: "OPENAI_API_KEY=sk-12345678901234567890",
    }],
  );
});

test("anchors the first memory interval to the earliest activity creation time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processedLate: ActivityRecord = {
    ...timeline,
    id: "activity:screen_observation:late",
    occurredAt: "2026-07-26T00:00:00.000Z",
    createdAt: "2026-07-28T00:00:00.000Z",
    sources: [{ type: "screen_observation", observationId: "late" }],
    status: "observed",
  };
  await appendActivityRecord(root, processedLate);
  await appendActivityRecord(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [{
            action: "skip",
            evidenceActivityIds: [processedLate.id, timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
});

test("rejects a memory change without activity evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [
            {
              action: "create",
              topic: "Unsupported memory",
              content: "This memory has no source evidence.",
              evidenceActivityIds: [],
            },
            {
              action: "skip",
              evidenceActivityIds: [timeline.id],
            },
          ],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(await readActiveMemories(root), []);
});

test("rejects multiple supersede decisions for the same active memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldMemory = {
    id: "memory:old",
    topic: "Activity memory schedule",
    content: "The user chose a 24-hour memory processing interval.",
    createdAt: "2026-07-28T00:00:01.000Z",
    updatedAt: "2026-07-28T00:00:01.000Z",
    evidenceActivityIds: [timeline.id] as [string],
  };
  await appendMemoryEvent(root, {
    schemaVersion: 1,
    type: "memory_run",
    id: "memory-run:first",
    attemptedAt: "2026-07-28T00:00:01.000Z",
    status: "processed",
    activityIds: [timeline.id],
    changes: [{ action: "create", memory: oldMemory }],
  });
  const next: ActivityRecord = {
    ...timeline,
    id: "activity:turn:session-1:turn-2",
    occurredAt: "2026-07-28T01:00:00.000Z",
    createdAt: "2026-07-28T01:00:01.000Z",
    sources: [{
      type: "turn",
      turnId: "turn-2",
      sessionId: "session-1",
      agentRunIds: [],
    }],
  };
  await appendActivityRecord(root, next);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [
            {
              action: "supersede",
              memoryId: oldMemory.id,
              topic: "First replacement",
              content: "First replacement content.",
              evidenceActivityIds: [next.id],
            },
            {
              action: "supersede",
              memoryId: oldMemory.id,
              topic: "Second replacement",
              content: "Second replacement content.",
              evidenceActivityIds: [next.id],
            },
          ],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-29T00:00:01.000Z"),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(await readActiveMemories(root), [oldMemory]);
});

test("persists provider errors without content classification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendActivityRecord(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => {
        throw new Error("Provider rejected sk-12345678901234567890");
      },
    },
  } as unknown as OpenAI;

  await processMemory({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(
    (await readMemoryEvents(root))[0]?.error,
    "Provider rejected sk-12345678901234567890",
  );
});
