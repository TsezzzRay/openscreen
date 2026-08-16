import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";

import type {
  ApplicationCommand,
  ApplicationEvent,
  ApplicationHandler,
} from "../../src/application/api.js";
import {
  parseJsonlCommand,
  serializeJsonlEvent,
} from "../../src/transport/jsonl-codec.js";
import { serveJsonl } from "../../src/transport/jsonl-server.js";

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function envelopes(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Settlement =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown };

async function settleWithinImmediateTurns(
  promise: Promise<void>,
): Promise<Settlement | undefined> {
  let settlement: Settlement | undefined;
  void promise.then(
    () => {
      settlement = { status: "resolved" };
    },
    (error: unknown) => {
      settlement = { status: "rejected", error };
    },
  );
  for (let turn = 0; turn < 10 && settlement === undefined; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return settlement;
}

test("parses every product command with strict field validation", () => {
  const commands: ApplicationCommand[] = [
    { requestId: "1", type: "list_sessions" },
    { requestId: "2", type: "create_session" },
    { requestId: "3", type: "get_session", sessionId: "session" },
    {
      requestId: "4",
      type: "rename_session",
      sessionId: "session",
      name: "Renamed",
    },
    {
      requestId: "6",
      type: "prompt",
      sessionId: "session",
      input: {
        text: "hello",
        images: [
          { path: "/tmp/a.png", mimeType: "image/png" },
          { path: "/tmp/b.jpg", mimeType: "image/jpeg" },
        ],
      },
    },
    {
      requestId: "7",
      type: "abort",
      sessionId: "session",
      targetRequestId: "6",
    },
    {
      requestId: "8",
      type: "compact",
      sessionId: "session",
      instructions: "focus",
    },
    {
      requestId: "11",
      type: "set_thinking",
      sessionId: "session",
      thinking: "xhigh",
    },
  ];

  for (const command of commands) {
    assert.deepEqual(parseJsonlCommand(JSON.stringify(command)), command);
  }

  const invalid = [
    "null",
    "[]",
    "{}",
    '{"requestId":"1","type":"unknown"}',
    '{"requestId":"1","type":"list_sessions","extra":true}',
    '{"requestId":"1","type":"get_session","sessionId":7}',
    '{"requestId":"1","type":"prompt","sessionId":"s","input":{"text":"","images":[]}}',
    '{"requestId":"1","type":"prompt","sessionId":"s","input":{"text":"x","images":[{"path":"/a","mimeType":"image/gif"}]}}',
    '{"requestId":"1","type":"list_models"}',
    '{"requestId":"1","type":"set_model","sessionId":"s","model":{"provider":"p","id":"m"}}',
    '{"requestId":"1","type":"navigate","sessionId":"s","targetId":"node"}',
    '{"requestId":"1","type":"set_thinking","sessionId":"s","thinking":"ultra"}',
    '{"requestId":"1","type":"set_active_tools","sessionId":"s","toolNames":["read",3]}',
    '{"requestId":"1","type":"prompt","sessionId":"s","input":{"text":"x","sourceMessageId":"old"}}',
  ];
  for (const line of invalid) {
    assert.throws(() => parseJsonlCommand(line), /Invalid agent request/);
  }
});

test("serializes product events with request correlation", () => {
  assert.equal(
    serializeJsonlEvent("request-1", { type: "completed" }),
    '{"requestId":"request-1","type":"completed"}',
  );
});

test("serves independent requests concurrently and waits for them at EOF", async () => {
  let releaseSlow!: () => void;
  const slowRelease = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const handler: ApplicationHandler = {
    async execute(command, emit) {
      if (command.requestId === "slow") await slowRelease;
      await emit({ type: "sessions", sessions: [] });
      await emit({ type: "completed" });
    },
  };
  const input = Readable.from([
    '{"requestId":"slow","type":"list_sessions"}\n' +
      '{"requestId":"fast","type":"list_sessions"}\n',
  ]);
  const output = new PassThrough();
  const stderr = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const errorPromise = streamText(stderr);
  const serving = serveJsonl({ handler, input, output, stderr });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(envelopes(written), [
    { requestId: "fast", type: "sessions", sessions: [] },
    { requestId: "fast", type: "completed" },
  ]);
  releaseSlow();
  await serving;
  stderr.end();
  assert.deepEqual(envelopes(written), [
    { requestId: "fast", type: "sessions", sessions: [] },
    { requestId: "fast", type: "completed" },
    { requestId: "slow", type: "sessions", sessions: [] },
    { requestId: "slow", type: "completed" },
  ]);
  assert.equal(await errorPromise, "");
});

test("emits exactly one terminal envelope even when a handler emits duplicates", async () => {
  const handler: ApplicationHandler = {
    async execute(_command, emit) {
      await emit({ type: "failed", error: { code: "unknown", message: "first" } });
      await emit({ type: "completed" });
      throw new Error("late throw");
    },
  };
  const output = new PassThrough();
  const outputPromise = streamText(output);
  await serveJsonl({
    handler,
    input: Readable.from(['{"requestId":"one","type":"list_sessions"}\n']),
    output,
    stderr: new PassThrough(),
  });
  output.end();

  assert.deepEqual(envelopes(await outputPromise), [
    {
      requestId: "one",
      type: "failed",
      error: { code: "unknown", message: "first" },
    },
  ]);
});

test("atomically claims one terminal envelope from concurrent emissions", async () => {
  const handler: ApplicationHandler = {
    async execute(_command, emit) {
      await Promise.all([
        emit({
          type: "failed",
          error: { code: "unknown", message: "first terminal" },
        }),
        emit({ type: "completed" }),
      ]);
    },
  };
  const output = new PassThrough();
  const outputPromise = streamText(output);
  await serveJsonl({
    handler,
    input: Readable.from([
      '{"requestId":"concurrent-terminal","type":"list_sessions"}\n',
    ]),
    output,
    stderr: new PassThrough(),
  });
  output.end();

  assert.deepEqual(envelopes(await outputPromise), [
    {
      requestId: "concurrent-terminal",
      type: "failed",
      error: { code: "unknown", message: "first terminal" },
    },
  ]);
});

test("turns malformed lines with request ids into failures and others into stderr", async () => {
  const handler: ApplicationHandler = {
    async execute(_command, emit) {
      await emit({ type: "completed" });
    },
  };
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputPromise = streamText(output);
  const errorPromise = streamText(stderr);
  await serveJsonl({
    handler,
    input: Readable.from([
      '{"requestId":"bad","type":"get_session","sessionId":7}\n' +
        'not-json\n',
    ]),
    output,
    stderr,
  });
  output.end();
  stderr.end();

  assert.deepEqual(envelopes(await outputPromise), [
    {
      requestId: "bad",
      type: "failed",
      error: { code: "invalid-argument", message: "Invalid agent request" },
    },
  ]);
  assert.match(await errorPromise, /Invalid agent request/);
});

test("turns thrown handler errors into one neutral failure", async () => {
  const output = new PassThrough();
  const outputPromise = streamText(output);
  await serveJsonl({
    handler: {
      async execute() {
        throw new Error("handler failed");
      },
    },
      input: Readable.from(['{"requestId":"failure","type":"list_sessions"}\n']),
    output,
    stderr: new PassThrough(),
  });
  output.end();

  assert.deepEqual(envelopes(await outputPromise), [
    {
      requestId: "failure",
      type: "failed",
      error: { code: "unknown", message: "handler failed" },
    },
  ]);
});

test("rejects an asynchronous Writable failure without an unobserved error", async () => {
  let listenersAtFailure = 0;
  let writeAttempts = 0;
  let output!: Writable;
  output = new Writable({
    write(_chunk, _encoding, callback) {
      writeAttempts += 1;
      setImmediate(() => {
        listenersAtFailure = output.listenerCount("error");
        callback(new Error("output failed asynchronously"));
      });
    },
  });
  const observedErrors: Error[] = [];
  output.on("error", (error) => observedErrors.push(error));

  await assert.rejects(
    serveJsonl({
      handler: {
        async execute(_command, emit) {
          await emit({ type: "completed" });
        },
      },
      input: Readable.from([
        '{"requestId":"write-failure","type":"list_sessions"}\n',
      ]),
      output,
      stderr: new PassThrough(),
    }),
    /output failed asynchronously/,
  );
  assert.equal(observedErrors.length, 1);
  assert.equal(writeAttempts, 1);
  assert.ok(
    listenersAtFailure >= 2,
    "Transport must observe output errors independently of its caller",
  );
});

test("rejects promptly when output fails while input remains open", async () => {
  const input = new PassThrough();
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  let failWrite!: () => void;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      failWrite = () => callback(new Error("open-input output failure"));
      writeStarted();
    },
  });
  const serving = serveJsonl({
    handler: {
      async execute(_command, emit) {
        await emit({ type: "completed" });
      },
    },
    input,
    output,
    stderr: new PassThrough(),
  });
  input.write('{"requestId":"open-output","type":"list_sessions"}\n');
  await started;
  failWrite();

  const settlement = await settleWithinImmediateTurns(serving);
  input.end();
  await serving.catch(() => undefined);

  assert.equal(settlement?.status, "rejected");
  assert.match(
    String(settlement?.status === "rejected" ? settlement.error : ""),
    /open-input output failure/,
  );
  assert.equal(output.listenerCount("error"), 0);
});

