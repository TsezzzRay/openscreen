import type { MemoryScopeHint } from "./activity/types.js";

export type MemoryPipelineConfig = {
  worker: {
    intervalMilliseconds: number;
    maxJobsPerTick: number;
    leaseMilliseconds: number;
    heartbeatMilliseconds: number;
    retryDelayMilliseconds: number;
    maxAttempts: number;
    maxConsecutiveExpiredLeases: number;
  };
  activity: {
    maxInputTokens: number;
    maxOutputTokens: number;
    observationWindowMilliseconds: number;
    observationGraceMilliseconds: number;
    maxObservationsPerRequest: number;
    turnIdleMilliseconds: number;
    turnHardCapMilliseconds: number;
  };
  consolidation: {
    maxInputTokens: number;
    maxOutputTokens: number;
    cooldownMilliseconds: number;
  };
  evidence: {
    successRetentionMilliseconds: number;
    failedRetentionMilliseconds: number;
    abandonedGraceMilliseconds: number;
  };
};

export type LongTermMemory = {
  key: string;
  title: string;
  scope: MemoryScopeHint;
  content: string;
  evidenceSourceIds: [string, ...string[]];
};
