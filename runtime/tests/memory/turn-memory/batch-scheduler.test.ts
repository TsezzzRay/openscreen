import assert from "node:assert/strict";
import test from "node:test";

import {
  turnMemoryBatchEligibility,
} from "../../../src/memory/turn-memory/batch-scheduler.js";

test("selects the earliest idle, hard-cap, or exact-budget boundary", () => {
  assert.deepEqual(turnMemoryBatchEligibility({
    firstPendingAt: 1_000,
    lastTerminalAt: 2_000,
    projectedInputTokens: 100,
    maxInputTokens: 1_000,
    idleMilliseconds: 3_000,
    hardCapMilliseconds: 10_000,
  }), { eligibleAt: 5_000, reason: "idle" });
  assert.deepEqual(turnMemoryBatchEligibility({
    firstPendingAt: 1_000,
    lastTerminalAt: 9_000,
    projectedInputTokens: 100,
    maxInputTokens: 1_000,
    idleMilliseconds: 3_000,
    hardCapMilliseconds: 10_000,
  }), { eligibleAt: 11_000, reason: "hard_cap" });
  assert.deepEqual(turnMemoryBatchEligibility({
    firstPendingAt: 1_000,
    lastTerminalAt: 2_000,
    projectedInputTokens: 1_000,
    maxInputTokens: 1_000,
    idleMilliseconds: 3_000,
    hardCapMilliseconds: 10_000,
  }), { eligibleAt: 2_000, reason: "budget" });
});
