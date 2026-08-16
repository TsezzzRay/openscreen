import assert from "node:assert/strict";
import test from "node:test";

import type {
  Session,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import { projectSession } from "../../src/agent/pi/session-projection.js";

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "custom" | "toolResult",
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-14T00:00:0${id.length}.000Z`,
    message: {
      role,
      content,
      ...extra,
    },
  } as unknown as SessionTreeEntry;
}

test("projects only the active branch as a linear conversation", async () => {
  const state = {
    type: "thinking_level_change",
    id: "state",
    parentId: null,
    timestamp: "2026-08-14T00:00:00.000Z",
    thinkingLevel: "medium",
  } as const satisfies SessionTreeEntry;
  const rootUser = message("user-root", "state", "user", "First question");
  const hiddenContext = message(
    "capture",
    "user-root",
    "custom",
    [{ type: "text", text: "private screen context" }],
    { customType: "openscreen.injected-context", display: false },
  );
  const toolCall = message(
    "assistant-tool",
    "capture",
    "assistant",
    [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    { provider: "test", model: "model", stopReason: "toolUse" },
  );
  const toolResult = message(
    "tool-result",
    "assistant-tool",
    "toolResult",
    [{ type: "text", text: "internal tool output" }],
    { toolCallId: "call", toolName: "read", isError: false },
  );
  const rootAnswer = message(
    "assistant-root",
    "tool-result",
    "assistant",
    [{
      type: "text",
      text: "First answer\n<oai-mem-citation>{\"entries\":[],\"rolloutIds\":[]}</oai-mem-citation>",
    }],
    { provider: "test", model: "model", stopReason: "stop" },
  );
  const oldUser = message("user-old", "assistant-root", "user", "Old follow-up");
  const oldAnswer = message(
    "assistant-old",
    "user-old",
    "assistant",
    [{ type: "text", text: "Old branch answer" }],
    { provider: "test", model: "model", stopReason: "stop" },
  );
  const summary = {
    type: "branch_summary",
    id: "summary",
    parentId: "assistant-root",
    timestamp: "2026-08-14T00:00:08.000Z",
    fromId: "assistant-root",
    summary: "Abandoned branch summary",
  } as const satisfies SessionTreeEntry;
  const activeUser = message(
    "user-active",
    "summary",
    "user",
    [
      { type: "text", text: "Revised follow-up" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
  );
  const failedAnswer = message(
    "assistant-failed",
    "user-active",
    "assistant",
    [],
    {
      provider: "test",
      model: "model",
      stopReason: "error",
      errorMessage: "provider unavailable",
    },
  );
  const entries = [
    state,
    rootUser,
    hiddenContext,
    toolCall,
    toolResult,
    rootAnswer,
    oldUser,
    oldAnswer,
    summary,
    activeUser,
    failedAnswer,
  ];
  const activeBranch = [
    state,
    rootUser,
    hiddenContext,
    toolCall,
    toolResult,
    rootAnswer,
    summary,
    activeUser,
    failedAnswer,
  ];
  const session = {
    getMetadata: async () => ({
      id: "session",
      createdAt: "2026-08-14T00:00:00.000Z",
    }),
    getSessionName: async () => "Branches",
    getEntries: async () => entries,
    getBranch: async () => activeBranch,
    getLeafId: async () => "assistant-failed",
  } as unknown as Session;

  const defaults = {
    thinking: "medium",
    activeTools: ["read"],
    availableTools: ["read", "bash"],
  } as Parameters<typeof projectSession>[1];
  const view = await projectSession(session, defaults);

  assert.equal("tree" in view, false);
  assert.equal("leafId" in view, false);
  assert.deepEqual(view.state, { thinking: "medium" });
  assert.deepEqual(
    view.messages.map((item) => item.id),
    [
      "user-root",
      "assistant-tool",
      "tool-result",
      "assistant-root",
      "user-active",
      "assistant-failed",
    ],
  );
  assert.equal(view.messages.some((item) => item.id === "user-old"), false);
  assert.equal(view.messages.some((item) => item.id === "summary"), false);
  assert.equal(
    view.messages.find((item) => item.id === "assistant-root")?.text,
    "First answer",
  );
});
