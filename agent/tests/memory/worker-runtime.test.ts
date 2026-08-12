import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import OpenAI from "openai";

import { MemoryPipeline } from "../../src/harness/memory/worker/runtime.js";
import { persistObservationEvidence } from "../../src/harness/memory/evidence.js";
import {
  appendSessionEvents,
  createSession,
} from "../../src/harness/session/store.js";
import type { ScreenObservation } from "../../src/extensions/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

const observation: ScreenObservation = {
  schemaVersion: 1,
  id: "observation-1",
  captureId: "capture-1",
  activityRevision: 1,
  occurredAt: "2026-08-04T10:00:01.000Z",
  capturedAt: "2026-08-04T10:00:01.100Z",
  trigger: { type: "focusedWindowChanged" },
  window: { processIdentifier: 42, applicationName: "Safari" },
  screenshot: {
    status: "complete",
    durationMilliseconds: 1,
    dataBase64: "worker-thread-evidence",
  },
  accessibility: { status: "complete", durationMilliseconds: 1 },
  visibleText: "OpenScreen memory",
  diagnostics: {
    triggerToCaptureMilliseconds: 1,
    screenshotDurationMilliseconds: 1,
    accessibilityDurationMilliseconds: 1,
  },
};

test("recovers Turns and independently runs Chronicle, Turn Memory, and consolidation", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const memoryRoot = join(dataRoot, "memory");
  const session = await createSession(sessionsDirectory);
  await appendSessionEvents(sessionsDirectory, session.id, [
    {
      type: "turn_started",
      turn: { id: "turn-1", user: "Remember the pipeline", startedAt: "2026-08-04T09:00:00.000Z" },
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Remember the pipeline",
        assistant: "Recorded",
        status: "completed",
        startedAt: "2026-08-04T09:00:00.000Z",
        finishedAt: "2026-08-04T09:01:00.000Z",
      },
    },
    {
      type: "turn_started",
      turn: { id: "turn-interrupted", user: "Interrupted request", startedAt: "2026-08-04T09:02:00.000Z" },
    },
  ]);

  let activityRequests = 0;
  let consolidationRequests = 0;
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 100 }) },
      create: async (request: { instructions: string; input: Array<{ content: string }> }) => {
        const payload = JSON.parse(request.input[0]?.content ?? "{}");
        if (request.instructions.includes("Organize a closed window")) {
          activityRequests += 1;
          return {
            output_text: JSON.stringify({
              activities: [{
                summary: "The user worked on OpenScreen memory.",
                source_ids: payload.observations.map(
                  ({ sourceId }: { sourceId: string }) => sourceId,
                ),
                application: "Safari",
                window_title: null,
              }],
              source_summary: "OpenScreen memory activity.",
            }),
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          };
        }
        if (request.instructions.includes("Extract durable memory")) {
          activityRequests += 1;
          return {
            output_text: JSON.stringify({
              raw_memory: "The user asked OpenScreen to remember the pipeline.",
              turn_summary: "The user asked to remember the OpenScreen pipeline.",
              turn_slug: "remember-pipeline",
            }),
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          };
        }
        consolidationRequests += 1;
        const evidenceSourceIds = payload.validEvidenceSourceIds as string[];
        return {
          output_text: JSON.stringify({
            memories: [{
              key: "openscreen-memory",
              title: "OpenScreen memory",
              scope: { type: "topic", key: "openscreen-memory" },
              content: "The user is working on OpenScreen memory.",
              evidence_source_ids: evidenceSourceIds,
            }],
            summary: [{ memory_key: "openscreen-memory", text: "OpenScreen memory work." }],
          }),
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        };
      },
    },
  } as unknown as OpenAI;
  let now = Date.parse("2026-08-04T10:00:02.000Z");
  const pipeline = new MemoryPipeline({
    memoryRoot,
    sessionsDirectory,
    client,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
    now: () => now,
  });
  t.after(() => pipeline.close());

  await pipeline.scanSessions({ includeInterrupted: true });
  await pipeline.ingestObservation(observation);
  assert.equal(pipeline.database.connection.prepare(`
    SELECT
      (SELECT count(*) FROM chronicle_sources) +
      (SELECT count(*) FROM turn_memory_sources) AS count
  `).get()?.count, 3);

  now = Date.parse("2026-08-04T12:00:00.000Z");
  await pipeline.tick();

  assert.equal(activityRequests, 2);
  assert.equal(consolidationRequests, 1);
  assert.match(await readFile(join(memoryRoot, "MEMORY.md"), "utf8"), /OpenScreen memory/);
  assert.match(await readFile(join(memoryRoot, "memory_summary.md"), "utf8"), /^v1\n/);
  const sidecar = pipeline.database.connection.prepare(`
    SELECT structured_path FROM chronicle_sources
    WHERE id = 'observation:observation-1'
  `).get()?.structured_path;
  assert.equal(typeof sidecar, "string");
  await access(join(memoryRoot, String(sidecar)));
});

