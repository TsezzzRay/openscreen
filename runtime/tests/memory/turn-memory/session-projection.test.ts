import assert from "node:assert/strict";
import test from "node:test";

import type {
  JsonlSessionMetadata,
  Session,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import {
  projectTerminalTurnSources,
} from "../../../src/memory/turn-memory/session-projection.js";

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "custom" | "toolResult" | "bashExecution",
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-15T10:00:${String(id.length).padStart(2, "0")}.000Z`,
    message: role === "bashExecution"
      ? { role, output: content, ...extra }
      : { role, content, ...extra },
  } as unknown as SessionTreeEntry;
}

function session(branch: SessionTreeEntry[]): Session<JsonlSessionMetadata> {
  return {
    getMetadata: async () => ({
      id: "session-1",
      createdAt: "2026-08-15T10:00:00.000Z",
      cwd: "/workspace/project",
      path: "/memory/sessions/session-1.jsonl",
    }),
    getBranch: async () => branch,
  } as unknown as Session<JsonlSessionMetadata>;
}

test("projects only closed Pi branch Turns with code-owned provenance", async () => {
  const firstUser = message("user-1", null, "user", "First question");
  const firstAnswer = message(
    "answer-1",
    "user-1",
    "assistant",
    [{ type: "text", text: "First answer" }],
    { stopReason: "stop" },
  );
  const compaction = {
    type: "compaction",
    id: "compact-1",
    parentId: "answer-1",
    timestamp: "2026-08-15T10:01:00.000Z",
    summary: "Earlier work selected SQLite.",
    firstKeptEntryId: "answer-1",
    tokensBefore: 8_000,
  } as const satisfies SessionTreeEntry;
  const secondUser = message(
    "user-2",
    "compact-1",
    "user",
    [
      { type: "text", text: "继续实现 memory" },
      { type: "image", data: "secret-base64", mimeType: "image/png" },
    ],
  );
  const capture = message(
    "capture-2",
    "user-2",
    "custom",
    [
      {
        type: "text",
        text: JSON.stringify({
          frames: [
            { sourceId: "screenpipe-frame-2" },
            { sourceId: "screenpipe-frame-1" },
            { sourceId: "screenpipe-frame-2" },
          ],
          accessibility: "private screen text",
        }),
      },
      { type: "image", data: "private-screen-base64", mimeType: "image/jpeg" },
    ],
    { customType: "openscreen.injected-context", display: false },
  );
  const toolCall = message(
    "tool-call",
    "capture-2",
    "assistant",
    [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ],
    { stopReason: "toolUse" },
  );
  const toolResult = message(
    "tool-result",
    "tool-call",
    "toolResult",
    [{ type: "text", text: "MEMORY.md uses rollout summaries." }],
    { toolCallId: "call-1", toolName: "read", isError: false },
  );
  const finalAnswer = message(
    "answer-2",
    "tool-result",
    "assistant",
    [{
      type: "text",
      text: "Implemented Turn Memory.\n<oai-mem-citation>{\"entries\":[],\"rolloutIds\":[]}</oai-mem-citation>",
    }],
    { stopReason: "stop" },
  );

  const projection = await projectTerminalTurnSources(
    session([
      firstUser,
      firstAnswer,
      compaction,
      secondUser,
      capture,
      toolCall,
      toolResult,
      finalAnswer,
    ]),
    { gitBranch: "codex/screenpipe-chronicle", afterEntryId: "answer-1" },
  );

  assert.equal(projection.cursorRewound, false);
  assert.equal(projection.nextEntryId, "answer-2");
  assert.equal(projection.sources.length, 1);
  assert.deepEqual(projection.sources[0], {
    sourceId: "turn:session-1:user-2",
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "codex/screenpipe-chronicle",
    rolloutPath: "/memory/sessions/session-1.jsonl",
    userEntryIds: ["user-2"],
    terminalEntryId: "answer-2",
    startedAt: secondUser.timestamp,
    finishedAt: finalAnswer.timestamp,
    occurredAt: finalAnswer.timestamp,
    status: "completed",
    user: "继续实现 memory",
    assistant: "Implemented Turn Memory.",
    sourceFrameIds: ["screenpipe-frame-2", "screenpipe-frame-1"],
    compactionSummary: "Earlier work selected SQLite.",
    tools: [{
      name: "read",
      status: "completed",
      result: "MEMORY.md uses rollout summaries.",
    }],
  });
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /private reasoning|private screen text|base64/);
  assert.doesNotMatch(serialized, /captureGroup/i);
  assert.doesNotMatch(serialized, /I will inspect it/);
});

test("keeps an unfinished Turn pending and maps terminal failure status", async () => {
  const user = message("failed-user", null, "user", "Run the failing command");
  const bash = message(
    "bash-result",
    "failed-user",
    "bashExecution",
    "command failed",
    { command: "npm test", exitCode: 1, cancelled: false, truncated: false },
  );
  const failure = message(
    "failed-answer",
    "bash-result",
    "assistant",
    [],
    { stopReason: "error", errorMessage: "provider unavailable" },
  );
  const pending = message(
    "pending-user",
    "failed-answer",
    "user",
    "This Turn is not complete",
  );

  const projection = await projectTerminalTurnSources(
    session([user, bash, failure, pending]),
    { gitBranch: "main" },
  );

  assert.equal(projection.nextEntryId, "failed-answer");
  assert.equal(projection.sources.length, 1);
  assert.equal(projection.sources[0]?.status, "failed");
  assert.equal(projection.sources[0]?.terminalError, "provider unavailable");
  assert.deepEqual(projection.sources[0]?.tools, [{
    name: "bash",
    status: "failed",
    result: "command failed",
  }]);
  assert.doesNotMatch(JSON.stringify(projection), /This Turn is not complete/);
});

test("rescans the active branch when a durable cursor was rewound", async () => {
  const user = message("revised-user", null, "user", "Revised request");
  const answer = message(
    "revised-answer",
    "revised-user",
    "assistant",
    [{ type: "text", text: "Revised answer" }],
    { stopReason: "stop" },
  );

  const projection = await projectTerminalTurnSources(
    session([user, answer]),
    { gitBranch: "feature", afterEntryId: "abandoned-answer" },
  );

  assert.equal(projection.cursorRewound, true);
  assert.deepEqual(
    projection.sources.map(({ sourceId }) => sourceId),
    ["turn:session-1:revised-user"],
  );
  assert.equal(projection.nextEntryId, "revised-answer");
});
