import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";

import {
  estimateResponseRequestTokens,
} from "../../src/model-token-count.js";
import {
  countModelRequestTokens,
} from "../../src/harness/memory/shared/model-request.js";

const request = {
  model: "kimi-k2.7-code",
  instructions: "只返回 JSON。",
  input: "整理这段屏幕活动：用户正在编辑文档。",
  max_output_tokens: 4_096,
} satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming;

function expectedLocalEstimate() {
  const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  return Math.ceil(bytes / 4);
}

test("falls back to the local estimate when the provider returns zero tokens", async () => {
  const client = {
    responses: {
      inputTokens: {
        count: async () => ({ input_tokens: 0 }),
      },
    },
  } as unknown as OpenAI;

  assert.equal(
    await countModelRequestTokens(client, request),
    expectedLocalEstimate(),
  );
});

test("falls back to the local estimate when input token counting is unsupported", async () => {
  const client = {
    responses: {
      inputTokens: {
        count: async () => {
          throw new Error("404 InvalidAction");
        },
      },
    },
  } as unknown as OpenAI;

  assert.equal(
    await countModelRequestTokens(client, request),
    expectedLocalEstimate(),
  );
});

test("replaces inline image Base64 with the Codex resized-image estimate", () => {
  const payload = "A".repeat(100_000);
  const imageRequest = {
    model: "kimi-k2.7-code",
    input: [{
      role: "user" as const,
      content: [{
        type: "input_image" as const,
        detail: "auto" as const,
        image_url: `data:image/png;base64,${payload}`,
      }],
    }],
  } satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming;
  const rawBytes = Buffer.byteLength(JSON.stringify(imageRequest), "utf8");

  assert.equal(
    estimateResponseRequestTokens(imageRequest),
    Math.ceil((rawBytes - payload.length + 7_373) / 4),
  );
});

test("applies one resized-image estimate to every OpenAI-compatible image shape", () => {
  const firstPayload = "A".repeat(20_000);
  const secondPayload = "B".repeat(30_000);
  const imageRequest = {
    model: "kimi-k2.7-code",
    input: [{
      role: "user" as const,
      content: [
        {
          type: "input_image" as const,
          detail: "auto" as const,
          image_url: `data:image/png;base64,${firstPayload}`,
        },
        {
          type: "input_image" as const,
          image_url: {
            url: `data:image/jpeg;base64,${secondPayload}`,
            detail: "default",
          },
        },
      ],
    }],
  } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
  const rawBytes = Buffer.byteLength(JSON.stringify(imageRequest), "utf8");

  assert.equal(
    estimateResponseRequestTokens(imageRequest),
    Math.ceil((
      rawBytes - firstPayload.length - secondPayload.length + 2 * 7_373
    ) / 4),
  );
});

test("estimates original-detail PNG images from 32 pixel patches", () => {
  const pngHeader = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(pngHeader);
  pngHeader.writeUInt32BE(1_847, 16);
  pngHeader.writeUInt32BE(1_055, 20);
  const payload = pngHeader.toString("base64");
  const imageRequest = {
    model: "vision-model",
    input: [{
      role: "user" as const,
      content: [{
        type: "input_image" as const,
        detail: "original",
        image_url: `data:image/png;base64,${payload}`,
      }],
    }],
  } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
  const rawBytes = Buffer.byteLength(JSON.stringify(imageRequest), "utf8");
  const patches = Math.ceil(1_847 / 32) * Math.ceil(1_055 / 32);

  assert.equal(
    estimateResponseRequestTokens(imageRequest),
    Math.ceil((rawBytes - payload.length + patches * 4) / 4),
  );
});

test("does not discount non-image Base64 data URLs", () => {
  const imageRequest = {
    model: "vision-model",
    input: [{
      role: "user" as const,
      content: [{
        type: "input_image" as const,
        detail: "auto" as const,
        image_url: `data:application/octet-stream;base64,${"A".repeat(4_096)}`,
      }],
    }],
  } satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming;

  assert.equal(
    estimateResponseRequestTokens(imageRequest),
    Math.ceil(Buffer.byteLength(JSON.stringify(imageRequest), "utf8") / 4),
  );
});