test("does not let cleanup delete a durable sidecar before its source row commits", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const memoryRoot = join(dataRoot, "memory");
  let durable!: () => void;
  const sidecarDurable = new Promise<void>((resolve) => {
    durable = resolve;
  });
  let release!: () => void;
  const allowDatabaseInsert = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pipeline = new MemoryPipeline({
    memoryRoot,
    sessionsDirectory: join(dataRoot, "sessions"),
    client: { responses: {} } as unknown as OpenAI,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
    persistObservationEvidence: async (root, value) => {
      const evidence = await persistObservationEvidence(root, value);
      durable();
      await allowDatabaseInsert;
      return evidence;
    },
  });
  t.after(() => pipeline.close());

  const ingest = pipeline.ingestObservation({
    ...observation,
    id: "cleanup-race",
    occurredAt: "2026-08-04T23:00:00.000Z",
    capturedAt: "2026-08-04T23:00:00.100Z",
  });
  await sidecarDurable;
  const cleanup = pipeline.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await ingest;
  await cleanup;

  const sidecar = pipeline.database.connection.prepare(`
    SELECT structured_path FROM chronicle_sources WHERE id = 'observation:cleanup-race'
  `).get()?.structured_path;
  assert.equal(typeof sidecar, "string");
  await access(join(memoryRoot, String(sidecar)));
});

test("normal scans do not mistake an active Turn for a crashed interrupted Turn", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const session = await createSession(sessionsDirectory);
  await appendSessionEvents(sessionsDirectory, session.id, [{
    type: "turn_started",
    turn: { id: "active", user: "Still running", startedAt: new Date().toISOString() },
  }]);
  const pipeline = new MemoryPipeline({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory,
    client: { responses: {} } as unknown as OpenAI,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => pipeline.close());

  await pipeline.scanSession(session.id, { includeInterrupted: false });

  assert.equal(pipeline.database.connection.prepare(
    "SELECT count(*) AS count FROM turn_memory_sources",
  ).get()?.count, 0);
});

