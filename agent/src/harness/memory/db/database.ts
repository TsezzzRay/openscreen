import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MEMORY_RETRIEVAL_SCHEMA,
  MEMORY_SCHEMA,
  MEMORY_SCHEMA_VERSION,
} from "./schema.js";

const DATABASE_FILENAME = "memory.sqlite3";
const BUSY_TIMEOUT_MILLISECONDS = 5_000;

export type DatabaseRow = Record<string, unknown>;

export function integer(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function changed(result: { changes: number | bigint }) {
  return Number(result.changes) === 1;
}

export function changeCount(result: { changes: number | bigint }) {
  return Number(result.changes);
}

export function memoryDatabasePath(root: string) {
  return join(root, DATABASE_FILENAME);
}

export class MemoryDatabase {
  constructor(readonly connection: DatabaseSync) {}

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result && typeof result === "object" && "then" in result) {
        throw new Error("Memory transactions must be synchronous");
      }
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.connection.close();
  }
}

function initializeSchema(connection: DatabaseSync) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    BEGIN IMMEDIATE;
  `);
  try {
    const current = connection.prepare(
      "SELECT max(version) AS version FROM schema_migrations",
    ).get()?.version;
    if (current === null || current === undefined) {
      connection.exec(MEMORY_SCHEMA);
      connection.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(MEMORY_SCHEMA_VERSION, Date.now());
    } else if (current === 4) {
      connection.exec(MEMORY_RETRIEVAL_SCHEMA);
      connection.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(MEMORY_SCHEMA_VERSION, Date.now());
    } else if (current !== MEMORY_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported memory database schema version ${String(current)}`,
      );
    }
    if (connection.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Memory database schema violated foreign keys");
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function openMemoryDatabase(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = memoryDatabasePath(root);
  const connection = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    chmodSync(path, 0o600);
    connection.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS};
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
    `);
    initializeSchema(connection);
    return new MemoryDatabase(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
