import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  COMPACT_AT_TOKENS,
  KEEP_RECENT_TOKENS,
  MAX_OUTPUT_TOKENS,
  compactIfNeeded,
  compactSession,
  getModel,
  makeRequest,
  mapEvent,
  relayStream,
  type SessionState,
} from "./main.js";

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

test("includes completed text turns before the current screenshot request", () => {
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

test("compacts older turns while retaining 20K recent tokens", async () => {
  assert.equal(KEEP_RECENT_TOKENS, 20_000);
  const session: SessionState = {
    turns: Array.from({ length: 5 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    firstKeptTurnIndex: 0,
  };
  let summarizedTurns = 0;

  await compactSession(
    session,
    async (turns) => turns.length * 10_000,
    async (_previousSummary, turns) => {
      summarizedTurns = turns.length;
      return "Compact summary";
    },
  );

  assert.equal(summarizedTurns, 3);
  assert.equal(session.summary, "Compact summary");
  assert.equal(session.firstKeptTurnIndex, 3);
  assert.equal(session.turns.length, 5);
});

test("finds the 20K recent-turn boundary without scanning every turn", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 100 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    firstKeptTurnIndex: 0,
  };
  let countCalls = 0;

  await compactSession(
    session,
    async (turns) => {
      countCalls += 1;
      return turns.length * 1_000;
    },
    async () => "Compact summary",
  );

  assert.equal(session.firstKeptTurnIndex, 80);
  assert.ok(countCalls <= 8);
});

test("rolls the previous summary forward without re-summarizing raw history", async () => {
  const session: SessionState = {
    turns: Array.from({ length: 8 }, (_, index) => ({
      user: `Question ${index + 1}`,
      assistant: `Answer ${index + 1}`,
    })),
    summary: "Previous summary",
    firstKeptTurnIndex: 3,
  };
  let summarizedQuestions: string[] = [];

  await compactSession(
    session,
    async (turns) => turns.length * 10_000,
    async (previousSummary, turns) => {
      assert.equal(previousSummary, "Previous summary");
      summarizedQuestions = turns.map((turn) => turn.user);
      return "Updated summary";
    },
  );

  assert.deepEqual(summarizedQuestions, ["Question 4", "Question 5", "Question 6"]);
  assert.equal(session.summary, "Updated summary");
  assert.equal(session.firstKeptTurnIndex, 6);
});

test("compacts before a request and verifies the rebuilt context", async () => {
  assert.equal(COMPACT_AT_TOKENS, 244_800);
  assert.equal(MAX_OUTPUT_TOKENS, 21_760);
  const counts = [244_800, 30_000];
  let compactions = 0;

  const tokens = await compactIfNeeded(
    async () => counts.shift()!,
    async () => { compactions += 1; },
  );

  assert.equal(compactions, 1);
  assert.equal(tokens, 30_000);
});

test("rebuilds the agent process context after turn-end compaction", async (t) => {
  const modelRequests: unknown[] = [];
  let summaryRequests = 0;
  const server = createServer(async (request, response) => {
    const body = await readJSON(request);

    if (request.url === "/v1/responses/input_tokens") {
      response.setHeader("content-type", "application/json");
      if (!body.instructions) {
        response.end(JSON.stringify({
          object: "response.input_tokens",
          input_tokens: (body.input.length / 2) * 10_000,
        }));
        return;
      }

      response.end(JSON.stringify({ object: "response.input_tokens", input_tokens: 30_000 }));
      return;
    }

    if (request.url === "/v1/responses" && !body.stream) {
      summaryRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "summary",
        object: "response",
        created_at: 0,
        model: "MiniMax-M3",
        status: "completed",
        output: [{
          id: "summary-message",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Summary of old turns", annotations: [] }],
        }],
      }));
      return;
    }

    if (request.url === "/v1/responses" && body.stream) {
      modelRequests.push(body);
      const currentText = body.input.at(-1)?.content?.[0]?.text;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "answer",
      })}\n\n`);
      response.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            total_tokens: currentText === "kept turn four" ? COMPACT_AT_TOKENS : 1_000,
          },
        },
      })}\n\n`);
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openscreen-test-"));
  const image = join(directory, "screen.png");
  await writeFile(image, "png");
  t.after(() => rm(directory, { force: true, recursive: true }));

  const agent = spawn(process.execPath, ["agent/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_MODEL: "MiniMax-M3",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => agent.kill());

  const completions = new Map<string, () => void>();
  createInterface({ input: agent.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as { requestId: string; type: string; message?: string };
    if (event.type === "failed") throw new Error(event.message);
    if (event.type === "completed") completions.get(event.requestId)?.();
  });

  let requestNumber = 0;
  async function sendTurn(text: string) {
    const requestId = `request-${++requestNumber}`;
    const completed = new Promise<void>((resolve) => completions.set(requestId, resolve));
    agent.stdin.write(`${JSON.stringify({ requestId, input: { text, image } })}\n`);
    await completed;
  }

  await sendTurn("old turn one");
  await sendTurn("old turn two");
  await sendTurn("kept turn three");
  await sendTurn("kept turn four");
  await sendTurn("next request");

  const finalRequest = modelRequests.at(-1) as { input: unknown[] };
  const context = JSON.stringify(finalRequest.input);
  assert.match(context, /Summary of old turns/);
  assert.match(context, /kept turn three/);
  assert.match(context, /kept turn four/);
  assert.match(context, /next request/);
  assert.doesNotMatch(context, /old turn one/);
  assert.doesNotMatch(context, /old turn two/);
  assert.equal(summaryRequests, 1);
  assert.equal(modelRequests.length, 5);
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

async function readJSON(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

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
