import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSessionActivitySources } from "../../src/harness/memory/activity/session-sources.js";
import {
  appendSessionEvents,
  createSession,
} from "../../src/harness/session/store.js";

test("restores every terminal and interrupted Turn as a durable Activity source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-memory-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory);
  await appendSessionEvents(directory, session.id, [
    {
      type: "turn_started",
      turn: { id: "completed", user: "Complete it", startedAt: "2026-08-04T10:00:00.000Z" },
    },
    {
      type: "agent_run_started",
      run: { id: "run-1", turnId: "completed", startedAt: "2026-08-04T10:00:01.000Z" },
    },
    {
      type: "agent_run_finished",
      runId: "run-1",
      status: "completed",
      finishedAt: "2026-08-04T10:00:02.000Z",
    },
    {
      type: "turn_completed",
      turn: {
        id: "completed",
        user: "Complete it",
        assistant: "Done",
        status: "completed",
        startedAt: "2026-08-04T10:00:00.000Z",
        finishedAt: "2026-08-04T10:00:03.000Z",
      },
    },
    {
      type: "turn_started",
      turn: { id: "failed", user: "Fail it", startedAt: "2026-08-04T10:01:00.000Z" },
    },
    { type: "answer_delta", turnId: "failed", delta: "Partial failure" },
    {
      type: "turn_failed",
      turnId: "failed",
      finishedAt: "2026-08-04T10:01:03.000Z",
      message: "Provider failed",
      includeInContext: false,
    },
    {
      type: "turn_started",
      turn: { id: "cancelled", user: "Cancel it", startedAt: "2026-08-04T10:02:00.000Z" },
    },
    {
      type: "turn_cancelled",
      turnId: "cancelled",
      finishedAt: "2026-08-04T10:02:03.000Z",
    },
    {
      type: "turn_started",
      turn: { id: "interrupted", user: "Interrupt it", startedAt: "2026-08-04T10:03:00.000Z" },
    },
    { type: "answer_delta", turnId: "interrupted", delta: "Partial answer" },
  ]);

  const sources = await loadSessionActivitySources(directory, session.id);

  assert.deepEqual(sources.map(({ sourceId, turn }) => ({
    sourceId,
    status: turn.status,
    assistant: turn.assistant,
  })), [
    { sourceId: `turn:${session.id}:completed`, status: "completed", assistant: "Done" },
    { sourceId: `turn:${session.id}:failed`, status: "failed", assistant: "Partial failure" },
    { sourceId: `turn:${session.id}:cancelled`, status: "cancelled", assistant: "" },
    { sourceId: `turn:${session.id}:interrupted`, status: "interrupted", assistant: "Partial answer" },
  ]);
  assert.deepEqual(sources[0]?.agentRuns.map(({ id }) => id), ["run-1"]);
  assert.equal(sources[1]?.turn.finishedAt, "2026-08-04T10:01:03.000Z");
  assert.ok(Date.parse(sources[3]?.turn.finishedAt ?? "") >=
    Date.parse("2026-08-04T10:03:00.000Z"));
});
