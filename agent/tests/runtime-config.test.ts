import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as runtimeConfig from "../src/runtime-config.js";

const { loadApplicationConfig } = runtimeConfig;

const captureFixture = {
  enabled: true,
  scheduling: {
    tickIntervalMilliseconds: 100,
    ordinaryCaptureGapMilliseconds: 2_000,
    eventDeduplicationWindowMilliseconds: 1_000,
    sameWindowCaptureGapMilliseconds: 5_000,
    visualOnlyCaptureGapMilliseconds: 15_000,
    delaysMilliseconds: {
      mouseClick: 0,
      focusedElementChanged: 500,
      keyActivity: 0,
      accessibilityChanged: 3_000,
      visualChanged: 750,
    },
    capsMilliseconds: { keyActivity: 30_000, visualChanged: 10_000 },
  },
  requests: {
    requestTimeoutMilliseconds: 10_000,
    reuseWindowMilliseconds: 2_000,
  },
  diagnostics: { retentionMilliseconds: 604_800_000 },
  helperLifecycle: {
    configurationTimeoutMilliseconds: 2_000,
    shutdownTimeoutMilliseconds: 500,
  },
  activityMonitoring: { coalescingIntervalMilliseconds: 250 },
  accessibility: {
    maxDepth: 40,
    maxNodes: 5_000,
    timeoutMilliseconds: 2_000,
    maxTextLength: 8_192,
  },
  screenshot: { maxWidth: 1_920, jpegQuality: 0.85 },
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
};

function repositoryConfigPath(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(current, "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate config.json");
    current = parent;
  }
}

function writeConfig(t: test.TestContext, value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "openscreen-app-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function cleanConfig() {
  return {
    agent: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
    },
    capture: captureFixture,
  };
}

test("checked-in configuration is the clean pi and Capture configuration", () => {
  const config = JSON.parse(readFileSync(repositoryConfigPath(), "utf8")) as Record<string, unknown>;
  const loaded = loadApplicationConfig(repositoryConfigPath());

  assert.deepEqual(Object.keys(config).sort(), ["agent", "capture"]);
  assert.deepEqual(loaded.agent, {
    provider: "minimax-cn",
    model: "MiniMax-M3",
    thinking: "medium",
  });
  assert.deepEqual(loaded.capture, captureFixture);
});

test("checked-in environment example uses the pi MiniMax credential name", () => {
  const examplePath = join(dirname(repositoryConfigPath()), ".env.example");

  assert.equal(
    readFileSync(examplePath, "utf8"),
    "MINIMAX_CN_API_KEY=your-api-key\n",
  );
});

test("loads only clean pi selection and Capture configuration", (t) => {
  const path = writeConfig(t, cleanConfig());

  const config = loadApplicationConfig(path);

  assert.equal(config.agent.provider, "anthropic");
  assert.equal(config.agent.model, "claude-sonnet-4-5");
  assert.equal(config.agent.thinking, "medium");
  assert.equal(config.capture.screenshot.jpegQuality, 0.85);
  assert.equal("apiKey" in config, false);
  assert.equal("baseURL" in config, false);
  assert.equal("memory" in config, false);
  assert.equal("session" in config, false);
  assert.equal("context" in config, false);
});

test("rejects legacy, secret-bearing, and malformed clean configuration", (t) => {
  const cases = [
    { ...cleanConfig(), apiKey: "secret" },
    { ...cleanConfig(), baseURL: "https://example.test" },
    { ...cleanConfig(), memory: {} },
    { ...cleanConfig(), context: {} },
    {
      ...cleanConfig(),
      agent: { ...cleanConfig().agent, thinking: "ultra" },
    },
    {
      ...cleanConfig(),
      capture: {
        ...captureFixture,
        screenshot: { maxWidth: 1920, jpegQuality: 2 },
      },
    },
    {
      ...cleanConfig(),
      capture: {
        ...captureFixture,
        capture: {
          requestTimeoutMilliseconds: 10_000,
          reuseWindowMilliseconds: 2_000,
        },
      },
    },
  ];

  for (const value of cases) {
    assert.throws(
      () => loadApplicationConfig(writeConfig(t, value)),
      /Invalid OpenScreen application config/,
    );
  }
});

test("loads provider credentials from an explicit project environment file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "openscreen-app-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, ".env");
  const variable = "OPENSCREEN_TEST_PROVIDER_CREDENTIAL";
  const previous = process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  delete process.env[variable];
  writeFileSync(path, `${variable}=from-project-env\n`);
  const loadProjectEnvironment = (
    runtimeConfig as typeof runtimeConfig & {
      loadProjectEnvironment?: (environmentPath: string) => void;
    }
  ).loadProjectEnvironment;

  assert.equal(typeof loadProjectEnvironment, "function");
  loadProjectEnvironment?.(path);

  assert.equal(process.env[variable], "from-project-env");
});

test("allows startup when the optional project environment file is absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "openscreen-missing-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.doesNotThrow(() =>
    runtimeConfig.loadProjectEnvironment(join(root, ".env"))
  );
});
