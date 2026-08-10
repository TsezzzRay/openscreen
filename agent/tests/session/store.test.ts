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
import type { TurnScreenContext } from "../../src/types.js";

function userImages(path: string) {
  return [{ id: "upload", source: "user_upload" as const, path }];
}

const screenContext: TurnScreenContext = {
  ref: {
    captureId: "capture-1",
    observationId: "observation-1",
    intentRevision: 6,
    artifactRevision: 4,
    completedRevision: 5,
    intentContentEpoch: 3,
    artifactContentEpoch: 2,
    completedContentEpoch: 3,
    startedAt: "2026-08-07T00:00:00.000Z",
    capturedAt: "2026-08-07T00:00:00.100Z",
    status: "complete",
    target: { processIdentifier: 100, windowIdentifier: 7 },
    image: {
      path: "/tmp/capture-1.jpg",
      mimeType: "image/jpeg",
      width: 100,
      height: 80,
    },
  },
  accessibility: {
    captureId: "capture-1",
    application: "Editor",
    visibleText: "Document",
  },
};

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
        images: userImages("/tmp/screen.png"),
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
        images: userImages("/tmp/screen.png"),
        status: "completed",
        startedAt: "2026-07-19T00:00:01.000Z",
        finishedAt: "2026-07-19T00:00:02.000Z",
      },
    },
    {
      type: "context_compacted",
      summary: {
        content: "Earlier facts",
        createdAt: "2026-07-19T00:00:02.000Z",
        firstKeptTurnIndex: 1,
      },
    },
  ] as any);

  const path = join(directory, `${session.id}.jsonl`);
  const [header] = (await readFile(path, "utf8")).split("\n");
  assert.deepEqual(JSON.parse(header), {
    type: "session",
    id: session.id,
    title: "New Chat",
    createdAt: session.createdAt,
  });

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual((loaded as any).conversationSummary, {
    content: "Earlier facts",
    createdAt: "2026-07-19T00:00:02.000Z",
    firstKeptTurnIndex: 1,
  });
  assert.equal("summary" in loaded, false);
  assert.equal("firstKeptTurnIndex" in loaded, false);
  assert.deepEqual(loaded.turns, [{
    id: "turn-1",
    user: "Question",
    assistant: "Answer",
    reasoning: "Checked the screen",
    images: userImages("/tmp/screen.png"),
    status: "completed",
    startedAt: "2026-07-19T00:00:01.000Z",
    finishedAt: "2026-07-19T00:00:02.000Z",
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
      },
    },
    {
      type: "agent_run_started",
      run: {
        id: "run-1",
        turnId: "turn-1",
        startedAt: "2026-07-27T00:00:00.100Z",
      },
    },
    {
      type: "agent_step_completed",
      runId: "run-1",
      step: 1,
      responseId: "response-1",
      outputItems: [reasoningItem, functionCall],
      totalTokens: 20,
    },
    {
      type: "tool_result_recorded",
      runId: "run-1",
      step: 1,
      callId: "call-1",
      name: "retrieve_context",
      output: JSON.stringify({ matches: [{ text: "The project is active." }] }),
      status: "completed",
    },
    {
      type: "agent_step_completed",
      runId: "run-1",
      step: 2,
      responseId: "response-2",
      outputItems: [message],
      totalTokens: 30,
    },
    {
      type: "agent_run_finished",
      runId: "run-1",
      status: "completed",
      finishedAt: "2026-07-27T00:00:01.000Z",
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "What is the project status?",
        assistant: "The project is active.",
        status: "completed",
        startedAt: "2026-07-27T00:00:00.000Z",
        finishedAt: "2026-07-27T00:00:01.100Z",
      },
    },
  ] as any);

  const loaded = await loadSession(directory, session.id);

  assert.deepEqual(loaded.agentRuns, [{
    id: "run-1",
    turnId: "turn-1",
    status: "completed",
    startedAt: "2026-07-27T00:00:00.100Z",
    finishedAt: "2026-07-27T00:00:01.000Z",
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

test("replays durable tool call lifecycle and preserves an unfinished outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const first = {
    id: "function-1",
    call_id: "call-1",
    type: "function_call" as const,
    status: "completed" as const,
    name: "read",
    arguments: JSON.stringify({ path: "/tmp/one" }),
  };
  const second = {
    id: "function-2",
    call_id: "call-2",
    type: "function_call" as const,
    status: "completed" as const,
    name: "bash",
    arguments: JSON.stringify({ command: "sleep 10" }),
  };
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "inspect",
        startedAt: "2026-08-10T00:00:00.000Z",
      },
    },
    {
      type: "agent_run_started",
      run: {
        id: "run-1",
        turnId: "turn-1",
        startedAt: "2026-08-10T00:00:00.100Z",
      },
    },
    {
      type: "agent_step_completed",
      runId: "run-1",
      step: 1,
      outputItems: [first, second],
    },
    {
      type: "tool_call_started",
      runId: "run-1",
      step: 1,
      callId: "call-1",
      name: "read",
      arguments: first.arguments,
      startedAt: "2026-08-10T00:00:00.200Z",
    },
    {
      type: "tool_call_started",
      runId: "run-1",
      step: 1,
      callId: "call-2",
      name: "bash",
      arguments: second.arguments,
      startedAt: "2026-08-10T00:00:00.201Z",
    },
    {
      type: "tool_call_finished",
      runId: "run-1",
      step: 1,
      callId: "call-1",
      name: "read",
      output: "content",
      status: "completed",
      finishedAt: "2026-08-10T00:00:00.300Z",
      details: { truncation: { truncated: false } },
    },
    {
      type: "agent_run_finished",
      runId: "run-1",
      status: "cancelled",
      finishedAt: "2026-08-10T00:00:01.000Z",
    },
    {
      type: "turn_cancelled",
      turnId: "turn-1",
      finishedAt: "2026-08-10T00:00:01.100Z",
    },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.agentRuns[0]?.steps[0]?.toolCalls, [
    {
      callId: "call-1",
      name: "read",
      arguments: first.arguments,
      status: "completed",
      startedAt: "2026-08-10T00:00:00.200Z",
      finishedAt: "2026-08-10T00:00:00.300Z",
      output: "content",
      details: { truncation: { truncated: false } },
    },
    {
      callId: "call-2",
      name: "bash",
      arguments: second.arguments,
      status: "interrupted",
      startedAt: "2026-08-10T00:00:00.201Z",
    },
  ]);
  assert.deepEqual(loaded.agentRuns[0]?.steps[0]?.toolResults, [{
    callId: "call-1",
    name: "read",
    output: "content",
    status: "completed",
    details: { truncation: { truncated: false } },
  }]);
});

