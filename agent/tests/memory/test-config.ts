import type { MemoryPipelineConfig } from "../../src/harness/memory/types.js";

type MemoryConfigOverrides = {
  [Section in keyof MemoryPipelineConfig]?: Partial<MemoryPipelineConfig[Section]>;
};

export function testMemoryConfig(
  overrides: MemoryConfigOverrides = {},
): MemoryPipelineConfig {
  return {
    worker: {
      intervalMilliseconds: 60_000,
      maxJobsPerTick: 100,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 1_000,
      retryDelayMilliseconds: 60 * 60_000,
      maxAttempts: 3,
      maxConsecutiveExpiredLeases: 3,
      ...overrides.worker,
    },
    activity: {
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      observationWindowMilliseconds: 60_000,
      observationGraceMilliseconds: 15_000,
      maxObservationsPerRequest: 30,
      turnIdleMilliseconds: 30 * 60_000,
      turnHardCapMilliseconds: 2 * 60 * 60_000,
      ...overrides.activity,
    },
    consolidation: {
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      cooldownMilliseconds: 6 * 60 * 60_000,
      ...overrides.consolidation,
    },
    evidence: {
      successRetentionMilliseconds: 24 * 60 * 60_000,
      failedRetentionMilliseconds: 7 * 24 * 60 * 60_000,
      abandonedGraceMilliseconds: 60 * 60_000,
      ...overrides.evidence,
    },
  };
}
