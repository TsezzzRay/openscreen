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
    [1],
  );

  const tables = (database.connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, [
    "activity_jobs",
    "activity_record_sources",
    "activity_records",
    "activity_summaries",
    "activity_summary_sources",
    "consolidation_inputs",
    "consolidation_jobs",
    "consolidation_publications",
    "memory_evidence",
    "model_attempts",
    "observation_window_sources",
    "observation_windows",
    "schema_migrations",
    "source_items",
    "turn_batch_sources",
    "turn_batches",
  ]);
  const sourceColumns = (database.connection.prepare(
    "PRAGMA table_info(source_items)",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(sourceColumns.includes("payload_json"), false);
  assert.equal(sourceColumns.includes("projected_input_tokens"), false);
  assert.throws(() => database.connection.prepare(`
    INSERT INTO activity_jobs (
      job_key, source_kind, source_id, source_generation,
      status, eligible_at, retry_remaining
    ) VALUES (
      'unused-status', 'observation_window', 'window:unused', 1,
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
      INSERT INTO source_items (
        id, source_type, source_key, occurred_at, projection_json, ingested_at
      ) VALUES (?, 'observation', ?, ?, '{}', ?)
    `).run("source-1", "observation:1", 1, 1);
    throw new Error("stop");
  }), /stop/);

  assert.equal(
    database.connection.prepare("SELECT count(*) AS count FROM source_items").get()?.count,
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

test("rejects an existing database from an unreleased schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(memoryDatabasePath(root));
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations (version, applied_at) VALUES (4, 1);
  `);
  legacy.close();

  assert.throws(
    () => openMemoryDatabase(root),
    /unsupported.*schema version 4/i,
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
