import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import {
  appendMemoryEvent,
  appendTimelineEntry,
  readMemoryEvents,
} from "../../src/activity/store.js";
import {
  processMemoryIfDue,
  readActiveMemories,
} from "../../src/activity/memory.js";
import type { TimelineEntry } from "../../src/activity/types.js";

const timeline: TimelineEntry = {
  schemaVersion: 1,
  id: "timeline:turn:session-1:turn-1",
  occurredAt: "2026-07-27T00:00:00.000Z",
  createdAt: "2026-07-27T00:00:01.000Z",
  source: { type: "turn", id: "turn-1", sessionId: "session-1" },
  status: "completed",
  summary: "The user decided to run activity memory every 24 hours.",
  entities: ["activity memory"],
  verbatimEvidence: ["暂定每24小时请求"],
};

test("processes pending timeline entries after the 24-hour memory interval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async (request: { instructions: string }) => {
        generations += 1;
        assert.match(request.instructions, /evidenceTimelineIds/);
        return {
          output_text: JSON.stringify({
            decisions: [{
              action: "create",
              topic: "Activity memory schedule",
              content: "The user chose a 24-hour memory processing interval.",
              evidenceTimelineIds: [timeline.id],
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;

  const early = await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  const due = await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(early.status, "not_due");
  assert.equal(due.status, "processed");
  assert.equal(generations, 1);
  const events = await readMemoryEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "processed");
  assert.deepEqual(events[0]?.timelineEntryIds, [timeline.id]);
  assert.equal(events[0]?.changes[0]?.action, "create");
});

test("records an empty due cycle without calling the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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
              evidenceTimelineIds: [timeline.id],
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
  await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  const empty = await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-29T00:00:01.000Z"),
  });
  const shortlyAfter = await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-29T00:01:01.000Z"),
  });

  assert.equal(empty.status, "no_pending");
  assert.equal(shortlyAfter.status, "not_due");
  assert.equal(generations, 1);
  const events = await readMemoryEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.status, "no_pending");
  assert.deepEqual(events[1]?.timelineEntryIds, []);
});

test("marks skipped timeline entries as processed without creating memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [{
            action: "skip",
            evidenceTimelineIds: [timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
  const [event] = await readMemoryEvents(root);
  assert.deepEqual(event?.timelineEntryIds, [timeline.id]);
  assert.deepEqual(event?.changes, []);
});

test("supersedes an active memory using new timeline evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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
                evidenceTimelineIds: [timeline.id],
              }],
            }),
          };
        }
        const payload = JSON.parse(request.input[0]?.content ?? "");
        assert.equal(payload.activeMemories.length, 1);
        assert.equal(payload.activeMemories[0].id, oldMemoryId);
        assert.deepEqual(
          payload.timelineEntries.map(({ id }: { id: string }) => id),
          ["timeline:turn:session-1:turn-2"],
        );
        return {
          output_text: JSON.stringify({
            decisions: [{
              action: "supersede",
              memoryId: oldMemoryId,
              topic: "Activity memory schedule",
              content: "The user chose a 12-hour memory processing interval.",
              evidenceTimelineIds: ["timeline:turn:session-1:turn-2"],
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

  await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  oldMemoryId = (await readActiveMemories(root))[0]!.id;
  await appendTimelineEntry(root, {
    ...timeline,
    id: "timeline:turn:session-1:turn-2",
    occurredAt: "2026-07-28T01:00:00.000Z",
    createdAt: "2026-07-28T01:00:01.000Z",
    source: { type: "turn", id: "turn-2", sessionId: "session-1" },
    summary: "The user changed the activity-memory interval to 12 hours.",
    verbatimEvidence: ["改成每12小时"],
  });

  const result = await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-29T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
  const active = await readActiveMemories(root);
  assert.equal(active.length, 1);
  assert.notEqual(active[0]?.id, oldMemoryId);
  assert.match(active[0]?.content ?? "", /12-hour/);
  assert.deepEqual(active[0]?.evidenceTimelineIds, [
    timeline.id,
    "timeline:turn:session-1:turn-2",
  ]);
});

test("splits one due memory run when all pending timeline entries exceed context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const second = {
    ...timeline,
    id: "timeline:turn:session-1:turn-2",
    occurredAt: "2026-07-27T00:01:00.000Z",
    createdAt: "2026-07-27T00:01:01.000Z",
    source: { type: "turn" as const, id: "turn-2", sessionId: "session-1" },
  };
  await appendTimelineEntry(root, timeline);
  await appendTimelineEntry(root, second);
  let generations = 0;
  const client = {
    responses: {
      inputTokens: {
        count: async (request: { input: Array<{ content: string }> }) => {
          const payload = JSON.parse(request.input[0]?.content ?? "");
          return {
            input_tokens: payload.timelineEntries.length === 1 ? 500 : 1500,
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
              evidenceTimelineIds: payload.timelineEntries.map(
                ({ id }: { id: string }) => id,
              ),
            }],
          }),
        };
      },
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
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
    events.map(({ timelineEntryIds }) => timelineEntryIds),
    [[timeline.id], [second.id]],
  );
});

