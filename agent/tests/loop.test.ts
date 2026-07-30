import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import {
  countRequestTokens,
  countTurns,
  makeRequest,
} from "../src/harness/session/context.js";
import { summarizeTurns } from "../src/harness/compaction/summary.js";
import {
  mapEvent,
  relayStream,
  runAgentLoop,
} from "../src/loop.js";

const loadScreenshot = async (path: string) => Buffer.from(path).toString("base64");

test("builds a streaming Responses API request with system and user screenshots in order", async () => {
  const request = await makeRequest(
    "vision-model",
    "What is on screen?",
    [
      { id: "system", source: "system_capture", path: "current.png" },
      { id: "upload-1", source: "user_upload", path: "one.png" },
      { id: "upload-2", source: "user_upload", path: "two.png" },
    ] as any,
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
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${Buffer.from("one.png").toString("base64")}`,
      },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${Buffer.from("two.png").toString("base64")}`,
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

test("includes tool definitions when counting an agent step request", async () => {
  let countedRequest: any;
  const client = {
    responses: {
      inputTokens: {
        count: async (request: unknown) => {
          countedRequest = request;
          return { input_tokens: 123 };
        },
      },
    },
  } as unknown as OpenAI;
  const tools: OpenAI.Responses.FunctionTool[] = [{
    type: "function",
    name: "retrieve_context",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  }];

  await countRequestTokens(client, {
    model: "vision-model",
    input: [],
    tools,
    stream: true,
  });

  assert.deepEqual(countedRequest.tools, tools);
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

test("maps Responses API deltas to chat stream events", () => {
  assert.deepEqual(
    mapEvent({
      type: "response.reasoning_summary_text.delta",
      delta: "Checking the screen",
    }),
    {
      type: "reasoning_delta",
      delta: "Checking the screen",
    },
  );
  assert.deepEqual(
    mapEvent({
      type: "response.reasoning_text.delta",
      delta: "MiniMax thinking",
    }),
    {
      type: "reasoning_delta",
      delta: "MiniMax thinking",
    },
  );
  assert.deepEqual(
    mapEvent({
      type: "response.output_text.delta",
      delta: "This is OpenScreen.",
    }),
    {
      type: "answer_delta",
      delta: "This is OpenScreen.",
    },
  );
  assert.deepEqual(
    mapEvent({
      type: "response.refusal.delta",
      delta: "I cannot help with that.",
    }),
    {
      type: "answer_delta",
      delta: "I cannot help with that.",
    },
  );
  assert.deepEqual(mapEvent({ type: "response.completed" }), {
    type: "completed",
  });
  assert.deepEqual(
    mapEvent({ type: "error", message: "Provider failed" }),
    { type: "failed", message: "Provider failed" },
  );
  assert.equal(mapEvent({ type: "response.created" }), undefined);
});

test("completes only after a successful stream is exhausted", async () => {
  const events: object[] = [];
  let exhausted = false;
  async function* stream(): AsyncGenerator<import("../src/loop.js").ModelEvent> {
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

  const output = await relayStream(stream(), (event) => events.push(event));

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
    { type: "reasoning_delta", delta: "Checked screen" },
    { type: "answer_delta", delta: "Final answer" },
  ]);
});

test("fails a stream that ends without a terminal event", async () => {
  const events: object[] = [];
  async function* stream() {
    yield { type: "response.output_text.delta", delta: "Partial answer" };
  }

  const output = await relayStream(stream(), (event) => events.push(event));

  assert.equal(output, null);
  assert.deepEqual(events.at(-1), {
    type: "failed",
    message: "Model stream ended before completion",
  });
});

test("runs model tool calls until the agent loop completes", async () => {
  const requests: any[] = [];
  const streams = [
    (async function* () {
      yield { type: "response.reasoning_summary_text.delta", delta: "Searching memory" };
      yield {
        type: "response.completed",
        response: {
          id: "response-1",
          output: [
            {
              id: "reasoning-1",
              type: "reasoning",
              status: "completed",
              summary: [],
              content: [],
            },
            {
              id: "call-1",
              call_id: "call-1",
              type: "function_call",
              status: "completed",
              name: "retrieve_context",
              arguments: JSON.stringify({ query: "project status" }),
            },
          ],
          usage: { total_tokens: 20 },
        },
      };
    })(),
    (async function* () {
      yield { type: "response.output_text.delta", delta: "The project is active." };
      yield {
        type: "response.completed",
        response: {
          id: "response-2",
          output: [{
            id: "message-1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "The project is active.",
              annotations: [],
            }],
          }],
          usage: { total_tokens: 30 },
        },
      };
    })(),
  ];
  const client = {
    responses: {
      create: async (request: unknown, options: { signal?: AbortSignal }) => {
        requests.push({ request, signal: options.signal });
        return streams.shift()!;
      },
    },
  } as unknown as OpenAI;
  const controller = new AbortController();
  const streamed: object[] = [];
  const recorded: object[] = [];
  const result = await runAgentLoop(
    client,
    async (items, definitions) => ({
      model: "vision-model",
      input: [{ role: "user", content: "What is the project status?" }, ...items],
      ...(definitions.length > 0 ? { tools: definitions } : {}),
      stream: true,
    }),
    [{
      definition: {
        type: "function",
        name: "retrieve_context",
        description: "Retrieve relevant context.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        strict: true,
      },
      execute: async (argumentsValue, signal) => {
        assert.deepEqual(argumentsValue, { query: "project status" });
        assert.equal(signal, controller.signal);
        return { matches: [{ text: "The project is active." }] };
      },
    }],
    (event) => streamed.push(event),
    (event) => {
      recorded.push(event);
      return Promise.resolve();
    },
    controller.signal,
  );

  assert.equal(result?.type, "completed");
  assert.equal(result?.output, "The project is active.");
  assert.equal(result?.reasoning, "Searching memory");
  assert.equal(result?.totalTokens, 30);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ signal }) => signal === controller.signal));
  assert.equal(requests[0].request.tools[0].name, "retrieve_context");
  assert.deepEqual(requests[1].request.input.slice(1, 4), [
    {
      id: "reasoning-1",
      type: "reasoning",
      status: "completed",
      summary: [],
      content: [],
    },
    {
      id: "call-1",
      call_id: "call-1",
      type: "function_call",
      status: "completed",
      name: "retrieve_context",
      arguments: JSON.stringify({ query: "project status" }),
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ matches: [{ text: "The project is active." }] }),
    },
  ]);
  assert.deepEqual(streamed, [
    { type: "reasoning_delta", delta: "Searching memory" },
    { type: "answer_delta", delta: "The project is active." },
  ]);
  assert.deepEqual(recorded.map((event: any) => event.type), [
    "agent_step_completed",
    "tool_result_recorded",
    "agent_step_completed",
  ]);
});

