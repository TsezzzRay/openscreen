import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";

const fileConfig = {
  model: "vision-model",
  baseURL: "https://provider.example/v1",
  context: {
    windowTokens: 272_000,
    compactAtTokens: 244_800,
    keepRecentTokens: 20_000,
    maxOutputTokens: 21_760,
    summaryMaxOutputTokens: 4_096,
    minimumRecentTurns: 2,
  },
  session: {
    eventFlushBytes: 4_096,
    eventFlushMilliseconds: 250,
  },
  memory: {
    worker: {
      intervalMilliseconds: 60_000,
      maxJobsPerTick: 100,
      leaseMilliseconds: 60 * 60_000,
      heartbeatMilliseconds: 90_000,
      retryDelayMilliseconds: 60 * 60_000,
      maxAttempts: 3,
      maxConsecutiveExpiredLeases: 3,
    },
    activity: {
      maxInputTokens: 244_800,
      maxOutputTokens: 4_096,
      observationWindowMilliseconds: 60_000,
      observationGraceMilliseconds: 15_000,
      maxObservationsPerRequest: 30,
      turnIdleMilliseconds: 30 * 60_000,
      turnHardCapMilliseconds: 2 * 60 * 60_000,
    },
    consolidation: {
      maxInputTokens: 244_800,
      maxOutputTokens: 4_096,
      cooldownMilliseconds: 6 * 60 * 60_000,
    },
    evidence: {
      successRetentionMilliseconds: 24 * 60 * 60_000,
      failedRetentionMilliseconds: 7 * 24 * 60 * 60_000,
      abandonedGraceMilliseconds: 60 * 60_000,
    },
  },
  screenObservation: {
    enabled: true,
    scheduling: {
      tickIntervalMilliseconds: 100,
      ordinaryCaptureGapMilliseconds: 2_000,
      delaysMilliseconds: {
        mouseClick: 400,
        focusedElementChanged: 500,
        keyActivity: 1_500,
        accessibilityChanged: 3_000,
        visualChanged: 750,
      },
      capsMilliseconds: {
        keyActivity: 30_000,
        visualChanged: 10_000,
      },
    },
    deduplication: {
      visualDifferenceThreshold: 0.08,
    },
    capture: {
      requestTimeoutMilliseconds: 10_000,
    },
    helperLifecycle: {
      configurationTimeoutMilliseconds: 2_000,
      shutdownTimeoutMilliseconds: 500,
    },
    activityMonitoring: {
      coalescingIntervalMilliseconds: 250,
    },
    accessibility: {
      maxDepth: 40,
      maxNodes: 5_000,
      timeoutMilliseconds: 2_000,
      maxTextLength: 8_192,
    },
    screenshot: {
      maxWidth: 1_920,
      jpegQuality: 0.85,
    },
    visualMonitoring: {
      maxWidth: 320,
      sampleIntervalMilliseconds: 500,
      queueDepth: 2,
      changeThreshold: 0.015,
      signatureWidth: 32,
      signatureHeight: 18,
    },
    windowSelection: {
      minimumWidth: 160,
      minimumHeight: 120,
      maximumAspectRatio: 4,
    },
  },
};

function withConfig(
  t: test.TestContext,
  config: unknown = fileConfig,
) {
  const directory = mkdtempSync(join(tmpdir(), "openscreen-config-test-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { directory, path };
}

test("loads JSON runtime defaults and the API key from the environment", (t) => {
  const { path } = withConfig(t);

  assert.deepEqual(loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }), {
    apiKey: "secret",
    ...fileConfig,
  });
});

test("overrides every JSON setting from environment variables", (t) => {
  const { path } = withConfig(t);

  assert.deepEqual(loadRuntimeConfig(path, {
    OPENAI_API_KEY: "secret",
    OPENAI_MODEL: "override-model",
    OPENAI_BASE_URL: "https://override.example/v1",
    OPENSCREEN_CONTEXT_WINDOW_TOKENS: "128000",
    OPENSCREEN_COMPACT_AT_TOKENS: "100000",
    OPENSCREEN_KEEP_RECENT_TOKENS: "12000",
    OPENSCREEN_MAX_OUTPUT_TOKENS: "20000",
    OPENSCREEN_SUMMARY_MAX_OUTPUT_TOKENS: "3000",
    OPENSCREEN_MIN_RECENT_TURNS: "3",
    OPENSCREEN_SESSION_EVENT_FLUSH_BYTES: "8192",
    OPENSCREEN_SESSION_EVENT_FLUSH_MS: "100",
    OPENSCREEN_ACTIVITY_MAX_INPUT_TOKENS: "90000",
    OPENSCREEN_ACTIVITY_MAX_OUTPUT_TOKENS: "2000",
    OPENSCREEN_CONSOLIDATION_MAX_INPUT_TOKENS: "80000",
    OPENSCREEN_CONSOLIDATION_MAX_OUTPUT_TOKENS: "1500",
  }), {
    apiKey: "secret",
    model: "override-model",
    baseURL: "https://override.example/v1",
    context: {
      windowTokens: 128_000,
      compactAtTokens: 100_000,
      keepRecentTokens: 12_000,
      maxOutputTokens: 20_000,
      summaryMaxOutputTokens: 3_000,
      minimumRecentTurns: 3,
    },
    session: {
      eventFlushBytes: 8_192,
      eventFlushMilliseconds: 100,
    },
    memory: {
      ...fileConfig.memory,
      activity: {
        ...fileConfig.memory.activity,
        maxInputTokens: 90_000,
        maxOutputTokens: 2_000,
      },
      consolidation: {
        ...fileConfig.memory.consolidation,
        maxInputTokens: 80_000,
        maxOutputTokens: 1_500,
      },
    },
    screenObservation: fileConfig.screenObservation,
  });
});

