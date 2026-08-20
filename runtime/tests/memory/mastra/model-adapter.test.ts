import assert from "node:assert/strict";
import test from "node:test";

import { buildObservationalMemoryModel } from "../../../src/memory/mastra/model-adapter.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const MINIMAX = {
  provider: "minimax-cn",
  id: "MiniMax-M3",
  api: "anthropic-messages",
  baseUrl: "https://api.minimaxi.com/anthropic",
};

const DEEPSEEK = {
  provider: "deepseek",
  id: "deepseek-chat",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
};

test("builds an Anthropic-messages LanguageModel and appends the API version segment", () => {
  withEnv("MINIMAX_CN_API_KEY", "test-key", () => {
    const model = buildObservationalMemoryModel(MINIMAX);
    assert.equal("modelId" in model ? model.modelId : undefined, "MiniMax-M3");
  });
});

test("builds an OpenAI-compatible config without constructing a client", () => {
  withEnv("DEEPSEEK_API_KEY", "test-key", () => {
    const model = buildObservationalMemoryModel(DEEPSEEK);
    assert.deepEqual(model, {
      providerId: "deepseek",
      modelId: "deepseek-chat",
      url: "https://api.deepseek.com",
      apiKey: "test-key",
    });
  });
});

test("rejects a wire API it has no verified client for", () => {
  withEnv("GEMINI_API_KEY", "test-key", () => {
    assert.throws(
      () =>
        buildObservationalMemoryModel({
          provider: "google",
          id: "gemini-3-pro",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      /does not support the google-generative-ai API/,
    );
  });
});

test("rejects a templated base URL it cannot substitute", () => {
  withEnv("CLOUDFLARE_API_KEY", "test-key", () => {
    assert.throws(
      () =>
        buildObservationalMemoryModel({
          provider: "cloudflare-ai-gateway",
          id: "some-model",
          api: "openai-completions",
          baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/x/compat",
        }),
      /templated base URL/,
    );
  });
});

test("requires an API key for the configured provider", () => {
  withEnv("MINIMAX_CN_API_KEY", undefined, () => {
    assert.throws(
      () => buildObservationalMemoryModel(MINIMAX),
      /require an API key for the minimax-cn provider/,
    );
  });
});
