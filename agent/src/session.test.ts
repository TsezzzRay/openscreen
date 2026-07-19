import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compactIfNeeded,
  compactSession,
  createSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  type SessionState,
} from "./session.js";

test("persists and reloads complete session state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  session.turns.push({
    id: "turn-1",
    user: "Question",
    assistant: "Answer",
    reasoning: "Checked the screen",
    screenshotPath: "/tmp/screen.png",
  });
  session.summary = "Earlier facts";
  session.firstKeptTurnIndex = 1;

  await saveSession(directory, session);

  assert.deepEqual(await loadSession(directory, session.id), session);
});

test("lists newest sessions first and ignores corrupt files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const older = await createSession(directory);
  const newer = await createSession(directory);
  older.updatedAt = "2026-07-18T00:00:00.000Z";
  newer.updatedAt = "2026-07-19T00:00:00.000Z";
  await saveSession(directory, older);
  await saveSession(directory, newer);
  await writeFile(join(directory, "corrupt.json"), "not json");
  await writeFile(join(directory, "invalid.json"), JSON.stringify({
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    title: "Invalid",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    turns: [{}],
    firstKeptTurnIndex: 2,
  }));

  assert.deepEqual(
    (await listSessions(directory)).map(({ id }) => id),
    [newer.id, older.id],
  );
});

test("renames a session after trimming and rejects an empty title", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);

  const renamed = await renameSession(directory, session.id, "  Project notes  ");

  assert.equal(renamed.title, "Project notes");
  assert.equal((await loadSession(directory, session.id)).title, "Project notes");
  await assert.rejects(
    renameSession(directory, session.id, "   "),
    /title is required/i,
  );
});

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
