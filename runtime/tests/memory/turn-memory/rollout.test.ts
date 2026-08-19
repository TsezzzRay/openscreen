import assert from "node:assert/strict";
import test from "node:test";

import { renderTurnRollout } from "../../../src/memory/turn-memory/rollout.js";
import type { TurnMemorySource } from "../../../src/memory/turn-memory/types.js";

function source(overrides: Partial<TurnMemorySource> = {}): TurnMemorySource {
  return {
    sourceId: "turn:session-1:user-1",
    threadId: "session-1",
    sessionId: "session-1",
    cwd: "/workspace/project",
    gitBranch: "feature/memory",
    rolloutPath: "/sessions/session-1.jsonl",
    userEntryIds: ["user-1"],
    terminalEntryId: "answer-1",
    startedAt: "2026-08-19T09:00:00.000Z",
    finishedAt: "2026-08-19T09:00:05.000Z",
    occurredAt: "2026-08-19T09:00:05.000Z",
    status: "completed",
    user: "记住使用 node:sqlite",
    assistant: "Implemented with node:sqlite.",
    sourceFrameIds: ["screenpipe-frame:gen-1:1"],
    tools: [],
    ...overrides,
  };
}

test("renders a provenance header without source_frame_ids", () => {
  const { relativePath, content } = renderTurnRollout(source(), Date.parse("2026-08-19T09:01:00.000Z"));
  assert.match(relativePath, /^rollout_summaries\/turn-2026-08-19T09-00-00-000Z-[0-9a-f]{12}\.md$/);
  assert.match(content, /^thread_id: session-1$/m);
  assert.match(content, /^session_id: session-1$/m);
  assert.match(content, /^rollout_id: turn:session-1:user-1$/m);
  assert.match(content, /^status: completed$/m);
  assert.doesNotMatch(content, /source_frame_ids/);
  assert.match(content, /记住使用 node:sqlite/);
  assert.match(content, /Implemented with node:sqlite\./);
});

test("includes tools, compaction summary, and terminal error when present", () => {
  const { content, observationText } = renderTurnRollout(source({
    status: "failed",
    terminalError: "Provider timeout",
    compactionSummary: "Earlier context was compacted.",
    tools: [{ name: "bash", status: "failed", result: "command not found" }],
  }), Date.parse("2026-08-19T09:01:00.000Z"));
  assert.match(content, /# Prior compaction summary/);
  assert.match(content, /Earlier context was compacted\./);
  assert.match(content, /# Terminal error/);
  assert.match(content, /Provider timeout/);
  assert.match(content, /- bash \[failed\]: command not found/);
  assert.match(observationText, /Turn status: failed/);
  assert.match(observationText, /Terminal error: Provider timeout/);
  assert.match(observationText, /Tools used: bash \(failed\)/);
});

test("observationText omits the status line for a normal completed Turn", () => {
  const { observationText } = renderTurnRollout(source(), Date.parse("2026-08-19T09:01:00.000Z"));
  assert.doesNotMatch(observationText, /Turn status/);
  assert.match(observationText, /^User: 记住使用 node:sqlite$/m);
  assert.match(observationText, /^Assistant: Implemented with node:sqlite\.$/m);
});
