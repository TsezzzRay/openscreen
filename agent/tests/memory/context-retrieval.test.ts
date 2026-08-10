import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openMemoryDatabase } from "../../src/harness/memory/db/database.js";
import {
  ContextRetrieval,
  type ContextDocumentKind,
} from "../../src/harness/memory/read/search.js";

const SCREEN_AT = Date.parse("2026-08-08T10:00:00.000Z");
const ACTIVITY_AT = Date.parse("2026-08-08T10:05:00.000Z");
const TURN_AT = Date.parse("2026-08-08T11:00:00.000Z");

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openscreen-retrieval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  const projection = {
    type: "screen_observation",
    sourceId: "observation:telemetry",
    occurredAt: new Date(SCREEN_AT).toISOString(),
    capturedAt: new Date(SCREEN_AT + 100).toISOString(),
    application: {
      name: "Safari",
      bundleIdentifier: "com.apple.Safari",
    },
    windowTitle: "Telemetry dashboard",
    url: "https://example.com/telemetry/reconnect",
    focusedElement: {
      role: "AXTextField",
      value: "ERR_SOCKET_CLOSED",
      description: "Reconnect error filter",
    },
    visibleText:
      "Investigating websocket reconnect failures in the telemetry dashboard.",
  };
  database.connection.prepare(`
    INSERT INTO chronicle_sources (
      id, source_key, occurred_at, captured_at, projection_json, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projection.sourceId,
    projection.sourceId,
    SCREEN_AT,
    SCREEN_AT + 100,
    JSON.stringify(projection),
    SCREEN_AT + 200,
  );
  database.connection.prepare(`
    INSERT INTO chronicle_windows (
      id, start_at, end_at, eligible_at, source_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(
    "chronicle-window:telemetry",
    SCREEN_AT,
    SCREEN_AT + 10 * 60_000,
    SCREEN_AT + 11 * 60_000,
    SCREEN_AT,
    SCREEN_AT,
  );
  database.connection.prepare(`
    INSERT INTO chronicle_window_sources (window_id, source_id, ordinal)
    VALUES (?, ?, 0)
  `).run("chronicle-window:telemetry", projection.sourceId);
  database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining, finished_at
    ) VALUES (?, 'chronicle_summarization', ?, 1, 'succeeded', ?, 3, ?)
  `).run(
    "chronicle:telemetry",
    "chronicle-window:telemetry",
    SCREEN_AT + 11 * 60_000,
    ACTIVITY_AT,
  );
  database.connection.prepare(`
    INSERT INTO chronicle_summaries (
      job_key, source_generation, source_updated_at, source_summary, generated_at
    ) VALUES (?, 1, 1, ?, ?)
  `).run(
    "chronicle:telemetry",
    "The user reviewed telemetry retry behavior and websocket reconnect logs.",
    ACTIVITY_AT,
  );
  database.connection.prepare(`
    INSERT INTO chronicle_summary_sources (job_key, source_id) VALUES (?, ?)
  `).run("chronicle:telemetry", projection.sourceId);
  database.connection.prepare(`
    INSERT INTO chronicle_activities (
      id, job_key, occurred_at, summary, application, window_title, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "chronicle:telemetry:activity:1",
    "chronicle:telemetry",
    ACTIVITY_AT,
    "Reviewed the telemetry retry policy in Safari.",
    "Safari",
    "Telemetry dashboard",
    ACTIVITY_AT + 100,
  );
  database.connection.prepare(`
    INSERT INTO chronicle_activity_sources (activity_id, source_id) VALUES (?, ?)
  `).run("chronicle:telemetry:activity:1", projection.sourceId);

  database.connection.prepare(`
    INSERT INTO turn_memory_sources (
      id, source_key, session_id, turn_id, occurred_at, projection_json, ingested_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?)
  `).run(
    "turn-source:retrieval",
    "turn-source:retrieval",
    "session:retrieval",
    "turn:retrieval",
    TURN_AT,
    TURN_AT,
  );
  database.connection.prepare(`
    INSERT INTO turn_memory_batches (
      id, session_id, first_pending_at, last_terminal_at, eligible_at,
      status, close_reason, projected_input_tokens, max_input_tokens,
      source_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'sealed', 'idle', 100, 1000, 1, ?, ?)
  `).run(
    "turn-memory-batch:retrieval",
    "session:retrieval",
    TURN_AT,
    TURN_AT + 60_000,
    TURN_AT + 60_000,
    TURN_AT,
    TURN_AT,
  );
  database.connection.prepare(`
    INSERT INTO turn_memory_batch_sources (batch_id, source_id, ordinal)
    VALUES (?, ?, 0)
  `).run("turn-memory-batch:retrieval", "turn-source:retrieval");
  database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation, status,
      eligible_at, retry_remaining, finished_at
    ) VALUES (?, 'turn_memory_extraction', ?, 1, 'succeeded', ?, 3, ?)
  `).run(
    "turn-memory:retrieval",
    "turn-memory-batch:retrieval",
    TURN_AT + 60_000,
    TURN_AT + 120_000,
  );
  database.connection.prepare(`
    INSERT INTO turn_memory_extractions (
      job_key, source_generation, source_updated_at, raw_memory,
      turn_summary, turn_slug, generated_at
    ) VALUES (?, 1, 2, ?, ?, ?, ?)
  `).run(
    "turn-memory:retrieval",
    "Store retrieval indexes in SQLite FTS5.",
    "The user decided to persist context retrieval indexes locally.",
    "local-context-retrieval",
    TURN_AT + 120_000,
  );
  database.connection.prepare(`
    INSERT INTO turn_memory_extraction_sources (job_key, source_id) VALUES (?, ?)
  `).run("turn-memory:retrieval", "turn-source:retrieval");
  database.connection.prepare(`
    INSERT INTO memory_evidence (memory_key, memory_source_id, source_id)
    VALUES (?, ?, ?)
  `).run(
    "context-retrieval-storage",
    "turn-memory:retrieval",
    "turn-source:retrieval",
  );

  await writeFile(join(root, "MEMORY.md"), `# OpenScreen Memory

