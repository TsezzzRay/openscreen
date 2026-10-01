import assert from "node:assert/strict";
import test from "node:test";

import type { AgentService } from "../../src/agent/api.js";
import { ApplicationRuntime } from "../../src/application/runtime.js";
import type { CaptureService } from "../../src/capture/api.js";
import { ApprovalCoordinator } from "../../src/security/approval-coordinator.js";
import { parseJsonlCommand } from "../../src/transport/jsonl-codec.js";

test("approval decision command is strict, session-bound, and one-use", async () => {
  const approvals = new ApprovalCoordinator();
  const pending = approvals.request({ sessionId: "session-a", callId: "call-a", tool: "bash", target: "pwd" });
  const runtime = new ApplicationRuntime({ agent: {} as AgentService, capture: {} as CaptureService, approvals });
  const events: string[] = [];
  const raw = JSON.stringify({ requestId: "decision-1", type: "decide_approval", sessionId: "session-a", approvalId: pending.id, approved: true });
  assert.deepEqual(parseJsonlCommand(raw), JSON.parse(raw));
  await runtime.execute(parseJsonlCommand(raw), event => { events.push(event.type); });
  assert.equal(await pending.result, true);
  assert.deepEqual(events, ["completed"]);
  const duplicate: string[] = [];
  await runtime.execute(parseJsonlCommand(raw.replace("decision-1", "decision-2")), event => { duplicate.push(event.type); });
  assert.deepEqual(duplicate, ["failed"]);
  assert.throws(() => parseJsonlCommand(raw.replace('"approved":true', '"approved":"yes"')));
  approvals.close();
});
