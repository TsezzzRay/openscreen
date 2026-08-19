import assert from "node:assert/strict";
import test from "node:test";

import { parseMemoryConfig } from "../../../src/memory/config.js";

const config = {
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
