import type { MemoryScopeHint } from "./shared/memory-scope.js";

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
  chronicle: {
    maxInputTokens: number;
    maxOutputTokens: number;
    observationWindowMilliseconds: number;
    observationGraceMilliseconds: number;
    maxSourcesPerRequest: number;
  };
  turnMemory: {
    maxInputTokens: number;
    maxOutputTokens: number;
    turnIdleMilliseconds: number;
    turnHardCapMilliseconds: number;
  };
  consolidation: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxSources: number;
    cooldownMilliseconds: number;
  };
  evidence: {
    successRetentionMilliseconds: number;
    failedRetentionMilliseconds: number;
    screenshotRetentionMilliseconds: number;
    abandonedGraceMilliseconds: number;
    maxBytes: number;
  };
};

export type LongTermMemory = {
  key: string;
  title: string;
  scope: MemoryScopeHint;
  content: string;
  evidenceSourceIds: [string, ...string[]];
};