test("uses a local estimate when startup token counting fails", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const session = await createSession(sessionsDirectory);
  await appendSessionEvents(sessionsDirectory, session.id, [{
    type: "turn_started",
    turn: {
      id: "interrupted",
      user: "Recover this after restart",
      startedAt: "2026-08-04T09:00:00.000Z",
    },
  }]);
  let counts = 0;
  const pipeline = new MemoryPipeline({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory,
    client: {
      responses: {
        inputTokens: { count: async () => {
          counts += 1;
          throw new Error("temporary token counter failure");
        } },
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => pipeline.close());
  const startup = await pipeline.captureSessionSources({ includeInterrupted: true });

  await pipeline.ingestCapturedSessions(startup);
  assert.equal(counts, 1);
  assert.equal(pipeline.database.connection.prepare(
    "SELECT count(*) AS count FROM turn_memory_sources",
  ).get()?.count, 1);
});

test("uses exact model token counting and the effective Turn Memory budget", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const session = await createSession(sessionsDirectory);
  await appendSessionEvents(sessionsDirectory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Count this request exactly",
        startedAt: "2026-08-04T09:00:00.000Z",
      },
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Count this request exactly",
        assistant: "Counted",
        status: "completed",
        startedAt: "2026-08-04T09:00:00.000Z",
        finishedAt: "2026-08-04T09:01:00.000Z",
      },
    },
  ]);
  let countCalls = 0;
  const pipeline = new MemoryPipeline({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory,
    client: {
      responses: {
        inputTokens: { count: async () => {
          countCalls += 1;
          return { input_tokens: 321 };
        } },
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => pipeline.close());

  await pipeline.scanSession(session.id);

  assert.equal(countCalls, 1);
  assert.deepEqual({ ...pipeline.database.connection.prepare(`
    SELECT projected_input_tokens, max_input_tokens FROM turn_memory_batches
  `).get() }, {
    projected_input_tokens: 321,
    max_input_tokens: 7000,
  });
});

test("isolates a Turn that exceeds the Turn Memory budget from adjacent Turns", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const session = await createSession(sessionsDirectory);
  for (let index = 1; index <= 3; index += 1) {
    const startedAt = new Date(
      Date.parse("2026-08-04T09:00:00.000Z") + index * 60_000,
    ).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + 30_000).toISOString();
    await appendSessionEvents(sessionsDirectory, session.id, [
      {
        type: "turn_started",
        turn: { id: `turn-${index}`, user: `Request ${index}`, startedAt },
      },
      {
        type: "turn_completed",
        turn: {
          id: `turn-${index}`,
          user: `Request ${index}`,
          assistant: `Result ${index}`,
          status: "completed",
          startedAt,
          finishedAt,
        },
      },
    ]);
  }
  const measuredGroups: string[][] = [];
  const pipeline = new MemoryPipeline({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory,
    client: {
      responses: {
        inputTokens: { count: async (request: { input: Array<{ content: string }> }) => {
          const payload = JSON.parse(request.input[0]?.content ?? "{}") as {
            turns: Array<{ turnId: string }>;
          };
          const ids = payload.turns.map(({ turnId }) => turnId);
          measuredGroups.push(ids);
          return {
            input_tokens: ids.includes("turn-2")
              ? ids.length === 1 ? 800 : 900
              : 500,
          };
        } },
      },
    } as unknown as OpenAI,
    model: "summary-model",
    workerId: "memory-worker-test",
    contextWindowTokens: 1_000,
    memory: testMemoryConfig({
      turnMemory: { maxInputTokens: 900, maxOutputTokens: 100 },
      consolidation: { maxInputTokens: 900, maxOutputTokens: 100 },
    }),
  });
  t.after(() => pipeline.close());

  await pipeline.scanSession(session.id);

  assert.deepEqual(measuredGroups, [
    ["turn-1"],
    ["turn-1", "turn-2"],
    ["turn-2"],
    ["turn-3"],
  ]);
  assert.deepEqual(pipeline.database.connection.prepare(`
    SELECT b.status, b.close_reason,
           group_concat(s.turn_id, ',') AS turn_ids
    FROM turn_memory_batches b
    JOIN turn_memory_batch_sources bs ON bs.batch_id = b.id
    JOIN turn_memory_sources s ON s.id = bs.source_id
    GROUP BY b.id
    ORDER BY b.first_pending_at
  `).all().map((row) => ({ ...row })), [
    { status: "sealed", close_reason: "budget", turn_ids: "turn-1" },
    { status: "sealed", close_reason: "budget", turn_ids: "turn-2" },
    { status: "open", close_reason: null, turn_ids: "turn-3" },
  ]);
});
