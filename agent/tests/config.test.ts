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
    },
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
