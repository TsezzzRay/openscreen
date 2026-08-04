function timestamp(value: string | number) {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid source timestamp");
  return milliseconds;
}

export function observationWindowFor(
  occurredAt: string | number,
  {
    windowMilliseconds,
    graceMilliseconds,
  }: {
    windowMilliseconds: number;
    graceMilliseconds: number;
  },
) {
  const occurredAtMilliseconds = timestamp(occurredAt);
  const startAt = Math.floor(
    occurredAtMilliseconds / windowMilliseconds,
  ) * windowMilliseconds;
  const endAt = startAt + windowMilliseconds;
  return {
    id: `observation-window:${new Date(startAt).toISOString()}`,
    startAt,
    endAt,
    eligibleAt: endAt + graceMilliseconds,
  };
}

export function turnBatchEligibility({
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
    throw new Error("Turn batch begins after its last terminal Turn");
  }
  if (projectedInputTokens < 0 || maxInputTokens <= 0) {
    throw new Error("Invalid Turn batch token budget");
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