test("loads .env without replacing existing process variables", (t) => {
  const { directory } = withConfig(t);
  writeFileSync(join(directory, ".env"), [
    "OPENAI_API_KEY=from-file",
    "OPENAI_MODEL=from-file",
  ].join("\n"));
  const previousDirectory = process.cwd();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  t.after(() => {
    process.chdir(previousDirectory);
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  });
  process.chdir(directory);
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_MODEL = "from-process";

  const config = loadRuntimeConfig();

  assert.equal(config.apiKey, "from-file");
  assert.equal(config.model, "from-process");
});

test("rejects a missing API key", (t) => {
  const { path } = withConfig(t);

  assert.throws(() => loadRuntimeConfig(path, {}), /OPENAI_API_KEY is required/);
});

test("rejects provider placeholders and invalid URLs", (t) => {
  const placeholder = withConfig(t, {
    ...fileConfig,
    model: "<model-name>",
    baseURL: "<https://provider.example/v1>",
  });
  assert.throws(
    () => loadRuntimeConfig(placeholder.path, { OPENAI_API_KEY: "secret" }),
    /model must be configured/,
  );

  const invalidURL = withConfig(t, { ...fileConfig, baseURL: "ftp://provider.example" });
  assert.throws(
    () => loadRuntimeConfig(invalidURL.path, { OPENAI_API_KEY: "secret" }),
    /baseURL must be an HTTP or HTTPS URL/,
  );
});

test("rejects invalid numeric overrides", (t) => {
  const { path } = withConfig(t);

  assert.throws(
    () => loadRuntimeConfig(path, {
      OPENAI_API_KEY: "secret",
      OPENSCREEN_CONTEXT_WINDOW_TOKENS: "many",
    }),
    /context.windowTokens must be a positive integer/,
  );
});

test("rejects inconsistent context limits", (t) => {
  const { path } = withConfig(t, {
    ...fileConfig,
    context: { ...fileConfig.context, compactAtTokens: 280_000 },
  });

  assert.throws(
    () => loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }),
    /compactAtTokens must be less than windowTokens/,
  );
});

test("rejects invalid harness limits", (t) => {
  const invalidActivityBudget = withConfig(t, {
    ...fileConfig,
    memory: {
      ...fileConfig.memory,
      activity: {
        ...fileConfig.memory.activity,
        maxInputTokens: 270_000,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidActivityBudget.path, { OPENAI_API_KEY: "secret" }),
    /memory.activity token budget exceeds context.windowTokens/,
  );
});

test("does not accept the removed top-level Activity configuration", (t) => {
  const { activity: removedActivity, ...memoryWithoutActivity } = fileConfig.memory;
  const { path } = withConfig(t, {
    ...fileConfig,
    activity: removedActivity,
    memory: memoryWithoutActivity,
  });

  assert.throws(
    () => loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }),
    /memory.activity must be an object/,
  );
});

test("rejects invalid Memory pipeline settings", (t) => {
  const { path } = withConfig(t, {
    ...fileConfig,
    memory: {
      ...fileConfig.memory,
      worker: {
        ...fileConfig.memory.worker,
        heartbeatMilliseconds: fileConfig.memory.worker.leaseMilliseconds,
      },
    },
  });

  assert.throws(
    () => loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }),
    /memory.worker.heartbeatMilliseconds must be less than leaseMilliseconds/,
  );
});

test("rejects invalid screen observation settings", (t) => {
  const invalidQuality = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      screenshot: {
        ...fileConfig.screenObservation.screenshot,
        jpegQuality: 2,
      },
    },
  });

  assert.throws(
    () => loadRuntimeConfig(invalidQuality.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.screenshot.jpegQuality must be between 0 and 1/,
  );

  const missingObservation = withConfig(t, {
    ...fileConfig,
    screenObservation: undefined,
  });
  assert.throws(
    () => loadRuntimeConfig(missingObservation.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation must be an object/,
  );

  const coercedIntegers = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      accessibility: {
        ...fileConfig.screenObservation.accessibility,
        maxDepth: null,
        maxNodes: true,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(coercedIntegers.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.accessibility.maxDepth must be a non-negative integer/,
  );

  const excessiveNativeBuffers = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      visualMonitoring: {
        ...fileConfig.screenObservation.visualMonitoring,
        queueDepth: 9,
        signatureWidth: 257,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(excessiveNativeBuffers.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.visualMonitoring.queueDepth must be between 1 and 8/,
  );

  const invalidCaptureTimeout = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      capture: {
        requestTimeoutMilliseconds: 0,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidCaptureTimeout.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.capture.requestTimeoutMilliseconds must be a positive integer/,
  );

  const invalidCoalescingInterval = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      activityMonitoring: {
        coalescingIntervalMilliseconds: 0,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidCoalescingInterval.path, {
      OPENAI_API_KEY: "secret",
    }),
    /screenObservation.activityMonitoring.coalescingIntervalMilliseconds must be a positive integer/,
  );
});

test("requires visual monitoring to be at least as sensitive as deduplication", (t) => {
  const { path } = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      visualMonitoring: {
        ...fileConfig.screenObservation.visualMonitoring,
        changeThreshold: 0.1,
      },
    },
  });

  assert.throws(
    () => loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }),
    /changeThreshold must not exceed .*visualDifferenceThreshold/,
  );
});
