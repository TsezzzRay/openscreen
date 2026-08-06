export function turnMemoryBatchEligibility({
  firstPendingAt,
  lastTerminalAt,
  projectedInputTokens,
  maxInputTokens,
  idleMilliseconds,
  hardCapMilliseconds,
}: {
  firstPendingAt: number;
  lastTerminalAt: number;
  projectedInputTokens: number;
  maxInputTokens: number;
  idleMilliseconds: number;
  hardCapMilliseconds: number;
}): { eligibleAt: number; reason: "idle" | "hard_cap" | "budget" } {
  if (firstPendingAt > lastTerminalAt) {
    throw new Error("Turn Memory batch begins after its last terminal Turn");
  }
  if (!Number.isSafeInteger(projectedInputTokens) || projectedInputTokens < 0 ||
      !Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
    throw new Error("Invalid Turn Memory batch token budget");
  }
  if (projectedInputTokens >= maxInputTokens) {
    return { eligibleAt: lastTerminalAt, reason: "budget" };
  }
  const idleAt = lastTerminalAt + idleMilliseconds;
  const hardCapAt = firstPendingAt + hardCapMilliseconds;
  return idleAt <= hardCapAt
    ? { eligibleAt: idleAt, reason: "idle" }
    : { eligibleAt: hardCapAt, reason: "hard_cap" };
}
