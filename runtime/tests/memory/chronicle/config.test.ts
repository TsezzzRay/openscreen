import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryConfig } from "../../../src/memory/config.js";

const config = {
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

test("parses a strict Chronicle window and request policy", () => {
  assert.deepEqual(parseMemoryConfig(config), config);
  assert.equal(parseMemoryConfig({
    ...config,
    chronicle: { ...config.chronicle, graceMilliseconds: 0 },
  }).chronicle.graceMilliseconds, 0);
  assert.throws(
    () => parseMemoryConfig({
      ...config,
      chronicle: {
        ...config.chronicle,
        maxOutputTokens: config.chronicle.maxInputTokens,
      },
    }),
    /Invalid Memory config/,
  );
  assert.throws(
    () => parseMemoryConfig({
      ...config,
      chronicle: { ...config.chronicle, maxSourcesPerRequest: 11 },
    }),
    /Invalid Memory config/,
  );
});
