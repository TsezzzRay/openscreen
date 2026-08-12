import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    chronicle: {
      maxInputTokens: 244_800,
      maxOutputTokens: 4_096,
      observationWindowMilliseconds: 60_000,
      observationGraceMilliseconds: 15_000,
      maxSourcesPerRequest: 10,
    },
    turnMemory: {
      maxInputTokens: 244_800,
      maxOutputTokens: 4_096,
      turnIdleMilliseconds: 30 * 60_000,
      turnHardCapMilliseconds: 2 * 60 * 60_000,
    },
    consolidation: {
      maxInputTokens: 244_800,
      maxOutputTokens: 4_096,
      maxSources: 512,
      cooldownMilliseconds: 6 * 60 * 60_000,
    },
    evidence: {
      successRetentionMilliseconds: 24 * 60 * 60_000,
      failedRetentionMilliseconds: 7 * 24 * 60 * 60_000,
      screenshotRetentionMilliseconds: 24 * 60 * 60_000,
      abandonedGraceMilliseconds: 60 * 60_000,
      maxBytes: 2 * 1024 * 1024 * 1024,
    },
  },
  screenObservation: {
    enabled: true,
    scheduling: {
      tickIntervalMilliseconds: 100,
      ordinaryCaptureGapMilliseconds: 2_000,
      eventDeduplicationWindowMilliseconds: 1_000,
      sameWindowCaptureGapMilliseconds: 5_000,
      visualOnlyCaptureGapMilliseconds: 15_000,
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
    capture: {
      requestTimeoutMilliseconds: 10_000,
      reuseWindowMilliseconds: 250,
    },
    diagnostics: {
      retentionMilliseconds: 7 * 24 * 60 * 60_000,
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
      changeThreshold: 0.05,
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

test("ships OpenChronicle capture timing defaults", () => {
  const config = loadRuntimeConfig(resolve("config.json"), {
    OPENAI_API_KEY: "secret",
    OPENAI_MODEL: "test-model",
    OPENAI_BASE_URL: "https://provider.example/v1",
  });

  assert.equal(config.screenObservation.scheduling.eventDeduplicationWindowMilliseconds, 1_000);
  assert.equal(config.screenObservation.scheduling.ordinaryCaptureGapMilliseconds, 2_000);
  assert.equal(config.screenObservation.scheduling.sameWindowCaptureGapMilliseconds, 5_000);
  assert.equal(
    config.screenObservation.scheduling.visualOnlyCaptureGapMilliseconds,
    15_000,
  );
  assert.equal(config.screenObservation.scheduling.delaysMilliseconds.mouseClick, 0);
  assert.equal(config.screenObservation.scheduling.delaysMilliseconds.keyActivity, 0);
  assert.equal(config.screenObservation.scheduling.delaysMilliseconds.accessibilityChanged, 3_000);
  assert.equal(config.screenObservation.capture.reuseWindowMilliseconds, 2_000);
  assert.equal(config.screenObservation.visualMonitoring.changeThreshold, 0.05);
  assert.equal(
    config.screenObservation.diagnostics.retentionMilliseconds,
    7 * 24 * 60 * 60_000,
  );
});

test("loads a single visual threshold shared by monitoring and observation", (t) => {
  const singleThresholdConfig = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      visualMonitoring: {
        ...fileConfig.screenObservation.visualMonitoring,
        changeThreshold: 0.05,
      },
    },
  });

  const config = loadRuntimeConfig(singleThresholdConfig.path, {
    OPENAI_API_KEY: "secret",
  });

  assert.equal(config.screenObservation.visualMonitoring.changeThreshold, 0.05);
  assert.equal(
    "captureThreshold" in config.screenObservation.visualMonitoring,
    false,
  );
});

test("uses Ark Kimi through the generic OpenAI-compatible configuration", () => {
  const config = loadRuntimeConfig(resolve("config.json"), {
    OPENAI_API_KEY: "secret",
  });

  assert.equal(config.model, "kimi-k2.7-code");
  assert.equal(config.baseURL, "https://ark.cn-beijing.volces.com/api/plan/v3");
  assert.equal(config.context.windowTokens, 272_000);
});

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
    OPENSCREEN_CHRONICLE_MAX_INPUT_TOKENS: "90000",
    OPENSCREEN_CHRONICLE_MAX_OUTPUT_TOKENS: "2000",
    OPENSCREEN_TURN_MEMORY_MAX_INPUT_TOKENS: "85000",
    OPENSCREEN_TURN_MEMORY_MAX_OUTPUT_TOKENS: "1800",
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
      chronicle: {
        ...fileConfig.memory.chronicle,
        maxInputTokens: 90_000,
        maxOutputTokens: 2_000,
      },
      turnMemory: {
        ...fileConfig.memory.turnMemory,
        maxInputTokens: 85_000,
        maxOutputTokens: 1_800,
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
  const invalidChronicleBudget = withConfig(t, {
    ...fileConfig,
    memory: {
      ...fileConfig.memory,
      chronicle: {
        ...fileConfig.memory.chronicle,
        maxInputTokens: 270_000,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidChronicleBudget.path, { OPENAI_API_KEY: "secret" }),
    /memory.chronicle token budget exceeds context.windowTokens/,
  );
});

test("does not accept the removed generic Activity configuration", (t) => {
  const { path } = withConfig(t, {
    ...fileConfig,
    memory: {
      ...fileConfig.memory,
      chronicle: undefined,
      activity: fileConfig.memory.chronicle,
    },
  });

  assert.throws(
    () => loadRuntimeConfig(path, { OPENAI_API_KEY: "secret" }),
    /memory.chronicle must be an object/,
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

  const invalidReuseWindow = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      capture: {
        ...fileConfig.screenObservation.capture,
        reuseWindowMilliseconds: -1,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidReuseWindow.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.capture.reuseWindowMilliseconds must be a non-negative integer/,
  );

  const invalidDiagnosticsRetention = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      diagnostics: {
        retentionMilliseconds: 0,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidDiagnosticsRetention.path, { OPENAI_API_KEY: "secret" }),
    /screenObservation.diagnostics.retentionMilliseconds must be a positive integer/,
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

  const invalidVisualCaptureGap = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      scheduling: {
        ...fileConfig.screenObservation.scheduling,
        visualOnlyCaptureGapMilliseconds: 0,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidVisualCaptureGap.path, {
      OPENAI_API_KEY: "secret",
    }),
    /screenObservation.scheduling.visualOnlyCaptureGapMilliseconds must be a positive integer/,
  );

  const invalidVisualChangeThreshold = withConfig(t, {
    ...fileConfig,
    screenObservation: {
      ...fileConfig.screenObservation,
      visualMonitoring: {
        ...fileConfig.screenObservation.visualMonitoring,
        changeThreshold: 1.1,
      },
    },
  });
  assert.throws(
    () => loadRuntimeConfig(invalidVisualChangeThreshold.path, {
      OPENAI_API_KEY: "secret",
    }),
    /screenObservation.visualMonitoring.changeThreshold must be between 0 and 1/,
  );
});
