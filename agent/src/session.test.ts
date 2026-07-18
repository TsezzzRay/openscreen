import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_AT_TOKENS,
  KEEP_RECENT_TOKENS,
  MAX_OUTPUT_TOKENS,
  compactIfNeeded,
  compactSession,
  type SessionState,
} from "./session.js";

test("compacts older turns while retaining 20K recent tokens", async () => {
  assert.equal(KEEP_RECENT_TOKENS, 20_000);
  const session: SessionState = {
    turns: Array.from({ length: 5 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    firstKeptTurnIndex: 0,
  };
  let summarizedTurns = 0;

  await compactSession(
    session,
    async (turns) => turns.length * 10_000,
    async (_previousSummary, turns) => {
      summarizedTurns = turns.length;
      return "Compact summary";
    },
  );

  assert.equal(summarizedTurns, 3);
  assert.equal(session.summary, "Compact summary");
  assert.equal(session.firstKeptTurnIndex, 3);
  assert.equal(session.turns.length, 5);
});

test("finds the 20K recent-turn boundary without scanning every turn", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 100 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    firstKeptTurnIndex: 0,
  };
  let countCalls = 0;

  await compactSession(
    session,
    async (turns) => {
      countCalls += 1;
      return turns.length * 1_000;
    },
    async () => "Compact summary",
  );

  assert.equal(session.firstKeptTurnIndex, 80);
  assert.ok(countCalls <= 8);
});

test("rolls the previous summary forward without re-summarizing raw history", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 8 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    summary: "Previous summary",
    firstKeptTurnIndex: 3,
  };
  let summarizedQuestions: string[] = [];

  await compactSession(
    session,
    async (turns) => turns.length * 10_000,
    async (previousSummary, turns) => {
      assert.equal(previousSummary, "Previous summary");
      summarizedQuestions = turns.map((turn) => turn.user);
      return "Updated summary";
    },
  );

  assert.deepEqual(summarizedQuestions, ["Question 4", "Question 5", "Question 6"]);
  assert.equal(session.summary, "Updated summary");
  assert.equal(session.firstKeptTurnIndex, 6);
});

test("compacts before a request and verifies the rebuilt context", async () => {
  assert.equal(COMPACT_AT_TOKENS, 244_800);
  assert.equal(MAX_OUTPUT_TOKENS, 21_760);
  const counts = [244_800, 30_000];
  let compactions = 0;

  const tokens = await compactIfNeeded(
    async () => counts.shift()!,
    async () => { compactions += 1; },
  );

  assert.equal(compactions, 1);
  assert.equal(tokens, 30_000);
});
