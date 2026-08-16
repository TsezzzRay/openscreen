import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  memoryDatabasePath,
  openMemoryDatabase,
} from "../../src/memory/database.js";
import {
  MEMORY_SCHEMA_V1,
  MEMORY_SCHEMA_V2,
  MEMORY_SCHEMA_V3,
} from "../../src/memory/schema.js";

test("opens a private WAL Memory database with the current schema", async (t) => {
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
    database.connection.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
  ).get()?.version,
    4,
  );
  const names = new Set(
    database.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => String(row.name)),
  );
  for (const name of [
    "turn_memory_sources",
    "turn_memory_session_scans",
    "turn_memory_batches",
    "turn_memory_batch_sources",
    "memory_jobs",
    "turn_memory_extractions",
    "memory_artifacts",
    "chronicle_sources",
    "chronicle_windows",
    "chronicle_window_sources",
    "chronicle_summaries",
    "chronicle_summary_sources",
    "chronicle_activities",
    "chronicle_activity_sources",
    "chronicle_ingest_cursors",
    "memory_source_clock",
    "memory_sources",
    "consolidation_jobs",
    "consolidation_source_baseline",
    "consolidation_inputs",
    "memory_evidence",
    "consolidation_publications",
  ]) {
    assert.equal(names.has(name), true, `missing ${name}`);
  }
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(memoryDatabasePath(root))).mode & 0o777, 0o600);
});

test("migrates an existing Turn Memory v1 database without losing data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = memoryDatabasePath(root);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    ${MEMORY_SCHEMA_V1}
    INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1);
    INSERT INTO turn_memory_session_scans (
      session_id, file_version, status, scanned_at
    ) VALUES ('session-1', 'v1', 'valid', 1);
  `);
  legacy.close();

  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.equal(database.connection.prepare(
    "SELECT max(version) AS version FROM schema_migrations",
  ).get()?.version, 4);
  assert.equal(database.connection.prepare(
    "SELECT status FROM turn_memory_session_scans WHERE session_id = 'session-1'",
  ).get()?.status, "valid");
  assert.equal(database.connection.prepare(
    "SELECT count(*) AS count FROM consolidation_jobs",
  ).get()?.count, 1);
});

test("migrates a v2 Memory database to Chronicle without losing artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = memoryDatabasePath(root);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    ${MEMORY_SCHEMA_V1}
    ${MEMORY_SCHEMA_V2}
    INSERT INTO schema_migrations (version, applied_at) VALUES (2, 1);
    INSERT INTO memory_artifacts (
      artifact_key, kind, relative_path, content, content_hash,
      source_updated_at, generated_at
    ) VALUES (
      'turn-rollout:test', 'turn_rollout', 'rollout_summaries/turn-test.md',
      'turn', '${"a".repeat(64)}', 1, 1
    );
  `);
  legacy.close();

  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  assert.equal(database.connection.prepare(
    "SELECT max(version) AS version FROM schema_migrations",
  ).get()?.version, 4);
  assert.equal(database.connection.prepare(`
    SELECT content FROM memory_artifacts WHERE artifact_key = 'turn-rollout:test'
  `).get()?.content, "turn");
  assert.equal(database.connection.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'chronicle_sources'
  `).get()?.present, 1);
});

test("migrates a v3 Chronicle cursor to generation completion tracking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = memoryDatabasePath(root);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    ${MEMORY_SCHEMA_V1}
    ${MEMORY_SCHEMA_V2}
    ${MEMORY_SCHEMA_V3}
    INSERT INTO schema_migrations (version, applied_at) VALUES (3, 1);
    INSERT INTO chronicle_ingest_cursors (
      generation_id, last_frame_id, updated_at
    ) VALUES ('generation-1', 12, 1);
  `);
  legacy.close();

  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  assert.deepEqual({ ...database.connection.prepare(`
    SELECT last_frame_id, completed_at FROM chronicle_ingest_cursors
    WHERE generation_id = 'generation-1'
  `).get() }, { last_frame_id: 12, completed_at: null });
  assert.equal(database.connection.prepare(
    "SELECT max(version) AS version FROM schema_migrations",
  ).get()?.version, 4);
});

test("rolls back failed synchronous Memory transactions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());

  assert.throws(() => database.transaction(() => {
    database.connection.prepare(`
      INSERT INTO turn_memory_session_scans (
        session_id, file_version, status, scanned_at
      ) VALUES ('session-1', 'v1', 'valid', 1)
    `).run();
    throw new Error("stop");
  }), /stop/);
  assert.equal(
    database.connection.prepare(
      "SELECT count(*) AS count FROM turn_memory_session_scans",
    ).get()?.count,
    0,
  );
});
