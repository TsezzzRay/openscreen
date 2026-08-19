export interface MemoryConfig {
  enabled: boolean;
  worker: {
    intervalMilliseconds: number;
    maxChronicleWindowsPerTick: number;
  };
  chronicle: {
    windowMilliseconds: number;
    graceMilliseconds: number;
    maxSourcesPerRequest: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  observationalMemory: {
    interactive: { messageTokens: number; observationTokens: number };
    screenActivity: { messageTokens: number; observationTokens: number };
  };
  retention: {
    chronicleRolloutMaxAgeMilliseconds: number;
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

function observationalMemoryPolicy(value: unknown): {
  messageTokens: number;
  observationTokens: number;
} {
  const policy = record(value);
  exact(policy, ["messageTokens", "observationTokens"]);
  const result = {
    messageTokens: positiveInteger(policy.messageTokens),
    observationTokens: positiveInteger(policy.observationTokens),
  };
  if (result.messageTokens > result.observationTokens) invalid();
  return result;
}

export function parseMemoryConfig(value: unknown): MemoryConfig {
  const root = record(value);
  exact(root, ["enabled", "worker", "chronicle", "observationalMemory", "retention"]);
  if (typeof root.enabled !== "boolean") invalid();
  const worker = record(root.worker);
  exact(worker, ["intervalMilliseconds", "maxChronicleWindowsPerTick"]);
  const chronicle = record(root.chronicle);
  exact(chronicle, [
    "windowMilliseconds",
    "graceMilliseconds",
    "maxSourcesPerRequest",
    "maxInputTokens",
    "maxOutputTokens",
  ]);
  const observationalMemory = record(root.observationalMemory);
  exact(observationalMemory, ["interactive", "screenActivity"]);
  const retention = record(root.retention);
  exact(retention, ["chronicleRolloutMaxAgeMilliseconds"]);
  const result: MemoryConfig = {
    enabled: root.enabled,
    worker: {
      intervalMilliseconds: positiveInteger(worker.intervalMilliseconds),
      maxChronicleWindowsPerTick: positiveInteger(worker.maxChronicleWindowsPerTick),
    },
    chronicle: {
      windowMilliseconds: positiveInteger(chronicle.windowMilliseconds),
      graceMilliseconds: nonNegativeInteger(chronicle.graceMilliseconds),
      maxSourcesPerRequest: positiveInteger(chronicle.maxSourcesPerRequest),
      maxInputTokens: positiveInteger(chronicle.maxInputTokens),
      maxOutputTokens: positiveInteger(chronicle.maxOutputTokens),
    },
    observationalMemory: {
      interactive: observationalMemoryPolicy(observationalMemory.interactive),
      screenActivity: observationalMemoryPolicy(observationalMemory.screenActivity),
    },
    retention: {
      chronicleRolloutMaxAgeMilliseconds: positiveInteger(
        retention.chronicleRolloutMaxAgeMilliseconds,
      ),
    },
  };
  if (
    result.chronicle.maxSourcesPerRequest > 10 ||
    result.chronicle.maxOutputTokens >= result.chronicle.maxInputTokens
  ) {
    invalid();
  }
  return result;
}
