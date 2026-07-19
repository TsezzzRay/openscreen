import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  compactIfNeeded,
  compactSession,
  createSession,
  appendSessionEvents,
  listSessions,
  loadSession,
  renameSession,
  type SessionState,
} from "./session.js";

const execFileAsync = promisify(execFile);

test("stores metadata on the first line and replays completed turns and compaction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Question",
        screenshotPath: "/tmp/screen.png",
        startedAt: "2026-07-19T00:00:01.000Z",
      },
    },
    { type: "reasoning_delta", turnId: "turn-1", delta: "Checked " },
    { type: "answer_delta", turnId: "turn-1", delta: "Ans" },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Question",
        assistant: "Answer",
        reasoning: "Checked the screen",
        screenshotPath: "/tmp/screen.png",
      },
    },
    { type: "context_compacted", summary: "Earlier facts", firstKeptTurnIndex: 1 },
  ]);

  const path = join(directory, `${session.id}.jsonl`);
  const [header] = (await readFile(path, "utf8")).split("\n");
  assert.deepEqual(JSON.parse(header), {
    type: "session",
    id: session.id,
    title: "New Chat",
    createdAt: session.createdAt,
  });

  const loaded = await loadSession(directory, session.id);
  assert.equal(loaded.summary, "Earlier facts");
  assert.equal(loaded.firstKeptTurnIndex, 1);
  assert.deepEqual(loaded.turns, [{
    id: "turn-1",
    user: "Question",
    assistant: "Answer",
    reasoning: "Checked the screen",
    screenshotPath: "/tmp/screen.png",
  }]);
  assert.equal(loaded.visibleTurns[0]?.status, "completed");
});

test("restores an unfinished turn as interrupted without adding it to model context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Question",
        screenshotPath: "/tmp/screen.png",
        startedAt: "2026-07-19T00:00:01.000Z",
      },
    },
    { type: "reasoning_delta", turnId: "turn-1", delta: "Partial thought" },
    { type: "answer_delta", turnId: "turn-1", delta: "Partial answer" },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.turns, []);
  assert.deepEqual(loaded.visibleTurns, [{
    id: "turn-1",
    user: "Question",
    assistant: "Partial answer",
    reasoning: "Partial thought",
    status: "interrupted",
  }]);
});

test("ignores an unterminated final fragment but rejects a corrupt complete line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const path = join(directory, `${session.id}.jsonl`);
  await appendFile(path, '{"type":"turn_started"');
  assert.equal((await loadSession(directory, session.id)).turns.length, 0);

  await appendSessionEvents(directory, session.id, [{
    type: "turn_started",
    turn: {
      id: "turn-after-crash",
      user: "Recovered",
      screenshotPath: "/tmp/recovered.png",
      startedAt: "2026-07-19T00:00:02.000Z",
    },
  }]);
  assert.equal((await loadSession(directory, session.id)).visibleTurns[0]?.user, "Recovered");

  const corrupt = await createSession(directory);
  await appendFile(join(directory, `${corrupt.id}.jsonl`), "not-json\n");
  await assert.rejects(loadSession(directory, corrupt.id), /Invalid session event/);
});

test("lists newest sessions using only the metadata line and file mtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const older = await createSession(directory);
  const newer = await createSession(directory);
  await appendFile(join(directory, `${newer.id}.jsonl`), "not-json\n");
  await utimes(
    join(directory, `${older.id}.jsonl`),
    new Date("2026-07-18T00:00:00.000Z"),
    new Date("2026-07-18T00:00:00.000Z"),
  );
  await utimes(
    join(directory, `${newer.id}.jsonl`),
    new Date("2026-07-19T00:00:00.000Z"),
    new Date("2026-07-19T00:00:00.000Z"),
  );
  await writeFile(join(directory, "corrupt.jsonl"), "not json\n");
  await writeFile(join(directory, "invalid.jsonl"), JSON.stringify({
    type: "session",
    id: "00000000-0000-4000-8000-000000000001",
    title: 123,
    createdAt: "2026-07-19T00:00:00.000Z",
  }) + "\n");

  const listed = await listSessions(directory);
  assert.deepEqual(listed.map(({ id }) => id), [newer.id, older.id]);
  assert.equal(listed[0]?.updatedAt, "2026-07-19T00:00:00.000Z");
});

test("renames a session after trimming and rejects an empty title", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);

  const renamed = await renameSession(directory, session.id, "  Project notes  ");

  assert.equal(renamed.title, "Project notes");
  assert.equal((await loadSession(directory, session.id)).title, "Project notes");
  assert.equal(
    (await readFile(join(directory, `${session.id}.jsonl`), "utf8")).split("\n")[0],
    JSON.stringify({
      type: "session",
      id: session.id,
      title: "Project notes",
      createdAt: session.createdAt,
    }),
  );
  await assert.rejects(
    renameSession(directory, session.id, "   "),
    /title is required/i,
  );
});

test("serializes the same session across processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const marker = join(directory, "marker.txt");
  const moduleURL = new URL("./session.js", import.meta.url).href;
  const script = `
    import { appendFile } from "node:fs/promises";
    import { withSessionLock } from ${JSON.stringify(moduleURL)};
    const [directory, sessionId, marker, label] = process.argv.slice(1);
    await withSessionLock(directory, sessionId, async () => {
      await appendFile(marker, label + "-start\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await appendFile(marker, label + "-end\\n");
    });
  `;

  await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, directory, session.id, marker, "A"]),
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, directory, session.id, marker, "B"]),
  ]);

  const lines = (await readFile(marker, "utf8")).trim().split("\n");
  assert.ok(
    JSON.stringify(lines) === JSON.stringify(["A-start", "A-end", "B-start", "B-end"]) ||
    JSON.stringify(lines) === JSON.stringify(["B-start", "B-end", "A-start", "A-end"]),
    `lock events overlapped: ${lines.join(", ")}`,
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