test("records a failed memory attempt and waits until the next interval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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

  const failed = await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });
  const shortlyAfter = await processMemoryIfDue({
    ...options,
    now: () => new Date("2026-07-28T00:01:01.000Z"),
  });

  assert.equal(failed.status, "failed");
  assert.equal(shortlyAfter.status, "not_due");
  assert.equal(generations, 1);
  const [event] = await readMemoryEvents(root);
  assert.equal(event?.status, "failed");
  assert.deepEqual(event?.timelineEntryIds, [timeline.id]);
  assert.match(event?.error ?? "", /Provider unavailable/);
});

test("rejects sensitive memory content before writing an active memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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
            evidenceTimelineIds: [timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(await readActiveMemories(root), []);
  assert.match((await readMemoryEvents(root))[0]?.error ?? "", /sensitive/i);
});

test("anchors the first memory interval to the earliest timeline creation time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processedLate: TimelineEntry = {
    ...timeline,
    id: "timeline:screen:late",
    occurredAt: "2026-07-26T00:00:00.000Z",
    createdAt: "2026-07-28T00:00:00.000Z",
    source: { type: "screen", id: "late" },
    status: "observed",
  };
  await appendTimelineEntry(root, processedLate);
  await appendTimelineEntry(root, timeline);
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 100 }),
      },
      create: async () => ({
        output_text: JSON.stringify({
          decisions: [{
            action: "skip",
            evidenceTimelineIds: [processedLate.id, timeline.id],
          }],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(result.status, "processed");
});

test("rejects a memory change without timeline evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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
              evidenceTimelineIds: [],
            },
            {
              action: "skip",
              evidenceTimelineIds: [timeline.id],
            },
          ],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
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
    evidenceTimelineIds: [timeline.id],
  };
  await appendMemoryEvent(root, {
    schemaVersion: 1,
    type: "memory_run",
    id: "memory-run:first",
    attemptedAt: "2026-07-28T00:00:01.000Z",
    status: "processed",
    timelineEntryIds: [timeline.id],
    changes: [{ action: "create", memory: oldMemory }],
  });
  const next: TimelineEntry = {
    ...timeline,
    id: "timeline:turn:session-1:turn-2",
    occurredAt: "2026-07-28T01:00:00.000Z",
    createdAt: "2026-07-28T01:00:01.000Z",
    source: { type: "turn", id: "turn-2", sessionId: "session-1" },
  };
  await appendTimelineEntry(root, next);
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
              evidenceTimelineIds: [next.id],
            },
            {
              action: "supersede",
              memoryId: oldMemory.id,
              topic: "Second replacement",
              content: "Second replacement content.",
              evidenceTimelineIds: [next.id],
            },
          ],
        }),
      }),
    },
  } as unknown as OpenAI;

  const result = await processMemoryIfDue({
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

test("does not persist credentials from a provider error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendTimelineEntry(root, timeline);
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

  await processMemoryIfDue({
    root,
    client,
    model: "vision-model",
    maxInputTokens: 1000,
    maxOutputTokens: 4096,
    now: () => new Date("2026-07-28T00:00:01.000Z"),
  });

  assert.equal(
    (await readMemoryEvents(root))[0]?.error,
    "Memory processing failed",
  );
});