test("rebuilds parallel tool outputs in model call order rather than finish order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const calls = ["first", "second"].map((name, index) => ({
    id: `item-${index + 1}`,
    call_id: `call-${index + 1}`,
    type: "function_call" as const,
    status: "completed" as const,
    name,
    arguments: "{}",
  }));
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: { id: "turn-1", user: "run", startedAt: "2026-08-10T00:00:00.000Z" },
    },
    {
      type: "agent_run_started",
      run: { id: "run-1", turnId: "turn-1", startedAt: "2026-08-10T00:00:00.100Z" },
    },
    {
      type: "agent_step_completed",
      runId: "run-1",
      step: 1,
      outputItems: calls,
    },
    ...calls.map((call, index) => ({
      type: "tool_call_started" as const,
      runId: "run-1",
      step: 1,
      callId: call.call_id,
      name: call.name,
      arguments: call.arguments,
      startedAt: `2026-08-10T00:00:00.20${index}Z`,
    })),
    ...[calls[1], calls[0]].map((call, index) => ({
      type: "tool_call_finished" as const,
      runId: "run-1",
      step: 1,
      callId: call.call_id,
      name: call.name,
      output: `${call.name}-result`,
      status: "completed" as const,
      finishedAt: `2026-08-10T00:00:00.30${index}Z`,
    })),
    {
      type: "agent_run_finished",
      runId: "run-1",
      status: "completed",
      finishedAt: "2026-08-10T00:00:01.000Z",
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "run",
        assistant: "done",
        status: "completed",
        startedAt: "2026-08-10T00:00:00.000Z",
        finishedAt: "2026-08-10T00:00:01.100Z",
      },
    },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(
    loaded.turns[0]?.outputItems?.filter((item) => item.type === "function_call_output")
      .map((item: any) => item.call_id),
    ["call-1", "call-2"],
  );
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
      },
    }),
    JSON.stringify({
      type: "agent_run_started",
      run: {
        id: "run-1",
        turnId: "turn-1",
        startedAt: "2026-07-27T00:00:00.100Z",
      },
    }),
    JSON.stringify({
      type: "agent_step_completed",
      runId: "run-1",
      step: 1,
      outputItems: [{ type: "message" }],
    }),
    "",
  ].join("\n"));

  await assert.rejects(loadSession(directory, session.id), /Invalid session event/);
});

