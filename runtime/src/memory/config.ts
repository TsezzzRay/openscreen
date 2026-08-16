export interface MemoryConfig {
  enabled: boolean;
  worker: {
    intervalMilliseconds: number;
    maxJobsPerTick: number;
    leaseMilliseconds: number;
    retryDelayMilliseconds: number;
    maxAttempts: number;
  };
  turnMemory: {
    maxInputTokens: number;
    maxOutputTokens: number;
    idleMilliseconds: number;
    hardCapMilliseconds: number;
  };
  chronicle: {
    windowMilliseconds: number;
    graceMilliseconds: number;
    maxSourcesPerRequest: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  consolidation: {
    maxChangedSourcesPerRun: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    summaryMaxTokens: number;
    cooldownMilliseconds: number;
  };
  retention: {
    chronicleUnreferencedMilliseconds: number;
  };
}

function invalid(): never {
  throw new Error("Invalid Memory config");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalid();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid();
  }
  return value;
}

export function parseMemoryConfig(value: unknown): MemoryConfig {
  const root = record(value);
  exact(root, [
    "enabled",
    "worker",
    "turnMemory",
    "chronicle",
    "consolidation",
    "retention",
  ]);
  if (typeof root.enabled !== "boolean") invalid();
  const worker = record(root.worker);
  exact(worker, [
    "intervalMilliseconds",
    "maxJobsPerTick",
    "leaseMilliseconds",
    "retryDelayMilliseconds",
    "maxAttempts",
  ]);
  const turnMemory = record(root.turnMemory);
  exact(turnMemory, [
    "maxInputTokens",
    "maxOutputTokens",
    "idleMilliseconds",
    "hardCapMilliseconds",
  ]);
  const chronicle = record(root.chronicle);
  exact(chronicle, [
    "windowMilliseconds",
    "graceMilliseconds",
    "maxSourcesPerRequest",
    "maxInputTokens",
    "maxOutputTokens",
  ]);
  const consolidation = record(root.consolidation);
  exact(consolidation, [
    "maxChangedSourcesPerRun",
    "maxInputTokens",
    "maxOutputTokens",
    "summaryMaxTokens",
    "cooldownMilliseconds",
  ]);
  const retention = record(root.retention);
  exact(retention, ["chronicleUnreferencedMilliseconds"]);
  const result: MemoryConfig = {
    enabled: root.enabled,
    worker: {
      intervalMilliseconds: positiveInteger(worker.intervalMilliseconds),
      maxJobsPerTick: positiveInteger(worker.maxJobsPerTick),
      leaseMilliseconds: positiveInteger(worker.leaseMilliseconds),
      retryDelayMilliseconds: positiveInteger(worker.retryDelayMilliseconds),
      maxAttempts: positiveInteger(worker.maxAttempts),
    },
    turnMemory: {
      maxInputTokens: positiveInteger(turnMemory.maxInputTokens),
      maxOutputTokens: positiveInteger(turnMemory.maxOutputTokens),
      idleMilliseconds: positiveInteger(turnMemory.idleMilliseconds),
      hardCapMilliseconds: positiveInteger(turnMemory.hardCapMilliseconds),
    },
    chronicle: {
      windowMilliseconds: positiveInteger(chronicle.windowMilliseconds),
      graceMilliseconds: nonNegativeInteger(chronicle.graceMilliseconds),
      maxSourcesPerRequest: positiveInteger(chronicle.maxSourcesPerRequest),
      maxInputTokens: positiveInteger(chronicle.maxInputTokens),
      maxOutputTokens: positiveInteger(chronicle.maxOutputTokens),
    },
    consolidation: {
      maxChangedSourcesPerRun: positiveInteger(
        consolidation.maxChangedSourcesPerRun,
      ),
      maxInputTokens: positiveInteger(consolidation.maxInputTokens),
      maxOutputTokens: positiveInteger(consolidation.maxOutputTokens),
      summaryMaxTokens: positiveInteger(consolidation.summaryMaxTokens),
      cooldownMilliseconds: positiveInteger(consolidation.cooldownMilliseconds),
    },
    retention: {
      chronicleUnreferencedMilliseconds: positiveInteger(
        retention.chronicleUnreferencedMilliseconds,
      ),
    },
  };
  if (
    result.turnMemory.maxOutputTokens >= result.turnMemory.maxInputTokens ||
    result.turnMemory.hardCapMilliseconds <= result.turnMemory.idleMilliseconds ||
    result.chronicle.maxSourcesPerRequest > 10 ||
    result.chronicle.maxOutputTokens >= result.chronicle.maxInputTokens ||
    result.consolidation.maxOutputTokens >= result.consolidation.maxInputTokens ||
    result.consolidation.summaryMaxTokens > result.consolidation.maxOutputTokens
  ) {
    invalid();
  }
  return result;
}
