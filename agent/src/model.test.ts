import assert from "node:assert/strict";
import test from "node:test";

import { getModel, makeRequest, mapEvent, relayStream } from "./model.js";

test("requires an OpenAI-compatible model", () => {
  assert.equal(getModel({ OPENAI_MODEL: "vision-model" }), "vision-model");
  assert.throws(() => getModel({}), /OPENAI_MODEL is required/);
});

test("builds a streaming Responses API screenshot request", () => {
  const request = makeRequest("vision-model", "What is on screen?", "cG5n");

  assert.equal(request.model, "vision-model");
  assert.equal(request.stream, true);
  assert.deepEqual(request.reasoning, { summary: "auto" });
  assert.deepEqual(request.input?.[0], {
    role: "user",
    content: [
      { type: "input_text", text: "What is on screen?" },
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,cG5n",
      },
    ],
  });
});

test("builds a MiniMax M3 streaming screenshot request", () => {
  const request = makeRequest("MiniMax-M3", "What is on screen?", "cG5n");

  assert.deepEqual(request.reasoning, { effort: "minimal" });
  assert.equal(request.max_output_tokens, 21_760);
  assert.deepEqual(request.input?.[0], {
    role: "user",
    content: [
      { type: "input_text", text: "What is on screen?" },
      {
        type: "input_image",
        image_url: {
          url: "data:image/png;base64,cG5n",
          detail: "default",
        },
      },
    ],
  });
});

test("includes summary and retained turns before the current request", () => {
  const request = makeRequest("vision-model", "Current question", "cG5n", {
    turns: [
      { user: "First question", assistant: "First answer" },
      { user: "Second question", assistant: "Second answer" },
    ],
    summary: "Earlier context",
    firstKeptTurnIndex: 1,
  });

  assert.deepEqual(request.input?.slice(0, -1), [
    { role: "developer", content: "Conversation summary:\nEarlier context" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second answer" },
  ]);
  assert.deepEqual(request.input?.at(-1), {
    role: "user",
    content: [
      { type: "input_text", text: "Current question" },
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,cG5n",
      },
    ],
  });
});

test("maps Responses API deltas to request-scoped JSONL events", () => {
  assert.deepEqual(
    mapEvent("request-1", {
      type: "response.reasoning_summary_text.delta",
      delta: "Checking the screen",
    }),
    {
      requestId: "request-1",
      type: "reasoning_delta",
      delta: "Checking the screen",
    },
  );
  assert.deepEqual(
    mapEvent("request-1", {
      type: "response.reasoning_text.delta",
      delta: "MiniMax thinking",
    }),
    {
      requestId: "request-1",
      type: "reasoning_delta",
      delta: "MiniMax thinking",
    },
  );
  assert.deepEqual(
    mapEvent("request-1", {
      type: "response.output_text.delta",
      delta: "This is OpenScreen.",
    }),
    {
      requestId: "request-1",
      type: "answer_delta",
      delta: "This is OpenScreen.",
    },
  );
  assert.deepEqual(
    mapEvent("request-1", {
      type: "response.refusal.delta",
      delta: "I cannot help with that.",
    }),
    {
      requestId: "request-1",
      type: "answer_delta",
      delta: "I cannot help with that.",
    },
  );
  assert.deepEqual(mapEvent("request-1", { type: "response.completed" }), {
    requestId: "request-1",
    type: "completed",
  });
  assert.deepEqual(
    mapEvent("request-1", { type: "error", message: "Provider failed" }),
    { requestId: "request-1", type: "failed", message: "Provider failed" },
  );
  assert.equal(mapEvent("request-1", { type: "response.created" }), undefined);
});

test("completes only after a successful stream is exhausted", async () => {
  const events: object[] = [];
  let exhausted = false;
  async function* stream() {
    yield { type: "response.output_text.delta", delta: "Final answer" };
    yield {
      type: "response.completed",
      response: { usage: { total_tokens: 42 } },
    };
    exhausted = true;
  }

  const output = await relayStream("request-1", stream(), (event) => events.push(event));

  assert.equal(exhausted, true);
  assert.deepEqual(output, { output: "Final answer", totalTokens: 42 });
  assert.deepEqual(events.at(-1), { requestId: "request-1", type: "completed" });
});

test("fails a stream that ends without a terminal event", async () => {
  const events: object[] = [];
  async function* stream() {
    yield { type: "response.output_text.delta", delta: "Partial answer" };
  }

  const output = await relayStream("request-1", stream(), (event) => events.push(event));

  assert.equal(output, null);
  assert.deepEqual(events.at(-1), {
    requestId: "request-1",
    type: "failed",
    message: "Model stream ended before completion",
  });
});
