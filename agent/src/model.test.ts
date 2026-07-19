import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import {
  countRequestTokens,
  countTurns,
  makeRequest,
  mapEvent,
  relayStream,
  summarizeTurns,
} from "./model.js";

const loadScreenshot = async (path: string) => Buffer.from(path).toString("base64");

test("builds a streaming Responses API screenshot request", async () => {
  const request = await makeRequest(
    "vision-model",
    "What is on screen?",
    "current.png",
    21_760,
    undefined,
    loadScreenshot,
  );

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
        image_url: `data:image/png;base64,${Buffer.from("current.png").toString("base64")}`,
      },
    ],
  });
});

test("builds a MiniMax M3 streaming screenshot request", async () => {
  const request = await makeRequest(
    "MiniMax-M3",
    "What is on screen?",
    "current.png",
    21_760,
    undefined,
    loadScreenshot,
  );

  assert.deepEqual(request.reasoning, { effort: "minimal" });
  assert.equal(request.max_output_tokens, 21_760);
  assert.deepEqual(request.input?.[0], {
    role: "user",
    content: [
      { type: "input_text", text: "What is on screen?" },
      {
        type: "input_image",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("current.png").toString("base64")}`,
          detail: "default",
        },
      },
    ],
  });
});

test("includes every retained screenshot before the current request", async () => {
  const request = await makeRequest("vision-model", "Current question", "current.png", 21_760, {
    turns: [
      { user: "First question", assistant: "First answer", screenshotPath: "first.png" },
      { user: "Second question", assistant: "Second answer", screenshotPath: "second.png" },
      { user: "Third question", assistant: "Third answer", screenshotPath: "third.png" },
    ],
    summary: "Earlier context",
    firstKeptTurnIndex: 1,
  }, loadScreenshot);

  assert.deepEqual(request.input?.slice(0, -1), [
    { role: "developer", content: "Conversation summary:\nEarlier context" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Second question" },
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/png;base64,${Buffer.from("second.png").toString("base64")}`,
        },
      ],
    },
    { role: "assistant", content: "Second answer" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Third question" },
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/png;base64,${Buffer.from("third.png").toString("base64")}`,
        },
      ],
    },
    { role: "assistant", content: "Third answer" },
  ]);
  assert.deepEqual(request.input?.at(-1), {
    role: "user",
    content: [
      { type: "input_text", text: "Current question" },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${Buffer.from("current.png").toString("base64")}`,
      },
    ],
  });
});

