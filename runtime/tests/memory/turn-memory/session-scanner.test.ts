import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  JsonlSessionMetadata,
  Session,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import { openMemoryDatabase } from "../../../src/memory/database.js";
import { TurnMemoryRepository } from "../../../src/memory/turn-memory/repository.js";
import {
  scanTurnMemorySession,
} from "../../../src/memory/turn-memory/session-scanner.js";

const policy = {
  maxInputTokens: 8_000,
  maxOutputTokens: 2_000,
  idleMilliseconds: 30 * 60_000,
  hardCapMilliseconds: 2 * 60 * 60_000,
  worker: {
    leaseMilliseconds: 60_000,
    retryDelayMilliseconds: 1_000,
    maxAttempts: 3,
  },
};

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  stopReason?: "stop" | "error",
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-15T10:00:${id.endsWith("2") ? "02" : "01"}.000Z`,
    message: role === "user"
      ? { role, content: text }
      : {
          role,
          content: [{ type: "text", text }],
          stopReason,
        },
  } as unknown as SessionTreeEntry;
}

function session(branch: SessionTreeEntry[]): Session<JsonlSessionMetadata> {
  return {
    getMetadata: async () => ({
      id: "session-1",
      createdAt: "2026-08-15T10:00:00.000Z",
      cwd: "/workspace/project",
      path: "/sessions/session-1.jsonl",
    }),
    getBranch: async () => branch,
  } as unknown as Session<JsonlSessionMetadata>;
}

test("does not advance past an unfinished Turn and resumes after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-session-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, policy);
  const firstUser = message("user-1", null, "user", "First");
  const firstAnswer = message("answer-1", "user-1", "assistant", "Done", "stop");
  const pendingUser = message("user-2", "answer-1", "user", "Pending");

  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    repository,
    scannedAt: 1,
  }), { status: "scanned", ingested: 1, updated: 0, deactivated: 0 });
  assert.equal(
    repository.loadScanCursor("session-1")?.lastTerminalEntryId,
    "answer-1",
  );

  const reopened = new TurnMemoryRepository(database, policy);
  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    repository: reopened,
    scannedAt: 2,
  }), { status: "unchanged" });

  const secondAnswer = message("answer-2", "user-2", "assistant", "Second done", "stop");
  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser, secondAnswer]),
    fileVersion: "v2",
    gitBranch: "feature/memory",
    repository: reopened,
    scannedAt: 3,
  }), { status: "scanned", ingested: 1, updated: 0, deactivated: 0 });
  assert.equal(
    reopened.loadScanCursor("session-1")?.lastTerminalEntryId,
    "answer-2",
  );
});

test("persists projection failures without throwing into the caller", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-session-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = openMemoryDatabase(root);
  t.after(() => database.close());
  const repository = new TurnMemoryRepository(database, policy);
  const invalid = {
    getMetadata: async () => ({
      id: "session-1",
      createdAt: "2026-08-15T10:00:00.000Z",
      cwd: "/workspace/project",
      path: "/sessions/session-1.jsonl",
    }),
    getBranch: async () => {
      throw new Error("invalid session entry");
    },
  } as unknown as Session<JsonlSessionMetadata>;

  assert.deepEqual(await scanTurnMemorySession({
    session: invalid,
    fileVersion: "broken-v1",
    gitBranch: "feature/memory",
    repository,
    scannedAt: 1,
  }), { status: "failed", error: "invalid session entry" });
  assert.equal(repository.shouldScan("session-1", "broken-v1"), false);
});
