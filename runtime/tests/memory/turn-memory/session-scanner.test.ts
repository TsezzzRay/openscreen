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

import { openMemoryCursors } from "../../../src/memory/cursors.js";
import { scanTurnMemorySession } from "../../../src/memory/turn-memory/session-scanner.js";
import type { TurnMemorySource } from "../../../src/memory/turn-memory/types.js";

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
  const cursors = openMemoryCursors(root);
  t.after(() => cursors.close());
  const processed: TurnMemorySource[] = [];
  const onTerminalSource = async (source: TurnMemorySource) => {
    processed.push(source);
  };

  const firstUser = message("user-1", null, "user", "First");
  const firstAnswer = message("answer-1", "user-1", "assistant", "Done", "stop");
  const pendingUser = message("user-2", "answer-1", "user", "Pending");

  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    cursors,
    onTerminalSource,
    scannedAt: 1,
  }), { status: "scanned", processed: 1, cursorRewound: false });
  assert.equal(processed.length, 1);
  assert.equal(cursors.loadTurnScanCursor("session-1")?.lastTerminalEntryId, "answer-1");

  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    cursors,
    onTerminalSource,
    scannedAt: 2,
  }), { status: "unchanged" });
  assert.equal(processed.length, 1);

  const secondAnswer = message("answer-2", "user-2", "assistant", "Second done", "stop");
  assert.deepEqual(await scanTurnMemorySession({
    session: session([firstUser, firstAnswer, pendingUser, secondAnswer]),
    fileVersion: "v2",
    gitBranch: "feature/memory",
    cursors,
    onTerminalSource,
    scannedAt: 3,
  }), { status: "scanned", processed: 1, cursorRewound: false });
  assert.equal(processed.length, 2);
  assert.equal(cursors.loadTurnScanCursor("session-1")?.lastTerminalEntryId, "answer-2");
});

test("records a scan failure without a terminal entry when projection itself fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-session-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cursors = openMemoryCursors(root);
  t.after(() => cursors.close());
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
    cursors,
    onTerminalSource: async () => {
      throw new Error("should not be called");
    },
    scannedAt: 1,
  }), { status: "failed", error: "invalid session entry" });
  assert.equal(cursors.shouldScanSession("session-1", "broken-v1"), false);
});

test("leaves the cursor untouched when the write callback fails, so the next tick retries the whole batch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-session-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cursors = openMemoryCursors(root);
  t.after(() => cursors.close());
  const firstUser = message("user-1", null, "user", "First");
  const firstAnswer = message("answer-1", "user-1", "assistant", "Done", "stop");

  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient Mastra write failure");
  };

  const first = await scanTurnMemorySession({
    session: session([firstUser, firstAnswer]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    cursors,
    onTerminalSource: flaky,
    scannedAt: 1,
  });
  assert.equal(first.status, "failed");
  assert.equal(cursors.loadTurnScanCursor("session-1"), undefined);

  const second = await scanTurnMemorySession({
    session: session([firstUser, firstAnswer]),
    fileVersion: "v1",
    gitBranch: "feature/memory",
    cursors,
    onTerminalSource: flaky,
    scannedAt: 2,
  });
  assert.deepEqual(second, { status: "scanned", processed: 1, cursorRewound: false });
  assert.equal(attempts, 2);
  assert.equal(cursors.loadTurnScanCursor("session-1")?.lastTerminalEntryId, "answer-1");
});
