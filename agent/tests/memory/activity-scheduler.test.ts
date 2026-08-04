import assert from "node:assert/strict";
import test from "node:test";

import {
  observationWindowFor,
  turnBatchEligibility,
} from "../../src/harness/memory/activity/scheduler.js";

test("aligns observations to closed one-minute windows with a fifteen-second grace", () => {
  const window = observationWindowFor(
    Date.parse("2026-08-04T10:01:42.123Z"),
    {
      windowMilliseconds: 60_000,
      graceMilliseconds: 15_000,
    },
  );

  assert.deepEqual(window, {
    id: "observation-window:2026-08-04T10:01:00.000Z",
    startAt: Date.parse("2026-08-04T10:01:00.000Z"),
    endAt: Date.parse("2026-08-04T10:02:00.000Z"),
    eligibleAt: Date.parse("2026-08-04T10:02:15.000Z"),
  });
});

test("delays a turn batch until idle but caps a continuous conversation at two hours", () => {
  const firstPendingAt = Date.parse("2026-08-04T10:00:00.000Z");
  const lastTerminalAt = Date.parse("2026-08-04T11:45:00.000Z");
  const eligibility = turnBatchEligibility({
    firstPendingAt,
    lastTerminalAt,
    projectedInputTokens: 1_000,
    maxInputTokens: 7_000,
    idleMilliseconds: 30 * 60_000,
    hardCapMilliseconds: 2 * 60 * 60_000,
  });

  assert.deepEqual(eligibility, {
    eligibleAt: Date.parse("2026-08-04T12:00:00.000Z"),
    reason: "hard_cap",
  });
});

test("seals a turn batch immediately at the input budget", () => {
  const lastTerminalAt = Date.parse("2026-08-04T10:05:00.000Z");
  assert.deepEqual(turnBatchEligibility({
    firstPendingAt: Date.parse("2026-08-04T10:00:00.000Z"),
    lastTerminalAt,
    projectedInputTokens: 7_000,
    maxInputTokens: 7_000,
    idleMilliseconds: 30 * 60_000,
    hardCapMilliseconds: 2 * 60 * 60_000,
  }), {
    eligibleAt: lastTerminalAt,
    reason: "budget",
  });
});