## Context retrieval storage

- key: context-retrieval-storage
- scope: project:openscreen
- evidence: turn-memory:retrieval

The project uses SQLite FTS5 for local English context retrieval.
`);

  return { root, database, retrieval: new ContextRetrieval(root, database) };
}

test("searches raw screen observations with safe English FTS queries and filters", async (t) => {
  const { retrieval } = await fixture(t);

  const result = await retrieval.search({
    query: "ERR_SOCKET_CLOSED() websocket",
    kinds: ["screen_observation"],
    application: "saf",
    since: SCREEN_AT,
    until: SCREEN_AT,
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.kind, "screen_observation");
  assert.equal(item.id, "observation:telemetry");
  assert.equal(item.occurredAt, new Date(SCREEN_AT).toISOString());
  assert.equal(item.generatedAt, new Date(SCREEN_AT + 100).toISOString());
  assert.equal(item.application, "Safari");
  assert.equal(item.windowTitle, "Telemetry dashboard");
  assert.equal(
    item.content,
    "Investigating websocket reconnect failures in the telemetry dashboard.",
  );
  assert.equal(item.detail, "ERR_SOCKET_CLOSED\nReconnect error filter");
  assert.equal(item.url, "https://example.com/telemetry/reconnect");
  assert.deepEqual(item.sourceIds, ["observation:telemetry"]);
  assert.match(item.excerpt, /\[ERR\]_\[SOCKET\]_\[CLOSED\]|websocket/i);

  assert.deepEqual((await retrieval.search({
    query: "websocket absent",
    kinds: ["screen_observation"],
  })).items, []);
});

test("searches generated activities and both summary producers independently", async (t) => {
  const { database, retrieval } = await fixture(t);

  const activities = await retrieval.search({
    query: "retry policy",
    kinds: ["chronicle_activity"],
  });
  assert.equal(activities.items[0]?.id, "chronicle:telemetry:activity:1");
  assert.deepEqual(activities.items[0]?.sourceIds, ["observation:telemetry"]);

  const summaries = await retrieval.search({
    query: "retrieval indexes",
    kinds: ["chronicle_summary", "turn_summary"],
  });
  assert.deepEqual(
    summaries.items.map(({ kind }) => kind),
    ["turn_summary"],
  );
  assert.equal(summaries.items[0]?.title, "local-context-retrieval");
  assert.equal(summaries.items[0]?.detail, "Store retrieval indexes in SQLite FTS5.");
  assert.deepEqual(summaries.items[0]?.sourceIds, ["turn-source:retrieval"]);

  database.connection.prepare(`
    UPDATE chronicle_activities SET summary = ? WHERE id = ?
  `).run(
    "Reviewed a deterministic context ranking policy.",
    "chronicle:telemetry:activity:1",
  );
  assert.deepEqual((await retrieval.search({
    query: "retry policy",
    kinds: ["chronicle_activity"],
  })).items, []);
  assert.equal((await retrieval.search({
    query: "deterministic ranking",
    kinds: ["chronicle_activity"],
  })).items[0]?.id, "chronicle:telemetry:activity:1");
});

test("indexes the current long-term memory artifact and hydrates its evidence", async (t) => {
  const { root, retrieval } = await fixture(t);

  const first = await retrieval.search({
    query: "English context retrieval",
    kinds: ["long_term_memory"],
  });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.id, "context-retrieval-storage");
  assert.deepEqual(first.items[0]?.scope, {
    type: "project",
    key: "openscreen",
  });
  assert.deepEqual(first.items[0]?.memorySourceIds, ["turn-memory:retrieval"]);
  assert.deepEqual(first.items[0]?.sourceIds, ["turn-source:retrieval"]);

  await writeFile(join(root, "MEMORY.md"), `# OpenScreen Memory

