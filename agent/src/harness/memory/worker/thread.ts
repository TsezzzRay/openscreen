import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

import OpenAI from "openai";

import type {
  MemoryWorkerData,
  MemoryWorkerRequest,
  MemoryWorkerResponse,
} from "./messages.js";
import {
  MemoryPipeline,
  type CapturedSessionSources,
} from "./runtime.js";
import { prepareMemoryWorkspace } from "../consolidate/workspace.js";

if (!parentPort) throw new Error("Memory worker requires a parent port");
const port = parentPort;
const data = workerData as MemoryWorkerData;
await prepareMemoryWorkspace(data.memoryRoot);
const pipeline = new MemoryPipeline({
  memoryRoot: data.memoryRoot,
  sessionsDirectory: data.sessionsDirectory,
  client: new OpenAI({ apiKey: data.apiKey, baseURL: data.baseURL }),
  model: data.model,
  workerId: `memory-worker:${process.pid}`,
  contextWindowTokens: data.contextWindowTokens,
  memory: data.memory,
});

let stopped = false;
let timer: NodeJS.Timeout | undefined;
let tickTask: Promise<void> | undefined;
let tickController: AbortController | undefined;
let tickRequested = false;
let startupSources: CapturedSessionSources[] | undefined;
let startupRecoveryTask: Promise<void> | undefined;
const backgroundController = new AbortController();
const inFlight = new Set<Promise<void>>();

function respond(message: MemoryWorkerResponse) {
  port.postMessage(message);
}

async function runTick() {
  if (tickTask) {
    tickRequested = true;
    return tickTask;
  }
  tickController = new AbortController();
  const running = (async () => {
    do {
      tickRequested = false;
      await pipeline.tick(tickController!.signal);
    } while (tickRequested && !stopped);
  })().finally(() => {
    if (tickTask === running) tickTask = undefined;
    tickController = undefined;
  });
  tickTask = running;
  return tickTask;
}

async function runScheduledWork() {
  if (startupSources) {
    if (!startupRecoveryTask) {
      const recovering = pipeline.ingestCapturedSessions(
        startupSources,
        backgroundController.signal,
      ).then(() => {
        startupSources = undefined;
      }).finally(() => {
        if (startupRecoveryTask === recovering) startupRecoveryTask = undefined;
      });
      startupRecoveryTask = recovering;
    }
    await startupRecoveryTask;
  }
  await runTick();
}

async function handle(message: Exclude<MemoryWorkerRequest, { type: "shutdown" }>) {
  if (stopped) {
    throw new Error("Memory worker is stopping");
  }
  switch (message.type) {
    case "observation":
      await pipeline.ingestObservation(message.observation);
      break;
    case "session":
      await pipeline.scanSession(message.sessionId, {
        includeInterrupted: false,
        signal: backgroundController.signal,
      });
      break;
    case "tick":
      await runScheduledWork();
      break;
    default: {
      const unknownMessage = message as { type?: unknown };
      throw new Error(
        `Unknown Memory Worker message type ${String(unknownMessage.type)}`,
      );
    }
  }
}

function track(message: MemoryWorkerRequest, operation: Promise<void>) {
  const internal = message.requestId.startsWith("timer:") ||
    message.requestId.startsWith("startup:");
  inFlight.add(operation);
  void operation.then(
    () => {
      if (!internal) respond({ type: "result", requestId: message.requestId });
    },
    (error) => respond({
      type: "error",
      ...(!internal ? { requestId: message.requestId } : {}),
      message: error instanceof Error ? error.message : "unknown memory worker error",
    }),
  ).finally(() => inFlight.delete(operation));
}

function dispatch(message: MemoryWorkerRequest) {
  if (message.type === "shutdown") {
    const prior = [...inFlight];
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    tickController?.abort("Memory worker is stopping");
    backgroundController.abort("Memory worker is stopping");
    const shutdown = Promise.allSettled(prior).then(() => {
      pipeline.close();
    });
    track(message, shutdown);
    return;
  }
  track(message, handle(message));
}

port.on("message", (message: MemoryWorkerRequest) => dispatch(message));

try {
  startupSources = await pipeline.captureSessionSources({ includeInterrupted: true });
  timer = setInterval(() => {
    if (!tickTask && !startupRecoveryTask) {
      dispatch({ type: "tick", requestId: `timer:${randomUUID()}` });
    }
  }, data.memory.worker.intervalMilliseconds);
  respond({ type: "ready" });
  const startupRequest: MemoryWorkerRequest = {
    type: "tick",
    requestId: `startup:${randomUUID()}`,
  };
  track(
    startupRequest,
    runScheduledWork(),
  );
} catch (error) {
  respond({
    type: "error",
    message: error instanceof Error ? error.message : "memory worker startup failed",
  });
  pipeline.close();
  throw error;
}
