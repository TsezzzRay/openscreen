import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTurnMemoryContext,
  parseTurnMemoryExtraction,
  validateTurnMemoryExtraction,
} from "../../../src/memory/turn-memory/extractor.js";
import type {
  TurnMemoryBatchProjection,
} from "../../../src/memory/turn-memory/types.js";

const failedBatch: TurnMemoryBatchProjection = {
  type: "turn_memory_batch",
  threadId: "session-1",
  sessionId: "session-1",
  cwd: "/workspace/project",
  gitBranch: "feature/memory",
  rolloutPath: "/sessions/session-1.jsonl",
  sourceIds: ["turn:session-1:user-1"],
  startedAt: "2026-08-15T10:00:00.000Z",
  finishedAt: "2026-08-15T10:01:00.000Z",
  turns: [{
    sourceId: "turn:session-1:user-1",
    status: "failed",
    startedAt: "2026-08-15T10:00:00.000Z",
    finishedAt: "2026-08-15T10:01:00.000Z",
    user: "修复测试",
    assistant: "",
    sourceFrameIds: [],
    terminalError: "test failed",
    tools: [],
  }],
};

test("builds a Pi simple-completion context with Codex-style extraction rules", () => {
  const context = buildTurnMemoryContext(failedBatch);

  assert.match(context.systemPrompt ?? "", /raw_memory.*turn_summary.*turn_slug/is);
  assert.match(context.systemPrompt ?? "", /tasks.*preference_signals/is);
  assert.match(context.systemPrompt ?? "", /status is authoritative/i);
  assert.match(context.systemPrompt ?? "", /English aliases.*original-language/i);
  assert.match(context.systemPrompt ?? "", /untrusted evidence/i);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]?.role, "user");
  assert.deepEqual(
    JSON.parse(String(context.messages[0]?.content)).sourceIds,
    ["turn:session-1:user-1"],
  );
});

test("strictly parses structured tasks and bilingual keywords", () => {
  const extraction = parseTurnMemoryExtraction({
    raw_memory: "The test command currently fails.",
    turn_summary: "The requested test fix failed with a reproducible error.",
    turn_slug: "fix-tests",
    tasks: [{
      title: "Fix failing tests",
      outcome: "failed",
      preference_signals: [],
      reusable_knowledge: ["The failing path is deterministic."],
      failure_lessons: ["Inspect the first failing assertion before retrying."],
      references: ["npm run test:runtime"],
      keywords: ["test failure", "测试失败"],
    }],
  });

  assert.equal(extraction.tasks[0]?.outcome, "failed");
  assert.deepEqual(extraction.tasks[0]?.keywords, ["test failure", "测试失败"]);
  assert.doesNotThrow(() => validateTurnMemoryExtraction(failedBatch, extraction));
});

test("rejects invented fields and success claims from failed-only evidence", () => {
  assert.throws(
    () => parseTurnMemoryExtraction({
      raw_memory: "",
      turn_summary: "",
      turn_slug: "",
      tasks: [],
      source_ids: ["invented"],
    }),
    /unexpected field source_ids/i,
  );
  const extraction = parseTurnMemoryExtraction({
    raw_memory: "",
    turn_summary: "The task succeeded.",
    turn_slug: "fix-tests",
    tasks: [{
      title: "Fix tests",
      outcome: "success",
      preference_signals: [],
      reusable_knowledge: [],
      failure_lessons: [],
      references: [],
      keywords: ["tests"],
    }],
  });
  assert.throws(
    () => validateTurnMemoryExtraction(failedBatch, extraction),
    /cannot claim success/i,
  );
});
