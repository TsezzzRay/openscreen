import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryConfig } from "../../src/memory/config.js";

const valid = {
  enabled: true,
  worker: {
    intervalMilliseconds: 5_000,
    maxChronicleWindowsPerTick: 2,
  },
  chronicle: {
    windowMilliseconds: 60_000,
    graceMilliseconds: 15_000,
    maxSourcesPerRequest: 10,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
  },
  observationalMemory: {
    interactive: { messageTokens: 6_000, observationTokens: 8_000 },
    screenActivity: { messageTokens: 2_000, observationTokens: 3_000 },
  },
  retention: {
    chronicleRolloutMaxAgeMilliseconds: 7_776_000_000,
  },
};

test("parses the strict Memory worker, chronicle, observational memory, and retention policy", () => {
  assert.deepEqual(parseMemoryConfig(valid), valid);
});

test("rejects unknown, non-positive, and inconsistent Memory values", () => {
  for (const input of [
    { ...valid, extra: true },
    { ...valid, enabled: "yes" },
    { ...valid, worker: { ...valid.worker, maxChronicleWindowsPerTick: 0 } },
    {
      ...valid,
      chronicle: { ...valid.chronicle, maxOutputTokens: valid.chronicle.maxInputTokens },
    },
    {
      ...valid,
      chronicle: { ...valid.chronicle, maxSourcesPerRequest: 11 },
    },
    {
      ...valid,
      observationalMemory: {
        ...valid.observationalMemory,
        interactive: { messageTokens: 9_000, observationTokens: 8_000 },
      },
    },
    {
      ...valid,
      observationalMemory: {
        ...valid.observationalMemory,
        interactive: { messageTokens: 6_000 },
      },
    },
  ]) {
    assert.throws(() => parseMemoryConfig(input), /Invalid Memory config/);
  }
});
