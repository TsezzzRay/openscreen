import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  memoryDatabasePath,
  openMemoryDatabase,
} from "../../src/harness/memory/db/database.js";
import { MEMORY_SCHEMA_V4 } from "../../src/harness/memory/db/schema.js";

test("opens a private WAL database with the complete memory schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.equal(
    database.connection.prepare("PRAGMA journal_mode").get()?.journal_mode,
    "wal",
  );
  assert.equal(
    database.connection.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
    1,
  );
  assert.equal(
    database.connection.prepare("PRAGMA busy_timeout").get()?.timeout,
    5_000,
  );
  assert.equal((await stat(memoryDatabasePath(root))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.deepEqual(
    (database.connection.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number }>).map(({ version }) => version),
    [5],
  );

  const tables = (database.connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, [
    "chronicle_activities",
    "chronicle_activity_sources",
    "chronicle_sources",
    "chronicle_summaries",
    "chronicle_summary_sources",
    "chronicle_window_sources",
    "chronicle_windows",
    "consolidation_inputs",
    "consolidation_jobs",
    "consolidation_publications",
    "consolidation_source_baseline",
    "memory_evidence",
    "memory_jobs",
    "model_attempts",
    "retrieval_documents",
    "retrieval_documents_fts",
    "retrieval_documents_fts_config",
    "retrieval_documents_fts_data",
    "retrieval_documents_fts_docsize",
    "retrieval_documents_fts_idx",
    "retrieval_index_state",
    "retrieval_long_term_memories",
    "schema_migrations",
    "turn_memory_batch_sources",
    "turn_memory_batches",
    "turn_memory_extraction_sources",
    "turn_memory_extractions",
    "turn_memory_session_scans",
    "turn_memory_sources",
  ]);
  const sourceColumns = (database.connection.prepare(
    "PRAGMA table_info(chronicle_sources)",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(sourceColumns.includes("payload_json"), false);
  assert.equal(sourceColumns.includes("projected_input_tokens"), false);
  const attemptColumns = (database.connection.prepare(
    "PRAGMA table_info(model_attempts)",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(attemptColumns.includes("stage"), false);
  assert.equal(attemptColumns.includes("operation"), true);
  assert.equal(attemptColumns.includes("request_characters"), true);
  assert.equal(attemptColumns.includes("output_characters"), true);
  assert.equal(attemptColumns.includes("response_status"), true);
  assert.equal(attemptColumns.includes("incomplete_reason"), true);
  assert.equal(attemptColumns.includes("error_code"), true);
  assert.equal(attemptColumns.includes("error_path"), true);
  assert.throws(() => database.connection.prepare(`
    INSERT INTO memory_jobs (
      job_key, kind, source_id, source_generation,
      status, eligible_at, retry_remaining
    ) VALUES (
      'unused-status', 'chronicle_summarization', 'window:unused', 1,
      'succeeded_no_output', 1, 3
    )
  `).run(), /check constraint/i);
});

test("rolls back an immediate memory transaction after an exception", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.throws(() => database.transaction(() => {
    database.connection.prepare(`
      INSERT INTO chronicle_sources (
        id, source_key, occurred_at, captured_at, projection_json, ingested_at
      ) VALUES (?, ?, ?, ?, '{}', ?)
    `).run("source-1", "observation:1", 1, 1, 1);
    throw new Error("stop");
  }), /stop/);

  assert.equal(
    database.connection.prepare("SELECT count(*) AS count FROM chronicle_sources").get()?.count,
    0,
  );
});

test("rejects asynchronous work inside a synchronous SQLite transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.throws(() => database.transaction(async () => "later"),
    /transactions must be synchronous/);
  assert.doesNotThrow(() => database.transaction(() => "now"));
});

test("migrates schema v4 and backfills existing screen context into FTS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(memoryDatabasePath(root));
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    ${MEMORY_SCHEMA_V4}
    INSERT INTO schema_migrations (version, applied_at) VALUES (4, 1);
    INSERT INTO chronicle_sources (
      id, source_key, occurred_at, captured_at, projection_json, ingested_at
    ) VALUES (
      'legacy-observation', 'legacy-observation', 1, 2,
      '{"application":{"name":"Safari"},"visibleText":"Legacy retrieval context"}',
      3
    );
  `);
  legacy.close();

  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.deepEqual(
    (database.connection.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number }>).map(({ version }) => version),
    [4, 5],
  );
  assert.deepEqual((database.connection.prepare(`
    SELECT d.document_id
    FROM retrieval_documents_fts
    JOIN retrieval_documents d ON d.id = retrieval_documents_fts.rowid
    WHERE retrieval_documents_fts MATCH '"legacy"'
  `).all() as Array<{ document_id: string }>).map(({ document_id }) => document_id), [
    "legacy-observation",
  ]);
});

test("rejects an existing database from an unreleased schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(memoryDatabasePath(root));
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations (version, applied_at) VALUES (3, 1);
  `);
  legacy.close();

  assert.throws(
    () => openMemoryDatabase(root),
    /unsupported.*schema version 3/i,
  );
});

test("rejects a database created by a newer unsupported schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  database.connection.prepare(`
    INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)
  `).run(Date.now());
  database.close();

  assert.throws(() => openMemoryDatabase(root), /unsupported.*schema version 99/i);
});
