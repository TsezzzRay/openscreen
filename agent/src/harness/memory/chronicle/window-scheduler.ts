export function chronicleWindowFor(
  occurredAt: number,
  {
    windowMilliseconds,
    graceMilliseconds,
  }: {
    windowMilliseconds: number;
    graceMilliseconds: number;
  },
) {
  if (!Number.isSafeInteger(occurredAt) ||
      !Number.isSafeInteger(windowMilliseconds) || windowMilliseconds <= 0 ||
      !Number.isSafeInteger(graceMilliseconds) || graceMilliseconds < 0) {
    throw new Error("Invalid Chronicle window settings");
  }
  const startAt = Math.floor(occurredAt / windowMilliseconds) * windowMilliseconds;
  const endAt = startAt + windowMilliseconds;
  return {
    id: `chronicle-window:${new Date(startAt).toISOString()}`,
    startAt,
    endAt,
    eligibleAt: endAt + graceMilliseconds,
  };
}
