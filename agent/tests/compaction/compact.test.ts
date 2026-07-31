import assert from "node:assert/strict";
import test from "node:test";

import type { SessionState, Turn } from "../../src/harness/session/types.js";
import {
  compactIfNeeded,
  compactSession,
} from "../../src/harness/compaction/compact.js";

function completedTurn(id: number, user: string, assistant: string): Turn {
  return {
    id: `turn-${id}`,
    user,
    assistant,
    status: "completed",
    startedAt: `2026-07-31T00:00:${String(id).padStart(2, "0")}.000Z`,
    finishedAt: `2026-07-31T00:00:${String(id).padStart(2, "0")}.500Z`,
  };
}

test("compacts older turns while retaining 20K recent tokens", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 5 }, (_, index) => completedTurn(
      index + 1,
      `Question ${index + 1}`,
      `Answer ${index + 1}`,
    )),
  };
  let summarizedTurns = 0;

  await compactSession(
    session,
    20_000,
    2,
    async (turns) => turns.length * 10_000,
    async (_previousSummary, turns) => {
      summarizedTurns = turns.length;
      return "Compact summary";
    },
  );

  assert.equal(summarizedTurns, 3);
  assert.equal(session.conversationSummary?.content, "Compact summary");
  assert.equal(session.conversationSummary?.firstKeptTurnIndex, 3);
  assert.equal(session.turns.length, 5);
});

test("finds the 20K recent-turn boundary without scanning every turn", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 100 }, (_, index) => completedTurn(
      index + 1,
      `Question ${index + 1}`,
      `Answer ${index + 1}`,
    )),
  };
  let countCalls = 0;

  await compactSession(
    session,
    20_000,
    2,
    async (turns) => {
      countCalls += 1;
      return turns.length * 1_000;
    },
    async () => "Compact summary",
  );

  assert.equal(session.conversationSummary?.firstKeptTurnIndex, 80);
  assert.ok(countCalls <= 8);
});

test("rolls the previous summary forward without re-summarizing raw history", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 8 }, (_, index) => completedTurn(
      index + 1,
      `Question ${index + 1}`,
      `Answer ${index + 1}`,
    )),
    conversationSummary: {
      content: "Previous summary",
      createdAt: "2026-07-30T00:00:00.000Z",
      firstKeptTurnIndex: 3,
    },
  };
  let summarizedQuestions: string[] = [];

  await compactSession(
    session,
    20_000,
    2,
    async (turns) => turns.length * 10_000,
    async (previousSummary, turns) => {
      assert.equal(previousSummary, "Previous summary");
      summarizedQuestions = turns.map((turn) => turn.user);
      return "Updated summary";
    },
  );

  assert.deepEqual(summarizedQuestions, ["Question 4", "Question 5", "Question 6"]);
  assert.equal(session.conversationSummary?.content, "Updated summary");
  assert.equal(session.conversationSummary?.firstKeptTurnIndex, 6);
});

test("leaves context unchanged when compaction fails", async () => {
  const session: SessionState = {
    turns: [
      completedTurn(1, "One", "1"),
      completedTurn(2, "Two", "2"),
      completedTurn(3, "Three", "3"),
    ],
    conversationSummary: {
      content: "Existing summary",
      createdAt: "2026-07-30T00:00:00.000Z",
      firstKeptTurnIndex: 0,
    },
  };

  await assert.rejects(
    compactSession(
      session,
      0,
      2,
      async (turns) => turns.length,
      async () => { throw new Error("Summary failed"); },
    ),
    /Summary failed/,
  );
  assert.equal(session.conversationSummary?.content, "Existing summary");
  assert.equal(session.conversationSummary?.firstKeptTurnIndex, 0);
});

test("keeps the configured minimum number of recent turns", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 5 }, (_, index) => completedTurn(
      index + 1,
      `Question ${index + 1}`,
      `Answer ${index + 1}`,
    )),
  };

  await compactSession(
    session,
    20_000,
    3,
    async (turns) => turns.length * 10_000,
    async () => "Compact summary",
  );

  assert.equal(session.conversationSummary?.firstKeptTurnIndex, 2);
});

test("compacts before a request and verifies the rebuilt context", async () => {
  const counts = [244_800, 30_000];
  let compactions = 0;

  const tokens = await compactIfNeeded(
    244_800,
    async () => counts.shift()!,
    async () => { compactions += 1; },
  );

  assert.equal(compactions, 1);
  assert.equal(tokens, 30_000);
});