## Updated retrieval storage

- key: context-retrieval-storage
- scope: project:openscreen
- evidence: turn-memory:retrieval

The project now uses a durable lexical context index.
`);

  assert.deepEqual((await retrieval.search({
    query: "SQLite FTS5",
    kinds: ["long_term_memory"],
  })).items, []);
  assert.equal((await retrieval.search({
    query: "durable lexical",
    kinds: ["long_term_memory"],
  })).items[0]?.title, "Updated retrieval storage");
});

test("keeps raw and summary retrieval independent from an invalid memory artifact", async (t) => {
  const { root, retrieval } = await fixture(t);
  await writeFile(join(root, "MEMORY.md"), "invalid memory artifact\n");

  assert.equal((await retrieval.search({
    query: "websocket reconnect",
    kinds: ["screen_observation"],
  })).items[0]?.id, "observation:telemetry");
  assert.equal((await retrieval.recent({
    kinds: ["chronicle_summary"],
  })).items[0]?.id, "chronicle:telemetry");
  await assert.rejects(retrieval.search({
    query: "context retrieval",
    kinds: ["long_term_memory"],
  }), /invalid.*memory artifact/i);
});

test("treats the empty-memory marker as content when it appears inside a memory", async (t) => {
  const { root, retrieval } = await fixture(t);
  await writeFile(join(root, "MEMORY.md"), `# OpenScreen Memory

## Memory format documentation

- key: memory-format-documentation
- scope: topic:memory-format
- evidence: turn-memory:retrieval

The literal phrase _No durable memories._ documents the empty format.
`);

  assert.equal((await retrieval.search({
    query: "literal empty format",
    kinds: ["long_term_memory"],
  })).items[0]?.id, "memory-format-documentation");
});

test("returns recent context in deterministic time order without a search query", async (t) => {
  const { retrieval } = await fixture(t);
  const kinds: ContextDocumentKind[] = [
    "screen_observation",
    "chronicle_activity",
    "chronicle_summary",
    "turn_summary",
  ];

  const result = await retrieval.recent({ kinds, limit: 3 });

  assert.deepEqual(
    result.items.map(({ kind, id }) => [kind, id]),
    [
      ["turn_summary", "turn-memory:retrieval"],
      ["chronicle_activity", "chronicle:telemetry:activity:1"],
      ["chronicle_summary", "chronicle:telemetry"],
    ],
  );
});

test("validates bounded retrieval arguments", async (t) => {
  const { retrieval } = await fixture(t);

  await assert.rejects(
    retrieval.search({ query: "---", limit: 10 }),
    /searchable terms/i,
  );
  await assert.rejects(
    retrieval.search({ query: "context", limit: 0 }),
    /limit/i,
  );
  await assert.rejects(
    retrieval.recent({ since: TURN_AT, until: SCREEN_AT }),
    /time range/i,
  );
});