test("does not impose a model step limit on the agent loop", async () => {
  let responseNumber = 0;
  const client = {
    responses: {
      create: async () => (async function* () {
        responseNumber += 1;
        if (responseNumber <= 9) {
          yield {
            type: "response.completed",
            response: {
              id: `response-${responseNumber}`,
              output: [{
                id: `function-${responseNumber}`,
                call_id: `call-${responseNumber}`,
                type: "function_call",
                status: "completed",
                name: "retrieve_context",
                arguments: "{}",
              }],
            },
          };
          return;
        }
        yield { type: "response.output_text.delta", delta: "Done" };
        yield {
          type: "response.completed",
          response: {
            id: "response-10",
            output: [{
              id: "message-1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
            }],
          },
        };
      })(),
    },
  } as unknown as OpenAI;
  const result = await runAgentLoop(
    client,
    async (items, definitions) => ({
      model: "vision-model",
      input: items,
      tools: definitions,
      stream: true,
    }),
    [{
      definition: {
        type: "function",
        name: "retrieve_context",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
      execute: async () => "ok",
    }],
    () => {},
    async () => {},
    new AbortController().signal,
  );

  assert.equal(responseNumber, 10);
  assert.equal(result?.type, "completed");
  assert.equal(result?.output, "Done");
});

test("returns tool failures to the model and continues the agent loop", async () => {
  const requests: any[] = [];
  let responseNumber = 0;
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        responseNumber += 1;
        return responseNumber === 1
          ? (async function* () {
              yield {
                type: "response.completed",
                response: {
                  output: [{
                    id: "function-1",
                    call_id: "call-1",
                    type: "function_call",
                    status: "completed",
                    name: "retrieve_context",
                    arguments: JSON.stringify({ query: "missing" }),
                  }],
                },
              };
            })()
          : (async function* () {
              yield { type: "response.output_text.delta", delta: "Context is unavailable." };
              yield {
                type: "response.completed",
                response: {
                  output: [{
                    id: "message-1",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [{
                      type: "output_text",
                      text: "Context is unavailable.",
                      annotations: [],
                    }],
                  }],
                },
              };
            })();
      },
    },
  } as unknown as OpenAI;
  const recorded: any[] = [];
  const result = await runAgentLoop(
    client,
    async (items, definitions) => ({
      model: "vision-model",
      input: items,
      tools: definitions,
      stream: true,
    }),
    [{
      definition: {
        type: "function",
        name: "retrieve_context",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        strict: true,
      },
      execute: async () => {
        throw new Error("Retrieval unavailable");
      },
    }],
    () => {},
    async (event) => { recorded.push(event); },
    new AbortController().signal,
  );

  const failedOutput = requests[1].input.find(
    (item: any) => item.type === "function_call_output",
  );
  assert.deepEqual(JSON.parse(failedOutput.output), {
    error: "Retrieval unavailable",
  });
  assert.equal(
    recorded.find((event) => event.type === "tool_result_recorded").status,
    "failed",
  );
  assert.equal(result?.output, "Context is unavailable.");
});

test("does not start a tool after the agent run is cancelled", async () => {
  const client = {
    responses: {
      create: async () => (async function* () {
        yield {
          type: "response.completed",
          response: {
            output: [{
              id: "function-1",
              call_id: "call-1",
              type: "function_call",
              status: "completed",
              name: "retrieve_context",
              arguments: "{}",
            }],
          },
        };
      })(),
    },
  } as unknown as OpenAI;
  const controller = new AbortController();
  let toolCalled = false;

  await assert.rejects(runAgentLoop(
    client,
    async (items, definitions) => ({
      model: "vision-model",
      input: items,
      tools: definitions,
      stream: true,
    }),
    [{
      definition: {
        type: "function",
        name: "retrieve_context",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
      execute: async () => {
        toolCalled = true;
        return "unreachable";
      },
    }],
    () => {},
    async (event) => {
      if (event.type === "agent_step_completed") controller.abort();
    },
    controller.signal,
  ), { name: "AbortError" });

  assert.equal(toolCalled, false);
});