test("marks failed and cancelled turns in model context", async () => {
  const request = await makeRequest("vision-model", "Try again", "current.png", 21_760, {
    turns: [
      {
        user: "Failed question",
        assistant: "Partial answer",
        reasoning: "Partial reasoning",
        screenshotPath: "failed.png",
        status: "failed",
      },
      {
        user: "Cancelled before capture",
        assistant: "",
        status: "cancelled",
      },
    ],
    firstKeptTurnIndex: 0,
  }, loadScreenshot);

  assert.deepEqual(request.input?.slice(0, -1), [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Failed question" },
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:image/png;base64,${Buffer.from("failed.png").toString("base64")}`,
        },
      ],
    },
    {
      role: "assistant",
      content: "[Request failed; response may be incomplete]\n\nPartial reasoning:\nPartial reasoning\n\nPartial answer:\nPartial answer",
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Cancelled before capture" }],
    },
    {
      role: "assistant",
      content: "[Request cancelled by user; response is incomplete]",
    },
  ]);
});

test("preserves prior response output items for the next model turn", async () => {
  const outputItems = [
    {
      id: "reasoning-1",
      type: "reasoning" as const,
      status: "completed" as const,
      summary: [],
      content: [{ type: "reasoning_text" as const, text: "Inspecting the screen" }],
    },
    {
      id: "message-1",
      type: "message" as const,
      status: "completed" as const,
      role: "assistant" as const,
      content: [{ type: "output_text" as const, text: "First answer", annotations: [] }],
    },
  ];
  const request = await makeRequest("MiniMax-M3", "Follow up", "current.png", 21_760, {
    turns: [{
      user: "First question",
      assistant: "First answer",
      screenshotPath: "first.png",
      outputItems,
    }],
    firstKeptTurnIndex: 0,
  }, loadScreenshot);

  assert.deepEqual(request.input?.slice(1, 3), outputItems);
  assert(Array.isArray(request.input));
  assert.equal(request.input.filter((item: any) => item.role === "assistant").length, 1);
});

test("counts retained turn text and screenshots together", async () => {
  let countedInput: unknown;
  const client = {
    responses: {
      inputTokens: {
        count: async ({ input }: { input: unknown }) => {
          countedInput = input;
          return { input_tokens: 123 };
        },
      },
    },
  } as unknown as OpenAI;

  const tokens = await countTurns(client, "vision-model", [
    { user: "Question 1", assistant: "Answer 1", screenshotPath: "first.png" },
    { user: "Question 2", assistant: "Answer 2", screenshotPath: "second.png" },
  ], loadScreenshot);

  assert.equal(tokens, 123);
  const input = JSON.stringify(countedInput);
  assert.match(input, new RegExp(Buffer.from("first.png").toString("base64")));
  assert.match(input, new RegExp(Buffer.from("second.png").toString("base64")));
});

test("passes cancellation to token counting and summarization requests", async () => {
  const controller = new AbortController();
  const signals: unknown[] = [];
  const client = {
    responses: {
      inputTokens: {
        count: async (_request: unknown, options: { signal?: AbortSignal }) => {
          signals.push(options.signal);
          return { input_tokens: 1 };
        },
      },
      create: async (_request: unknown, options: { signal?: AbortSignal }) => {
        signals.push(options.signal);
        return { output_text: "Summary" };
      },
    },
  } as unknown as OpenAI;

  await countRequestTokens(client, {
    model: "vision-model",
    input: [],
    stream: true,
  }, controller.signal);
  await countTurns(client, "vision-model", [], loadScreenshot, controller.signal);
  await summarizeTurns(
    client,
    "vision-model",
    undefined,
    [],
    100,
    loadScreenshot,
    controller.signal,
  );

  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
});

test("summarizes old screenshots as plain facts without internal references", async () => {
  let summaryRequest: any;
  const client = {
    responses: {
      create: async (request: unknown) => {
        summaryRequest = request;
        return { output_text: "The settings page shows an authentication error." };
      },
    },
  } as unknown as OpenAI;

  await summarizeTurns(
    client,
    "vision-model",
    "The user is configuring an account.",
    [{
      user: "Why did this fail?",
      assistant: "The form reports an authentication error.",
      screenshotPath: "error-screen.png",
    }],
    4_096,
    loadScreenshot,
  );

  const input = JSON.stringify(summaryRequest.input);
  assert.match(input, new RegExp(Buffer.from("error-screen.png").toString("base64")));
  assert.match(summaryRequest.instructions, /plain facts/i);
  assert.match(summaryRequest.instructions, /screenshot paths/i);
  assert.match(summaryRequest.instructions, /turn IDs/i);
  assert.match(summaryRequest.instructions, /reference markers/i);
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
  async function* stream(): AsyncGenerator<import("./model.js").ModelEvent> {
    yield { type: "response.reasoning_summary_text.delta", delta: "Checked screen" };
    yield { type: "response.output_text.delta", delta: "Final answer" };
    yield {
      type: "response.completed",
      response: {
        output: [{
          id: "message-1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Final answer", annotations: [] }],
        }],
        usage: { total_tokens: 42 },
      },
    };
    exhausted = true;
  }

  const output = await relayStream("request-1", stream(), (event) => events.push(event));

  assert.equal(exhausted, true);
  assert.deepEqual(output, {
    output: "Final answer",
    reasoning: "Checked screen",
    outputItems: [{
      id: "message-1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Final answer", annotations: [] }],
    }],
    totalTokens: 42,
  });
  assert.deepEqual(events, [
    { requestId: "request-1", type: "reasoning_delta", delta: "Checked screen" },
    { requestId: "request-1", type: "answer_delta", delta: "Final answer" },
  ]);
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