test("rejects a completed Turn that rewrites its start facts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: {
        id: "turn-1",
        user: "Original question",
        startedAt: "2026-07-27T00:00:00.000Z",
      },
    },
    {
      type: "turn_completed",
      turn: {
        id: "turn-1",
        user: "Rewritten question",
        assistant: "Answer",
        status: "completed",
        startedAt: "2026-07-27T00:00:00.500Z",
        finishedAt: "2026-07-27T00:00:01.000Z",
      },
    },
  ]);

  await assert.rejects(loadSession(directory, session.id), /Turn start mismatch/);
});

test("persists screen context separately from visible user uploads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const images = [
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
        screenContext,
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
        screenContext,
        status: "completed",
        startedAt: "2026-07-19T00:00:01.000Z",
        finishedAt: "2026-07-19T00:00:02.000Z",
      },
    },
  ] as any);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.turns[0]?.images, images);
  assert.deepEqual(loaded.turns[0]?.screenContext, screenContext);
  assert.deepEqual(loaded.recordedTurns[0]?.screenContext, screenContext);
  assert.deepEqual(loaded.visibleTurns[0]?.images, images);
});

test("rejects an invalid native capture start time in screen context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [{
    type: "turn_started",
    turn: {
      id: "turn-1",
      user: "Question",
      screenContext: {
        ...screenContext,
        ref: { ...screenContext.ref, startedAt: "not-a-timestamp" },
      },
      startedAt: "2026-07-19T00:00:01.000Z",
    },
  }]);

  await assert.rejects(
    loadSession(directory, session.id),
    /Invalid session event/,
  );
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
        images: userImages("/tmp/screen.png"),
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
    images: userImages("/tmp/screen.png"),
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
        images: userImages("/tmp/failure.png"),
        startedAt: "2026-07-19T00:00:01.000Z",
      },
    },
    { type: "answer_delta", turnId: "failed-turn", delta: "Partial answer" },
    {
      type: "turn_failed",
      turnId: "failed-turn",
      finishedAt: "2026-07-19T00:00:01.500Z",
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
    {
      type: "turn_cancelled",
      turnId: "cancelled-turn",
      finishedAt: "2026-07-19T00:00:02.500Z",
    },
  ]);

  const loaded = await loadSession(directory, session.id);
  assert.deepEqual(loaded.turns, [
    {
      id: "failed-turn",
      user: "Why did this fail?",
      assistant: "Partial answer",
      reasoning: "",
      images: userImages("/tmp/failure.png"),
      status: "failed",
      startedAt: "2026-07-19T00:00:01.000Z",
      finishedAt: "2026-07-19T00:00:01.500Z",
    },
    {
      id: "cancelled-turn",
      user: "Stop before capture",
      assistant: "",
      reasoning: "",
      status: "cancelled",
      startedAt: "2026-07-19T00:00:02.000Z",
      finishedAt: "2026-07-19T00:00:02.500Z",
    },
  ]);
  assert.deepEqual(loaded.visibleTurns.map(({ status }) => status), ["failed", "cancelled"]);
});

test("rejects session events that use screenshotPath", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendFile(join(directory, `${session.id}.jsonl`), `${JSON.stringify({
    type: "turn_started",
    turn: {
      id: "old-turn",
      user: "Old request",
      screenshotPath: "/tmp/old.png",
      startedAt: "2026-07-18T00:00:00.000Z",
    },
  })}\n`);

  await assert.rejects(
    loadSession(directory, session.id),
    /Invalid session event/,
  );
});

test("rejects legacy system_capture images in session events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendFile(join(directory, `${session.id}.jsonl`), `${JSON.stringify({
    type: "turn_started",
    turn: {
      id: "old-turn",
      user: "Old request",
      images: [{
        id: "system",
        source: "system_capture",
        path: "/tmp/legacy-system.png",
      }],
      startedAt: "2026-07-18T00:00:00.000Z",
    },
  })}\n`);

  await assert.rejects(loadSession(directory, session.id), /Invalid session event/);
});

test("rejects the removed turn-level Agent Run flag", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  await appendFile(join(directory, `${session.id}.jsonl`), `${JSON.stringify({
    type: "turn_started",
    turn: {
      id: "old-turn",
      user: "Old request",
      startedAt: "2026-07-18T00:00:00.000Z",
      agentRun: true,
    },
  })}\n`);

  await assert.rejects(loadSession(directory, session.id), /Invalid session event/);
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
      images: userImages("/tmp/recovered.png"),
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
