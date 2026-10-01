import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunEvent, AgentService } from "../../src/agent/api.js";
import type { ApplicationEvent } from "../../src/application/api.js";
import { ApplicationRuntime } from "../../src/application/runtime.js";
import type { CaptureService } from "../../src/capture/api.js";

test("approved tool commit reaches the application before prompt completion", async () => {
  const agent = {
    prompt: async (sessionId: string, _prompt: unknown, onEvent: (event: AgentRunEvent) => Promise<void>) => {
      await onEvent({ type: "approval-committed", id: "approval-1", callId: "call-1", tool: "write", target: "/tmp/result.txt" });
      return { sessionId, answer: "done", contextUsage: { contextTokens: 1, contextWindow: 100 } };
    },
    compactIfNeeded: async () => undefined,
  } as unknown as AgentService;
  const capture = { capture: async () => undefined } as unknown as CaptureService;
  const runtime = new ApplicationRuntime({ agent, capture });
  const events: ApplicationEvent[] = [];
  await runtime.execute({ requestId: "prompt-1", type: "prompt", sessionId: "session-1", input: { text: "Update the file" } }, event => {
    events.push(event);
  });
  assert.deepEqual(events.map(event => event.type), ["approval_committed", "answer_completed", "completed"]);
  assert.deepEqual(events[0], { type: "approval_committed", sessionId: "session-1", id: "approval-1", callId: "call-1", tool: "write", target: "/tmp/result.txt" });
});
