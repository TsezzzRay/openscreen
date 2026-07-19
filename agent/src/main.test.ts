import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("rebuilds the agent process context after turn-end compaction", async (t) => {
  const compactAtTokens = 50_000;
  const modelRequests: unknown[] = [];
  const summaryRequests: any[] = [];
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
      summaryRequests.push(body);
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
      const responseNumber = modelRequests.length;
      if (typeof currentText === "string" && currentText.startsWith("slow concurrent")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (currentText === "failed stream") {
        response.end(`data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "partial answer",
        })}\n\n`);
        return;
      }
      response.write(`data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "answer",
      })}\n\n`);
      response.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          output: [
            {
              id: `reasoning-${responseNumber}`,
              type: "reasoning",
              status: "completed",
              summary: [],
              content: [{ type: "reasoning_text", text: `reasoning-${responseNumber}` }],
            },
            {
              id: `message-${responseNumber}`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "answer", annotations: [] }],
            },
          ],
          usage: {
            total_tokens: currentText === "kept turn four" ? compactAtTokens : 1_000,
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
  t.after(() => rm(directory, { force: true, recursive: true }));
  const sessionsDirectory = join(directory, "sessions");

  const agent = spawn(process.execPath, ["agent/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_MODEL: "MiniMax-M3",
      OPENSCREEN_CONTEXT_WINDOW_TOKENS: "100000",
      OPENSCREEN_COMPACT_AT_TOKENS: String(compactAtTokens),
      OPENSCREEN_KEEP_RECENT_TOKENS: "20000",
      OPENSCREEN_MAX_OUTPUT_TOKENS: "40000",
      OPENSCREEN_SUMMARY_MAX_OUTPUT_TOKENS: "4096",
      OPENSCREEN_DATA_DIR: sessionsDirectory,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => agent.kill());

  const requests = new Map<string, {
    events: any[];
    resolve: (events: any[]) => void;
    reject: (error: Error) => void;
  }>();
  createInterface({ input: agent.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as { requestId: string; type: string; message?: string };
    const request = requests.get(event.requestId);
    if (!request) return;
    request.events.push(event);
    if (event.type === "failed") request.reject(new Error(event.message));
    if (event.type === "completed") request.resolve(request.events);
  });

  let requestNumber = 0;
  async function request(payload: Record<string, unknown>) {
    const requestId = `request-${++requestNumber}`;
    const completed = new Promise<any[]>((resolve, reject) => {
      requests.set(requestId, { events: [], resolve, reject });
    });
    agent.stdin.write(`${JSON.stringify({ requestId, ...payload })}\n`);
    return completed;
  }

  const created = await request({ type: "create_session" });
  const sessionId = created.find((event) => event.type === "session").session.id;

  async function sendTurn(text: string, targetSessionId = sessionId) {
    const turnNumber = requestNumber + 1;
    const requestId = `turn-${turnNumber}`;
    const image = join(directory, `${requestId}.png`);
    await writeFile(image, `image-${turnNumber}`);
    return request({
      type: "chat",
      sessionId: targetSessionId,
      input: { text, image },
    });
  }

  const firstTurnEvents = await sendTurn("old turn one");
  assert.ok(firstTurnEvents.every(
    (event) => event.type === "failed" || event.sessionId === sessionId,
  ));
  await sendTurn("old turn two");
  await sendTurn("kept turn three");
  await sendTurn("kept turn four");
  await sendTurn("next request");
  const otherCreated = await request({ type: "create_session" });
  const otherSessionId = otherCreated.find((event) => event.type === "session").session.id;
  await sendTurn("other session request", otherSessionId);
  await sendTurn("return to first session");

  const finalRequest = modelRequests.at(-1) as { input: unknown[] };
  const context = JSON.stringify(finalRequest.input);
  assert.match(context, /Summary of old turns/);
  assert.match(context, /kept turn three/);
  assert.match(context, /kept turn four/);
  assert.match(context, /next request/);
  assert.doesNotMatch(context, /old turn one/);
  assert.doesNotMatch(context, /old turn two/);
  assert.doesNotMatch(
    context,
    new RegExp(Buffer.from("image-2").toString("base64")),
  );
  assert.doesNotMatch(
    context,
    new RegExp(Buffer.from("image-3").toString("base64")),
  );
  assert.match(context, new RegExp(Buffer.from("image-4").toString("base64")));
  assert.match(context, new RegExp(Buffer.from("image-5").toString("base64")));
  assert.doesNotMatch(context, /other session request/);
  assert.doesNotMatch(JSON.stringify(modelRequests.at(-2)), /old turn one/);
  assert.match(
    JSON.stringify(summaryRequests[0]?.input),
    new RegExp(Buffer.from("image-2").toString("base64")),
  );
  assert.doesNotMatch(JSON.stringify(summaryRequests[0]?.input), /reasoning-1/);
  assert.equal(summaryRequests.length, 1);
  assert.equal(modelRequests.length, 7);
  assert.match(JSON.stringify(modelRequests[1]), /reasoning-1/);

  async function concurrentTurn(text: string, targetSessionId: string) {
    const image = join(directory, `${text.replaceAll(" ", "-")}.png`);
    await writeFile(image, text);
    await request({
      type: "chat",
      sessionId: targetSessionId,
      input: { text, image },
    });
    return text;
  }

  const differentSessionOrder: string[] = [];
  const slowDifferent = concurrentTurn("slow concurrent different", sessionId)
    .then((text) => differentSessionOrder.push(text));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const fastDifferent = concurrentTurn("fast concurrent different", otherSessionId)
    .then((text) => differentSessionOrder.push(text));
  await Promise.all([slowDifferent, fastDifferent]);
  assert.deepEqual(differentSessionOrder, [
    "fast concurrent different",
    "slow concurrent different",
  ]);

  const sameSessionOrder: string[] = [];
  const slowSame = concurrentTurn("slow concurrent same", sessionId)
    .then((text) => sameSessionOrder.push(text));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const fastSame = concurrentTurn("fast concurrent same", sessionId)
    .then((text) => sameSessionOrder.push(text));
  await Promise.all([slowSame, fastSame]);
  assert.deepEqual(sameSessionOrder, [
    "slow concurrent same",
    "fast concurrent same",
  ]);

  await assert.rejects(
    concurrentTurn("failed stream", sessionId),
    /stream ended before completion/i,
  );
  await concurrentTurn("after failed stream", sessionId);
  assert.doesNotMatch(JSON.stringify(modelRequests.at(-1)), /"text":"failed stream"/);
  const afterFailure = await request({ type: "load_session", sessionId });
  const failedTurn = afterFailure.find(
    (event) => event.type === "session",
  ).session.turns.find((turn: any) => turn.user === "failed stream");
  assert.equal(failedTurn.status, "failed");
  assert.equal(failedTurn.assistant, "partial answer");

  const persistedLines = (
    await readFile(join(sessionsDirectory, `${sessionId}.jsonl`), "utf8")
  ).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    Object.keys(persistedLines[0]).sort(),
    ["createdAt", "id", "title", "type"],
  );
  assert.ok(persistedLines.some((event) => event.type === "answer_delta"));
  assert.ok(persistedLines.some((event) => event.type === "turn_completed"));
  assert.ok(persistedLines.some((event) => event.type === "context_compacted"));

  agent.kill();
  await once(agent, "exit");
  const restartedAgent = spawn(process.execPath, ["agent/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_MODEL: "MiniMax-M3",
      OPENSCREEN_DATA_DIR: sessionsDirectory,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => restartedAgent.kill());
  const restartedRequests = new Map<string, {
    events: any[];
    resolve: (events: any[]) => void;
    reject: (error: Error) => void;
  }>();
  createInterface({ input: restartedAgent.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as { requestId: string; type: string; message?: string };
    const pendingRequest = restartedRequests.get(event.requestId);
    if (!pendingRequest) return;
    pendingRequest.events.push(event);
    if (event.type === "failed") pendingRequest.reject(new Error(event.message));
    if (event.type === "completed") pendingRequest.resolve(pendingRequest.events);
  });
  let restartedRequestNumber = 0;
  async function restartedRequest(payload: Record<string, unknown>) {
    const requestId = `restarted-${++restartedRequestNumber}`;
    const completed = new Promise<any[]>((resolve, reject) => {
      restartedRequests.set(requestId, { events: [], resolve, reject });
    });
    restartedAgent.stdin.write(`${JSON.stringify({ requestId, ...payload })}\n`);
    return completed;
  }

  const beforeRename = await restartedRequest({ type: "load_session", sessionId });
  assert.equal(
    beforeRename.find((event) => event.type === "session").session.title,
    "old turn one",
  );
  const renamed = await restartedRequest({
    type: "rename_session",
    sessionId,
    title: "  Work notes  ",
  });
  assert.equal(
    renamed.find((event) => event.type === "session").session.title,
    "Work notes",
  );
  const listed = await restartedRequest({ type: "list_sessions" });
  assert.equal(listed.find((event) => event.type === "sessions").sessions.length, 2);
  const loaded = await restartedRequest({ type: "load_session", sessionId });
  assert.equal(loaded.find((event) => event.type === "session").session.turns.length, 11);
});

async function readJSON(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}
