import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedText,
  modelInputTokenBudget,
  requireValidInputTokenCount,
  turnMemoryInputTokenBudget,
} from "../../src/harness/memory/shared/request-budget.js";

test("calculates one validated model input budget policy", () => {
  assert.equal(modelInputTokenBudget({
    operation: "Turn Memory",
    contextWindowTokens: 10_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_000,
    contextWindowFraction: { numerator: 7, denominator: 10 },
  }), 7_000);
  assert.equal(modelInputTokenBudget({
    operation: "Consolidation",
    contextWindowTokens: 10_000,
    maxInputTokens: 12_000,
    maxOutputTokens: 2_000,
  }), 8_000);
  assert.throws(() => modelInputTokenBudget({
    operation: "Turn Memory",
    contextWindowTokens: 1_000,
    maxInputTokens: 800,
    maxOutputTokens: 1_000,
  }), /Turn Memory output leaves no input budget/);
  assert.throws(() => modelInputTokenBudget({
    operation: "Turn Memory",
    contextWindowTokens: 10_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_000,
    contextWindowFraction: { numerator: 0, denominator: 10 },
  }), /invalid Turn Memory token budget/i);
});

test("keeps the Turn Memory reserve policy behind one shared helper", () => {
  assert.equal(turnMemoryInputTokenBudget({
    contextWindowTokens: 10_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_000,
  }), 7_000);
});

test("rejects an impossible zero token count for a non-empty request", () => {
  assert.throws(
    () => requireValidInputTokenCount(0, 12),
    /non-empty model request.*zero input tokens/i,
  );
  assert.equal(requireValidInputTokenCount(0, 0), 0);
  assert.equal(requireValidInputTokenCount(42, 12), 42);
  assert.throws(() => requireValidInputTokenCount(-1, 12), /invalid input token count/i);
  assert.throws(() => requireValidInputTokenCount(1.5, 12), /invalid input token count/i);
});

test("bounds long text with Unicode-safe head and tail retention", () => {
  const value = `${"a".repeat(30)}😀${"z".repeat(30)}`;
  const bounded = boundedText(value, 24);

  assert.equal(bounded.originalCharacters, 61);
  assert.equal(bounded.truncatedCharacters, 37);
  assert.equal(Array.from(bounded.text).length, 24);
  assert.match(bounded.text, /^a+/);
  assert.match(bounded.text, /z+$/);
  assert.match(bounded.text, /\[truncated\]/);
  assert.doesNotMatch(bounded.text, /\uFFFD/);
});

test("leaves text within the local character limit unchanged", () => {
  assert.deepEqual(boundedText("hello 😀", 20), {
    text: "hello 😀",
    originalCharacters: 7,
    truncatedCharacters: 0,
  });
  assert.throws(() => boundedText("text", 0), /invalid text character limit/i);
});
