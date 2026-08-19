import assert from "node:assert/strict";
import test from "node:test";

import { buildObservationalMemoryModel } from "../../../src/memory/mastra/model-adapter.js";

test("rejects any provider other than minimax-cn", () => {
  const previous = process.env.MINIMAX_CN_API_KEY;
  process.env.MINIMAX_CN_API_KEY = "test-key";
  try {
    assert.throws(
      () => buildObservationalMemoryModel({ provider: "openai", model: "gpt-5" }),
      /only supports the minimax-cn provider/,
    );
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_CN_API_KEY;
    else process.env.MINIMAX_CN_API_KEY = previous;
  }
});

test("requires MINIMAX_CN_API_KEY to be set", () => {
  const previous = process.env.MINIMAX_CN_API_KEY;
  delete process.env.MINIMAX_CN_API_KEY;
  try {
    assert.throws(
      () => buildObservationalMemoryModel({ provider: "minimax-cn", model: "MiniMax-M3" }),
      /MINIMAX_CN_API_KEY is required/,
    );
  } finally {
    if (previous !== undefined) process.env.MINIMAX_CN_API_KEY = previous;
  }
});

test("builds a LanguageModel for minimax-cn when the key is present", () => {
  const previous = process.env.MINIMAX_CN_API_KEY;
  process.env.MINIMAX_CN_API_KEY = "test-key";
  try {
    const model = buildObservationalMemoryModel({ provider: "minimax-cn", model: "MiniMax-M3" });
    assert.equal(model.modelId, "MiniMax-M3");
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_CN_API_KEY;
    else process.env.MINIMAX_CN_API_KEY = previous;
  }
});
