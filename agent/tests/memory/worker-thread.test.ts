import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import { MemoryWorkerClient } from "../../src/harness/memory/worker/client.js";
import {
  appendSessionEvents,
  createSession,
} from "../../src/harness/session/store.js";
import type { ScreenObservation } from "../../src/plugins/screen-observation/types.js";
import { testMemoryConfig } from "./test-config.js";

test("persists Observation messages in an independent Node Worker thread", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-thread-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const memoryRoot = join(dataRoot, "memory");
  const client = new MemoryWorkerClient({
    memoryRoot,
    sessionsDirectory: join(dataRoot, "sessions"),
    apiKey: "test",
    baseURL: "http://127.0.0.1:1/v1",
    model: "summary-model",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => client.stop());
  await client.ready();
  assert.ok(client.threadId > 0);

  const now = new Date();
  const observation: ScreenObservation = {
    schemaVersion: 1,
    id: "thread-observation",
    occurredAt: now.toISOString(),
    capturedAt: now.toISOString(),
    trigger: { type: "focusedWindowChanged" },
    window: { processIdentifier: 42, applicationName: "Safari" },
    screenshot: { status: "complete", durationMilliseconds: 1 },
    accessibility: { status: "complete", durationMilliseconds: 1 },
    visibleText: "Worker thread",
    diagnostics: {
      triggerToCaptureMilliseconds: 1,
      screenshotDurationMilliseconds: 1,
      accessibilityDurationMilliseconds: 1,
    },
  };
  await client.recordObservation(observation);
  await client.stop();

  const database = openMemoryDatabase(memoryRoot);
  t.after(() => database.close());
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM source_items WHERE id = 'observation:thread-observation'",
  ).get()?.count, 1);
});

test("persists new Observations while a background model request is running", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-thread-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let markModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    markModelStarted = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/responses/input_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (request.url?.endsWith("/responses")) {
      markModelStarted();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const memoryRoot = join(dataRoot, "memory");
  const client = new MemoryWorkerClient({
    memoryRoot,
    sessionsDirectory: join(dataRoot, "sessions"),
    apiKey: "test",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: "summary-model",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => client.stop());
  await client.ready();
  const occurredAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const makeObservation = (id: string): ScreenObservation => ({
    schemaVersion: 1,
    id,
    occurredAt,
    capturedAt: occurredAt,
    trigger: { type: "focusedWindowChanged" },
    window: { processIdentifier: 42, applicationName: "Safari" },
    screenshot: { status: "complete", durationMilliseconds: 1 },
    accessibility: { status: "complete", durationMilliseconds: 1 },
    visibleText: id,
    diagnostics: {
      triggerToCaptureMilliseconds: 1,
      screenshotDurationMilliseconds: 1,
      accessibilityDurationMilliseconds: 1,
    },
  });
  await client.recordObservation(makeObservation("before-model"));
  const tick = client.tick();
  await Promise.race([
    modelStarted,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("background model request did not start")),
      2_000,
    )),
  ]);

  await Promise.race([
    client.recordObservation(makeObservation("during-model")),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("Observation intake waited for the model request")),
      1_000,
    )),
  ]);
  await client.stop();
  await tick.catch(() => {});

  const database = openMemoryDatabase(memoryRoot);
  t.after(() => database.close());
  assert.equal(database.connection.prepare(`
    SELECT count(*) AS count FROM source_items
    WHERE id IN ('observation:before-model', 'observation:during-model')
  `).get()?.count, 2);
});

test("rejects new requests after the Memory Worker exits unexpectedly", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-thread-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const client = new MemoryWorkerClient({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory: join(dataRoot, "sessions"),
    apiKey: "test",
    baseURL: "http://127.0.0.1:1/v1",
    model: "summary-model",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => client.stop());
  await client.ready();
  await (client as unknown as {
    worker: { terminate(): Promise<number> };
  }).worker.terminate();

  await assert.rejects(Promise.race([
    client.tick(),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("request remained pending after Worker exit")),
      200,
    )),
  ]), /Memory worker exited/);
});

test("rejects an unknown Memory Worker message type", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-thread-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const client = new MemoryWorkerClient({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory: join(dataRoot, "sessions"),
    apiKey: "test",
    baseURL: "http://127.0.0.1:1/v1",
    model: "summary-model",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => client.stop());
  await client.ready();
  const worker = (client as unknown as {
    worker: {
      postMessage(message: unknown): void;
      once(event: "message", listener: (message: unknown) => void): void;
    };
  }).worker;
  const response = new Promise<Record<string, unknown>>((resolve) => {
    worker.once("message", (message) => resolve(message as Record<string, unknown>));
  });

  worker.postMessage({ type: "unknown", requestId: "invalid-request" });

  assert.deepEqual(await response, {
    type: "error",
    requestId: "invalid-request",
    message: "Unknown Memory Worker message type unknown",
  });
});

test("reports a failed internal startup tick", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "openscreen-memory-thread-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionsDirectory = join(dataRoot, "sessions");
  const session = await createSession(sessionsDirectory);
  await appendSessionEvents(sessionsDirectory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Trigger startup token counting",
        startedAt: "2026-08-04T09:00:00.000Z",
      },
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Trigger startup token counting",
        assistant: "Done",
        status: "completed",
        startedAt: "2026-08-04T09:00:00.000Z",
        finishedAt: "2026-08-04T09:01:00.000Z",
      },
    },
  ]);
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "token counter unavailable" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let report!: () => void;
  const reported = new Promise<void>((resolve) => {
    report = resolve;
  });
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (String(chunk).includes("OpenScreen memory worker failed:")) report();
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = originalWrite;
  });
  const client = new MemoryWorkerClient({
    memoryRoot: join(dataRoot, "memory"),
    sessionsDirectory,
    apiKey: "test",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: "summary-model",
    contextWindowTokens: 10_000,
    memory: testMemoryConfig(),
  });
  t.after(() => client.stop());
  await client.ready();

  await Promise.race([
    reported,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("internal startup failure was not reported")),
      1_000,
    )),
  ]);
});