test("rejects promptly when stderr fails while input remains open", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const serving = serveJsonl({
    handler: {
      async execute() {},
    },
    input,
    output,
    stderr,
  });
  stderr.destroy(new Error("open-input stderr failure"));

  const settlement = await settleWithinImmediateTurns(serving);
  input.end();
  await serving.catch(() => undefined);

  assert.equal(settlement?.status, "rejected");
  assert.match(
    String(settlement?.status === "rejected" ? settlement.error : ""),
    /open-input stderr failure/,
  );
  assert.equal(stderr.listenerCount("error"), 0);
});

test("waits for Writable acceptance with and without backpressure", async () => {
  const verifyAcceptance = async (highWaterMark: number) => {
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let acceptWrite!: () => void;
    const output = new Writable({
      highWaterMark,
      write(_chunk, _encoding, callback) {
        writeStarted();
        acceptWrite = callback;
      },
    });
    let settled = false;
    const serving = serveJsonl({
      handler: {
        async execute(_command, emit) {
          await emit({ type: "completed" });
        },
      },
      input: Readable.from([
        '{"requestId":"write-acceptance","type":"list_sessions"}\n',
      ]),
      output,
      stderr: new PassThrough(),
    }).finally(() => {
      settled = true;
    });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeAcceptance = settled;
    acceptWrite();
    await serving;
    assert.equal(settledBeforeAcceptance, false);
  };

  await verifyAcceptance(64 * 1024);
  await verifyAcceptance(1);
});
