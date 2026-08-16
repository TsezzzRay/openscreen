import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import {
  TurnMemoryScanCursorRepository,
} from "../../../src/memory/turn-memory/scan-cursor.js";

test("persists a durable terminal-entry cursor and skips unchanged files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const cursors = new TurnMemoryScanCursorRepository(database);

  assert.equal(cursors.shouldScan("session-1", "v1"), true);
  assert.deepEqual(cursors.load("session-1"), undefined);
  cursors.recordSuccess({
    sessionId: "session-1",
    fileVersion: "v1",
    lastTerminalEntryId: "answer-1",
    scannedAt: 10,
  });
  assert.equal(cursors.shouldScan("session-1", "v1"), false);
  assert.equal(cursors.shouldScan("session-1", "v2"), true);
  assert.deepEqual(cursors.load("session-1"), {
    fileVersion: "v1",
    lastTerminalEntryId: "answer-1",
    status: "valid",
  });

  const reopened = new TurnMemoryScanCursorRepository(database);
  assert.deepEqual(reopened.load("session-1"), cursors.load("session-1"));
});

test("records an invalid file without discarding the last terminal cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const cursors = new TurnMemoryScanCursorRepository(database);
  cursors.recordSuccess({
    sessionId: "session-1",
    fileVersion: "v1",
    lastTerminalEntryId: "answer-1",
    scannedAt: 10,
  });
  cursors.recordFailure({
    sessionId: "session-1",
    fileVersion: "broken-v2",
    error: "invalid entry",
    scannedAt: 20,
  });

  assert.equal(cursors.shouldScan("session-1", "broken-v2"), false);
  assert.equal(cursors.shouldScan("session-1", "fixed-v3"), true);
  assert.deepEqual(cursors.load("session-1"), {
    fileVersion: "broken-v2",
    lastTerminalEntryId: "answer-1",
    status: "invalid",
    lastError: "invalid entry",
  });
});
