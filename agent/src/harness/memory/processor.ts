import { randomUUID } from "node:crypto";

import type OpenAI from "openai";

import {
  appendMemoryEvent,
  readMemoryEvents,
} from "./store.js";
import { withMemoryLock } from "./lock.js";
import { readActivityRecords } from "./activity/store.js";
import type {
  LongTermMemory,
  MemoryChange,
  MemoryEvent,
} from "./types.js";
import type { ActivityRecord } from "./activity/types.js";

const MEMORY_INSTRUCTIONS = `Update OpenScreen long-term memory from activity records.
Return only JSON with a decisions array using these shapes:
{"action":"create","topic":"...","content":"...","evidenceActivityIds":["activity id"]}
{"action":"supersede","memoryId":"existing memory id","topic":"...","content":"...","evidenceActivityIds":["activity id"]}
{"action":"skip","evidenceActivityIds":["activity id"]}
Every input activity ID must appear in at least one decision.
Use create for explicit, stable user facts, preferences, project decisions, or durable state.
Use skip for transient screen content, one-time actions, ordinary browsing, assistant inference, or duplicates.
Use supersede only when new evidence clearly replaces an existing memory.
Never store passwords, tokens, private keys, or other secrets.
Write generated memory in English while preserving quoted user evidence verbatim.`;

type CreateDecision = {
  action: "create";
  topic: string;
  content: string;
  evidenceActivityIds: string[];
};

type SkipDecision = {
  action: "skip";
  evidenceActivityIds: string[];
};

type SupersedeDecision = {
  action: "supersede";
  memoryId: string;
  topic: string;
  content: string;
  evidenceActivityIds: string[];
};

type MemoryDecision = CreateDecision | SkipDecision | SupersedeDecision;

function parseDecisions(
  output: string,
  pending: ActivityRecord[],
  activeMemories: LongTermMemory[],
): MemoryDecision[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Model returned invalid memory JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray((value as Record<string, unknown>).decisions)) {
    throw new Error("Model returned invalid memory JSON");
  }
  const allowed = new Set(pending.map(({ id }) => id));
  const activeIds = new Set(activeMemories.map(({ id }) => id));
  const decisions = (value as { decisions: unknown[] }).decisions;
  const result: MemoryDecision[] = [];
  const covered = new Set<string>();
  const superseded = new Set<string>();
  for (const decision of decisions) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error("Model returned an invalid memory decision");
    }
    const record = decision as Record<string, unknown>;
    if (!Array.isArray(record.evidenceActivityIds) ||
        record.evidenceActivityIds.length === 0 ||
        !record.evidenceActivityIds.every((id) => typeof id === "string" && allowed.has(id))) {
      throw new Error("Model returned an invalid memory decision");
    }
    for (const id of record.evidenceActivityIds as string[]) covered.add(id);
    if (record.action === "skip") {
      result.push({
        action: "skip",
        evidenceActivityIds: record.evidenceActivityIds as string[],
      });
      continue;
    }
    if ((record.action !== "create" && record.action !== "supersede") ||
        typeof record.topic !== "string" || !record.topic.trim() ||
        typeof record.content !== "string" || !record.content.trim()) {
      throw new Error("Model returned an invalid memory decision");
    }
    if (record.action === "supersede") {
      if (typeof record.memoryId !== "string" || !activeIds.has(record.memoryId)) {
        throw new Error("Model tried to supersede an unknown memory");
      }
      if (superseded.has(record.memoryId)) {
        throw new Error("Model superseded the same memory more than once");
      }
      superseded.add(record.memoryId);
      result.push({
        action: "supersede",
        memoryId: record.memoryId,
        topic: record.topic.trim(),
        content: record.content.trim(),
        evidenceActivityIds: record.evidenceActivityIds as string[],
      });
      continue;
    }
    result.push({
      action: "create",
      topic: record.topic.trim(),
      content: record.content.trim(),
      evidenceActivityIds: record.evidenceActivityIds as string[],
    });
  }
  if (covered.size !== allowed.size) {
    throw new Error("Memory decisions did not cover every activity record");
  }
  return result;
}

