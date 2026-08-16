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
  screenpipe: {
    enabled: true,
    ignoredWindows: ["OpenScreen"],
    ignoredUrls: [],
    retention: {
      maxAgeMilliseconds: 604_800_000,
      maxBytes: 10_737_418_240,
    },
  },
};

const memoryFixture = {
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
    memory: memoryFixture,
  };
}

test("checked-in configuration is the strict pi, Capture, and Memory configuration", () => {
  const config = JSON.parse(readFileSync(repositoryConfigPath(), "utf8")) as Record<string, unknown>;
  const loaded = loadApplicationConfig(repositoryConfigPath());

  assert.deepEqual(Object.keys(config).sort(), ["agent", "capture", "memory"]);
  assert.deepEqual(loaded.agent, {
    provider: "minimax-cn",
    model: "MiniMax-M3",
    thinking: "medium",
  });
  assert.deepEqual(loaded.capture, captureFixture);
  assert.deepEqual(loaded.memory, memoryFixture);
});

test("checked-in environment example uses the pi MiniMax credential name", () => {
  const examplePath = join(dirname(repositoryConfigPath()), ".env.example");

  assert.equal(
    readFileSync(examplePath, "utf8"),
    "MINIMAX_CN_API_KEY=your-api-key\n",
  );
});

test("loads only clean pi selection, Capture, and Memory configuration", (t) => {
  const path = writeConfig(t, cleanConfig());

  const config = loadApplicationConfig(path);

  assert.equal(config.agent.provider, "anthropic");
  assert.equal(config.agent.model, "claude-sonnet-4-5");
  assert.equal(config.agent.thinking, "medium");
  assert.equal(config.capture.screenpipe.retention.maxBytes, 10_737_418_240);
  assert.equal(config.memory.turnMemory.idleMilliseconds, 1_800_000);
  assert.equal("apiKey" in config, false);
  assert.equal("baseURL" in config, false);
  assert.equal("session" in config, false);
  assert.equal("context" in config, false);
});

test("rejects legacy, secret-bearing, and malformed clean configuration", (t) => {
  const cases = [
    { ...cleanConfig(), apiKey: "secret" },
    { ...cleanConfig(), baseURL: "https://example.test" },
    { ...cleanConfig(), memory: {} },
    {
      ...cleanConfig(),
      memory: {
        ...memoryFixture,
        worker: { ...memoryFixture.worker, maxAttempts: 0 },
      },
    },
    { ...cleanConfig(), context: {} },
    {
      ...cleanConfig(),
      agent: { ...cleanConfig().agent, thinking: "ultra" },
    },
    {
      ...cleanConfig(),
      capture: {
        ...captureFixture,
        screenpipe: {
          ...captureFixture.screenpipe,
          retention: {
            ...captureFixture.screenpipe.retention,
            maxBytes: 0,
          },
        },
      },
    },
    {
      ...cleanConfig(),
      capture: {
        ...captureFixture,
        scheduling: {},
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
