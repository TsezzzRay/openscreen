import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { COMPACT_AT_TOKENS } from "./session.js";

test("rebuilds the agent process context after turn-end compaction", async (t) => {
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
      response.writeHead(200, { "content-type": "text/event-stream" });
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
    const image = join(directory, `${requestId}.png`);
    await writeFile(image, `image-${requestNumber}`);
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
  assert.doesNotMatch(
    context,
    new RegExp(Buffer.from("image-1").toString("base64")),
  );
  assert.doesNotMatch(
    context,
    new RegExp(Buffer.from("image-2").toString("base64")),
  );
  assert.match(context, new RegExp(Buffer.from("image-3").toString("base64")));
  assert.match(context, new RegExp(Buffer.from("image-4").toString("base64")));
  assert.match(
    JSON.stringify(summaryRequests[0]?.input),
    new RegExp(Buffer.from("image-1").toString("base64")),
  );
  assert.doesNotMatch(JSON.stringify(summaryRequests[0]?.input), /reasoning-1/);
  assert.equal(summaryRequests.length, 1);
  assert.equal(modelRequests.length, 5);
  assert.match(JSON.stringify(modelRequests[1]), /reasoning-1/);
});

async function readJSON(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}
