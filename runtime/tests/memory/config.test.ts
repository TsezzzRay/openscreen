import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryConfig } from "../../src/memory/config.js";

const valid = {
  enabled: true,
  worker: {
    intervalMilliseconds: 5_000,
    maxJobsPerTick: 2,
    leaseMilliseconds: 60_000,
    retryDelayMilliseconds: 30_000,
    maxAttempts: 3,
  },
  turnMemory: {
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    idleMilliseconds: 1_800_000,
    hardCapMilliseconds: 7_200_000,
  },
  chronicle: {
    windowMilliseconds: 60_000,
    graceMilliseconds: 15_000,
    maxSourcesPerRequest: 10,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
  },
  consolidation: {
    maxChangedSourcesPerRun: 128,
    maxInputTokens: 64_000,
    maxOutputTokens: 8_000,
    summaryMaxTokens: 2_500,
    cooldownMilliseconds: 21_600_000,
  },
  retention: {
    chronicleUnreferencedMilliseconds: 7_776_000_000,
  },
};

test("parses only the strict Memory worker, Turn, consolidation, and retention policy", () => {
  assert.deepEqual(parseMemoryConfig(valid), valid);
});

test("rejects unknown, non-positive, and inconsistent Memory values", () => {
  for (const input of [
    { ...valid, extra: true },
    { ...valid, enabled: "yes" },
    { ...valid, worker: { ...valid.worker, maxAttempts: 0 } },
    {
      ...valid,
      turnMemory: {
        ...valid.turnMemory,
        maxOutputTokens: valid.turnMemory.maxInputTokens,
      },
    },
    {
      ...valid,
      turnMemory: {
        ...valid.turnMemory,
        hardCapMilliseconds: valid.turnMemory.idleMilliseconds,
      },
    },
    {
      ...valid,
      consolidation: {
        ...valid.consolidation,
        maxOutputTokens: valid.consolidation.maxInputTokens,
      },
    },
    {
      ...valid,
      consolidation: {
        ...valid.consolidation,
        summaryMaxTokens: valid.consolidation.maxOutputTokens + 1,
      },
    },
  ]) {
    assert.throws(() => parseMemoryConfig(input), /Invalid Memory config/);
  }
});
