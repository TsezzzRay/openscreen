import assert from "node:assert/strict";
import test from "node:test";

import type { SessionState } from "../session/store.js";
import { compactIfNeeded, compactSession } from "./compaction.js";

test("compacts older turns while retaining 20K recent tokens", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 5 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
      screenshotPath: `screen-${index + 1}.png`,
    })),
    firstKeptTurnIndex: 0,
  };
  let summarizedTurns = 0;

  await compactSession(
    session,
    20_000,
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
      screenshotPath: `screen-${index + 1}.png`,
    })),
    firstKeptTurnIndex: 0,
  };
  let countCalls = 0;

  await compactSession(
    session,
    20_000,
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
      screenshotPath: `screen-${index + 1}.png`,
    })),
    summary: "Previous summary",
    firstKeptTurnIndex: 3,
  };
  let summarizedQuestions: string[] = [];

  await compactSession(
    session,
    20_000,
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

test("leaves context unchanged when compaction fails", async () => {
  const session: SessionState = {
    turns: [
      { user: "One", assistant: "1", screenshotPath: "1.png" },
      { user: "Two", assistant: "2", screenshotPath: "2.png" },
      { user: "Three", assistant: "3", screenshotPath: "3.png" },
    ],
    summary: "Existing summary",
    firstKeptTurnIndex: 0,
  };

  await assert.rejects(
    compactSession(
      session,
      0,
      async (turns) => turns.length,
      async () => { throw new Error("Summary failed"); },
    ),
    /Summary failed/,
  );
  assert.equal(session.summary, "Existing summary");
  assert.equal(session.firstKeptTurnIndex, 0);
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