function activeMemoriesFromEvents(events: MemoryEvent[]) {
  const active = new Map<string, LongTermMemory>();
  for (const event of events) {
    if (event.status !== "processed") continue;
    for (const change of event.changes) {
      if (change.action === "create") {
        active.set(change.memory.id, change.memory);
      } else {
        active.delete(change.memoryId);
        active.set(change.replacement.id, change.replacement);
      }
    }
  }
  return [...active.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readActiveMemories(root: string) {
  return activeMemoriesFromEvents(await readMemoryEvents(root));
}

function buildMemoryRequest(
  model: string,
  maxOutputTokens: number,
  activeMemories: LongTermMemory[],
  activityRecords: ActivityRecord[],
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  return {
    model,
    instructions: MEMORY_INSTRUCTIONS,
    input: [{
      role: "user",
      content: JSON.stringify({ activeMemories, activityRecords }),
    }],
    max_output_tokens: maxOutputTokens,
  };
}

async function largestFittingBatch(
  client: OpenAI,
  model: string,
  maxInputTokens: number,
  maxOutputTokens: number,
  activeMemories: LongTermMemory[],
  pending: ActivityRecord[],
  signal?: AbortSignal,
) {
  let low = 1;
  let high = pending.length;
  let best = 0;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const request = buildMemoryRequest(
      model,
      maxOutputTokens,
      activeMemories,
      pending.slice(0, candidate),
    );
    const inputTokens = (
      await client.responses.inputTokens.count({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
      }, { signal })
    ).input_tokens;
    if (inputTokens < maxInputTokens) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

function memoryChanges(
  decisions: MemoryDecision[],
  activeMemories: LongTermMemory[],
  attemptedAt: string,
) {
  const changes: MemoryChange[] = [];
  for (const decision of decisions) {
    if (decision.action === "skip") continue;
    const previous = decision.action === "supersede"
      ? activeMemories.find(({ id }) => id === decision.memoryId)
      : undefined;
    const evidenceActivityIds = [
      ...new Set([
        ...(previous?.evidenceActivityIds ?? []),
        ...decision.evidenceActivityIds,
      ]),
    ];
    const memory: LongTermMemory = {
      id: `memory:${randomUUID()}`,
      topic: decision.topic,
      content: decision.content,
      createdAt: previous?.createdAt ?? attemptedAt,
      updatedAt: attemptedAt,
      evidenceActivityIds: [
        evidenceActivityIds[0]!,
        ...evidenceActivityIds.slice(1),
      ],
    };
    changes.push(decision.action === "create"
      ? { action: "create", memory }
      : {
          action: "supersede",
          memoryId: decision.memoryId,
          replacement: memory,
        });
  }
  return changes;
}

export async function processMemoryIfDue({
  root,
  client,
  model,
  processingIntervalMinutes,
  maxInputTokens,
  maxOutputTokens,
  now = () => new Date(),
  signal,
}: {
  root: string;
  client: OpenAI;
  model: string;
  processingIntervalMinutes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  now?: () => Date;
  signal?: AbortSignal;
}) {
  return withMemoryLock(root, async () => {
    const activities = await readActivityRecords(root);
    const events = await readMemoryEvents(root);
    let activeMemories = activeMemoriesFromEvents(events);
    const processed = new Set(events
      .filter((event) => event.status === "processed")
      .flatMap((event) => event.activityIds));
    const pending = activities.filter(({ id }) => !processed.has(id));

    const timestamp = now();
    const lastAttempt = events.at(-1)?.attemptedAt;
    if (!lastAttempt && pending.length === 0) {
      return { status: "no_pending" as const };
    }
    const firstPendingAt = pending.reduce(
      (earliest, { createdAt }) => Math.min(earliest, new Date(createdAt).valueOf()),
      Number.POSITIVE_INFINITY,
    );
    const dueAt = new Date(
      (lastAttempt
        ? new Date(lastAttempt)
        : new Date(firstPendingAt)).valueOf() +
        processingIntervalMinutes * 60_000,
    );
    if (timestamp < dueAt) {
      return { status: "not_due" as const, nextRunAt: dueAt.toISOString() };
    }
    if (pending.length === 0) {
      const event: MemoryEvent = {
        schemaVersion: 1,
        type: "memory_run",
        id: `memory-run:${randomUUID()}`,
        attemptedAt: timestamp.toISOString(),
        status: "no_pending",
        activityIds: [],
        changes: [],
      };
      await appendMemoryEvent(root, event);
      return { status: "no_pending" as const, events: [event] };
    }

    const attemptedAt = timestamp.toISOString();
    const newEvents: MemoryEvent[] = [];
    let remaining = pending;
    try {
      while (remaining.length > 0) {
        const batchSize = await largestFittingBatch(
          client,
          model,
          maxInputTokens,
          maxOutputTokens,
          activeMemories,
          remaining,
          signal,
        );
        if (batchSize === 0) {
          throw new Error("Memory input exceeds the model context budget");
        }
        const batch = remaining.slice(0, batchSize);
        const request = buildMemoryRequest(
          model,
          maxOutputTokens,
          activeMemories,
          batch,
        );
        const response = await client.responses.create(request, { signal });
        const decisions = parseDecisions(response.output_text, batch, activeMemories);
        const event: MemoryEvent = {
          schemaVersion: 1,
          type: "memory_run",
          id: `memory-run:${randomUUID()}`,
          attemptedAt,
          status: "processed",
          activityIds: batch.map(({ id }) => id),
          changes: memoryChanges(decisions, activeMemories, attemptedAt),
        };
        await appendMemoryEvent(root, event);
        events.push(event);
        newEvents.push(event);
        activeMemories = activeMemoriesFromEvents(events);
        remaining = remaining.slice(batchSize);
      }
      return { status: "processed" as const, events: newEvents };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Memory processing failed";
      const event: MemoryEvent = {
        schemaVersion: 1,
        type: "memory_run",
        id: `memory-run:${randomUUID()}`,
        attemptedAt,
        status: "failed",
        activityIds: remaining.map(({ id }) => id),
        changes: [],
        error: message,
      };
      await appendMemoryEvent(root, event);
      newEvents.push(event);
      return { status: "failed" as const, events: newEvents };
    }
  });
}
