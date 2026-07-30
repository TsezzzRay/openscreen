import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSession,
  appendSessionEvents,
  listSessions,
  loadSession,
  renameSession,
} from "../../src/harness/session/store.js";

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

test("records agent runs and rebuilds tool context from append-only events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const reasoningItem = {
    id: "reasoning-1",
    type: "reasoning" as const,
    status: "completed" as const,
    summary: [],
    content: [],
  };
  const functionCall = {
    id: "function-1",
    call_id: "call-1",
    type: "function_call" as const,
    status: "completed" as const,
    name: "retrieve_context",
    arguments: JSON.stringify({ query: "project status" }),
  };
  const message = {
    id: "message-1",
    type: "message" as const,
    status: "completed" as const,
    role: "assistant" as const,
    content: [{
      type: "output_text" as const,
      text: "The project is active.",
      annotations: [],
    }],
  };
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "What is the project status?",
        startedAt: "2026-07-27T00:00:00.000Z",
        agentRun: true,
      },
    },
    {
      type: "agent_step_completed",
      turnId: "turn-1",
      step: 1,
      responseId: "response-1",
      outputItems: [reasoningItem, functionCall],
      totalTokens: 20,
    },
    {
      type: "tool_result_recorded",
      turnId: "turn-1",
      step: 1,
      callId: "call-1",
      name: "retrieve_context",
      output: JSON.stringify({ matches: [{ text: "The project is active." }] }),
      status: "completed",
    },
    {
      type: "agent_step_completed",
      turnId: "turn-1",
      step: 2,
      responseId: "response-2",
      outputItems: [message],
      totalTokens: 30,
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "What is the project status?",
        assistant: "The project is active.",
      },
    },
  ]);

  const loaded = await loadSession(directory, session.id);

  assert.deepEqual(loaded.agentRuns, [{
    id: "turn-1",
    status: "completed",
    startedAt: "2026-07-27T00:00:00.000Z",
    steps: [
      {
        step: 1,
        responseId: "response-1",
        outputItems: [reasoningItem, functionCall],
        totalTokens: 20,
        toolResults: [{
          callId: "call-1",
          name: "retrieve_context",
          output: JSON.stringify({ matches: [{ text: "The project is active." }] }),
          status: "completed",
        }],
      },
      {
        step: 2,
        responseId: "response-2",
        outputItems: [message],
        totalTokens: 30,
        toolResults: [],
      },
    ],
  }]);
  assert.deepEqual(loaded.turns[0]?.outputItems, [
    reasoningItem,
    functionCall,
    {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ matches: [{ text: "The project is active." }] }),
    },
    message,
  ]);
});

test("rejects malformed model output items in agent run events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const path = join(directory, `${session.id}.jsonl`);
  await appendFile(path, [
    JSON.stringify({
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Question",
        startedAt: "2026-07-27T00:00:00.000Z",
        agentRun: true,
      },
    }),
    JSON.stringify({
      type: "agent_step_completed",
      turnId: "turn-1",
      step: 1,
      outputItems: [{ type: "message" }],
    }),
    "",
  ].join("\n"));

  await assert.rejects(loadSession(directory, session.id), /Invalid session event/);
});

test("persists ordered images and exposes them when restoring visible turns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const images = [
    { id: "system", source: "system_capture", path: "/tmp/system.png" },
    { id: "upload-1", source: "user_upload", path: "/tmp/one.png" },
    { id: "upload-2", source: "user_upload", path: "/tmp/two.png" },
  ];
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Question",
        images,
        startedAt: "2026-07-19T00:00:01.000Z",
      },
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Question",
        assistant: "Answer",
        images,
      },
    },
  ] as any);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.turns[0]?.images, images);
  assert.deepEqual(loaded.visibleTurns[0]?.images, images.slice(1));
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

test("restores failed and cancelled turns into model context with their status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "failed-turn",
        user: "Why did this fail?",
        screenshotPath: "/tmp/failure.png",
        startedAt: "2026-07-19T00:00:01.000Z",
      },
    },
    { type: "answer_delta", turnId: "failed-turn", delta: "Partial answer" },
    {
      type: "turn_failed",
      turnId: "failed-turn",
      message: "Provider failed",
      includeInContext: true,
    },
    {
      type: "turn_started",
      turn: {
        id: "cancelled-turn",
        user: "Stop before capture",
        startedAt: "2026-07-19T00:00:02.000Z",
      },
    },
    { type: "turn_cancelled", turnId: "cancelled-turn" },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.turns, [
    {
      id: "failed-turn",
      user: "Why did this fail?",
      assistant: "Partial answer",
      reasoning: "",
      screenshotPath: "/tmp/failure.png",
      status: "failed",
    },
    {
      id: "cancelled-turn",
      user: "Stop before capture",
      assistant: "",
      reasoning: "",
      status: "cancelled",
    },
  ]);
  assert.deepEqual(loaded.visibleTurns.map(({ status }) => status), ["failed", "cancelled"]);
});

test("keeps legacy failed turns visible without shifting model context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "legacy-failure",
        user: "Old failure",
        screenshotPath: "/tmp/old.png",
        startedAt: "2026-07-18T00:00:00.000Z",
      },
    },
    { type: "turn_failed", turnId: "legacy-failure", message: "Old error" },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.equal(loaded.visibleTurns[0]?.status, "failed");
  assert.deepEqual(loaded.turns, []);
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
