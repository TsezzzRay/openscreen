import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

import { loadRuntimeConfig } from "./config.js";
import {
  countRequestTokens,
  countTurns,
  makeRequest,
  relayStream,
  summarizeTurns,
  type OutputEnvelope,
} from "./model.js";
import {
  compactIfNeeded,
  compactSession,
  createSession,
  appendSessionEvents,
  listSessions,
  loadSession,
  renameSession,
  withSessionLock,
  type SessionEvent,
  type SessionSummary,
  type StoredSession,
} from "./session.js";

type InputEnvelope = {
  requestId: string;
  type: "chat";
  sessionId: string;
  input: {
    text: string;
    image: string;
  };
} | {
  requestId: string;
  type: "list_sessions";
} | {
  requestId: string;
  type: "create_session";
} | {
  requestId: string;
  type: "load_session";
  sessionId: string;
} | {
  requestId: string;
  type: "rename_session";
  sessionId: string;
  title: string;
} | {
  requestId: string;
  type: "cancel";
  sessionId: string;
  targetRequestId: string;
} | {
  requestId: string;
  type: "record_attempt";
  sessionId: string;
  input: { text: string };
  status: "failed" | "cancelled";
};

type SessionSnapshot = SessionSummary & {
  turns: Array<{
    id: string;
    user: string;
    assistant: string;
    reasoning?: string;
    status: "completed" | "failed" | "cancelled" | "interrupted";
    error?: string;
  }>;
};

type AgentOutput = (OutputEnvelope & { sessionId?: string }) | {
  requestId: string;
  type: "sessions";
  sessions: SessionSummary[];
} | {
  requestId: string;
  type: "session";
  session: SessionSnapshot;
};

const REQUEST_FAILED_MESSAGE = "Request failed. Please retry.";

function emit(event: AgentOutput) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function snapshot(session: StoredSession): SessionSnapshot {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.visibleTurns.map(({ id, user, assistant, reasoning, status, error }) => ({
      id,
      user,
      assistant,
      reasoning,
      status,
      error,
    })),
  };
}

function automaticTitle(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "New Chat";
}

class EventBatcher {
  private events: SessionEvent[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private writes = Promise.resolve();
  private error: unknown;

  constructor(
    private readonly directory: string,
    private readonly sessionId: string,
  ) {}

  add(event: SessionEvent) {
    this.events.push(event);
    this.bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (this.bytes >= 4_096) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    this.writes = this.writes.then(async () => {
      if (this.error) return;
      try {
        await appendSessionEvents(this.directory, this.sessionId, events);
      } catch (error) {
        this.error = error;
      }
    });
  }

  async close() {
    this.flush();
    await this.writes;
    if (this.error) throw this.error;
  }
}

async function runChat(
  envelope: Extract<InputEnvelope, { type: "chat" }>,
  sessionsDirectory: string,
  client: OpenAI,
  model: string,
  context: ReturnType<typeof loadRuntimeConfig>["context"],
  signal: AbortSignal,
) {
  const { requestId, sessionId, input } = envelope;
  let turnStarted = false;
  let terminalStarted = false;
  let failureEmitted = false;
  let failureMessage = REQUEST_FAILED_MESSAGE;
  const fail = (message: string) => {
    failureEmitted = true;
    failureMessage = message;
    emit({ requestId, sessionId, type: "failed", message });
  };
  const finishCancelled = async () => {
    if (!signal.aborted) return false;
    if (turnStarted && !terminalStarted) {
      await appendSessionEvents(sessionsDirectory, sessionId, [{
        type: "turn_cancelled",
        turnId: requestId,
      }]);
      terminalStarted = true;
    }
    emit({ requestId, sessionId, type: "cancelled" });
    return true;
  };

  try {
    const session = await loadSession(sessionsDirectory, sessionId);
    await appendSessionEvents(sessionsDirectory, sessionId, [{
      type: "turn_started",
      turn: {
        id: requestId,
        user: input.text,
        screenshotPath: input.image,
        startedAt: new Date().toISOString(),
      },
    }]);
    turnStarted = true;
    emit({ requestId, sessionId, type: "started" });
    if (await finishCancelled()) return;

    const compact = async () => {
      const compacted = await compactSession(
        session,
        context.keepRecentTokens,
        (turns) => countTurns(client, model, turns, undefined, signal),
        (previousSummary, turns) => summarizeTurns(
          client,
          model,
          previousSummary,
          turns,
          context.summaryMaxOutputTokens,
          undefined,
          signal,
        ),
      );
      if (compacted) {
        await appendSessionEvents(sessionsDirectory, sessionId, [{
          type: "context_compacted",
          summary: session.summary!,
          firstKeptTurnIndex: session.firstKeptTurnIndex,
        }]);
      }
      return compacted;
    };
    const buildRequest = () => makeRequest(
      model,
      input.text,
      input.image,
      context.maxOutputTokens,
      session,
    );
    let request = await buildRequest();
    if (await finishCancelled()) return;
    await compactIfNeeded(
      context.compactAtTokens,
      () => countRequestTokens(client, request, signal),
      async () => {
        const compacted = await compact();
        request = await buildRequest();
        return compacted;
      },
    );
    if (await finishCancelled()) return;

    const stream = await client.responses.create(request, { signal });
    const batcher = new EventBatcher(sessionsDirectory, sessionId);
    let result: Awaited<ReturnType<typeof relayStream>>;
    try {
      result = await relayStream(requestId, stream, (event) => {
        if (event.type === "failed") {
          if (signal.aborted) return;
          process.stderr.write(`Model request failed: ${event.message ?? "unknown error"}\n`);
          failureEmitted = true;
          failureMessage = REQUEST_FAILED_MESSAGE;
          emit({ requestId, sessionId, type: "failed", message: failureMessage });
          return;
        }
        emit({ ...event, sessionId });
        if (event.type === "reasoning_delta" || event.type === "answer_delta") {
          batcher.add({ type: event.type, turnId: requestId, delta: event.delta ?? "" });
        }
      });
    } finally {
      await batcher.close();
    }

    if (result === null) {
      if (await finishCancelled()) return;
      terminalStarted = true;
      await appendSessionEvents(sessionsDirectory, sessionId, [{
        type: "turn_failed",
        turnId: requestId,
        message: failureMessage,
        includeInContext: true,
      }]);
      return;
    }

    const wasEmpty = session.turns.length === 0;
    const turn = {
      id: requestId,
      user: input.text,
      assistant: result.output,
      reasoning: result.reasoning,
      screenshotPath: input.image,
      outputItems: result.outputItems,
      status: "completed" as const,
    };
    terminalStarted = true;
    await appendSessionEvents(sessionsDirectory, sessionId, [{ type: "turn_completed", turn }]);
    session.turns.push(turn);
    if (wasEmpty && session.title === "New Chat") {
      try {
        await renameSession(sessionsDirectory, sessionId, automaticTitle(input.text));
      } catch (error) {
        process.stderr.write(
          `Automatic title update deferred: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      }
    }
    if ((result.totalTokens ?? 0) >= context.compactAtTokens) {
      try {
        await compact();
      } catch (error) {
        process.stderr.write(
          `Turn-end compaction deferred: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      }
    }
    emit({ requestId, sessionId, type: "completed" });
  } catch (error) {
    if (await finishCancelled()) return;
    process.stderr.write(
      `Model request failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    const message = REQUEST_FAILED_MESSAGE;
    if (turnStarted && !terminalStarted) {
      try {
        await appendSessionEvents(sessionsDirectory, sessionId, [{
          type: "turn_failed",
          turnId: requestId,
          message,
          includeInContext: true,
        }]);
      } catch (persistenceError) {
        process.stderr.write(
          `Failed to persist turn failure: ${persistenceError instanceof Error ? persistenceError.message : "unknown error"}\n`,
        );
      }
    }
    if (!failureEmitted) fail(message);
  }
}

async function run() {
  const config = loadRuntimeConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const { model, context } = config;
  const sessionsDirectory = process.env.OPENSCREEN_DATA_DIR ?? join(
    homedir(),
    "Library",
    "Application Support",
    "OpenScreen",
    "sessions",
  );
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const sessionQueues = new Map<string, Promise<void>>();
  const activeRequests = new Map<string, { sessionId: string; controller: AbortController }>();
  const active = new Set<Promise<void>>();

  const handle = async (envelope: InputEnvelope, signal?: AbortSignal) => {
    const { requestId } = envelope;
    try {
      if (envelope.type === "list_sessions") {
        emit({ requestId, type: "sessions", sessions: await listSessions(sessionsDirectory) });
        emit({ requestId, type: "completed" });
        return;
      }
      if (envelope.type === "create_session") {
        emit({ requestId, type: "session", session: snapshot(await createSession(sessionsDirectory)) });
        emit({ requestId, type: "completed" });
        return;
      }
      if (envelope.type === "load_session") {
        emit({ requestId, type: "session", session: snapshot(
          await loadSession(sessionsDirectory, envelope.sessionId),
        ) });
        emit({ requestId, type: "completed" });
        return;
      }
      if (envelope.type === "rename_session") {
        emit({ requestId, type: "session", session: snapshot(
          await renameSession(sessionsDirectory, envelope.sessionId, envelope.title),
        ) });
        emit({ requestId, type: "completed" });
        return;
      }
      if (envelope.type === "cancel") {
        const target = activeRequests.get(envelope.targetRequestId);
        if (target?.sessionId === envelope.sessionId) target.controller.abort();
        emit({ requestId, sessionId: envelope.sessionId, type: "completed" });
        return;
      }
      if (envelope.type === "record_attempt") {
        await appendSessionEvents(sessionsDirectory, envelope.sessionId, [
          {
            type: "turn_started",
            turn: {
              id: envelope.requestId,
              user: envelope.input.text,
              startedAt: new Date().toISOString(),
            },
          },
          envelope.status === "cancelled"
            ? { type: "turn_cancelled", turnId: envelope.requestId }
            : {
                type: "turn_failed",
                turnId: envelope.requestId,
                message: "Request failed. Please retry.",
                includeInContext: true,
              },
        ]);
        emit({ requestId, sessionId: envelope.sessionId, type: "completed" });
        return;
      }
      await runChat(envelope, sessionsDirectory, client, model, context, signal!);
    } catch (error) {
      emit({
        requestId,
        type: "failed",
        message: error instanceof Error ? error.message : "Model request failed",
      });
    }
  };

  const dispatch = (envelope: InputEnvelope) => {
    if ("sessionId" in envelope) envelope.sessionId = envelope.sessionId.toLowerCase();
    let task: Promise<void>;
    if (envelope.type === "chat") {
      const sessionId = envelope.sessionId;
      const controller = new AbortController();
      activeRequests.set(envelope.requestId, { sessionId, controller });
      const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
      task = previous.catch(() => {}).then(() => withSessionLock(
        sessionsDirectory,
        sessionId,
        () => handle(envelope, controller.signal),
      )).catch((error) => {
        emit({
          requestId: envelope.requestId,
          sessionId,
          type: "failed",
          message: error instanceof Error ? error.message : "Session lock failed",
        });
      });
      sessionQueues.set(sessionId, task);
      void task.finally(() => {
        if (activeRequests.get(envelope.requestId)?.controller === controller) {
          activeRequests.delete(envelope.requestId);
        }
        if (sessionQueues.get(sessionId) === task) sessionQueues.delete(sessionId);
      });
    } else if (envelope.type === "rename_session" || envelope.type === "record_attempt") {
      const sessionId = envelope.sessionId;
      const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
      task = previous.catch(() => {}).then(() => withSessionLock(
        sessionsDirectory,
        sessionId,
        () => handle(envelope),
      )).catch((error) => {
        emit({
          requestId: envelope.requestId,
          sessionId,
          type: "failed",
          message: error instanceof Error ? error.message : "Session lock failed",
        });
      });
      sessionQueues.set(sessionId, task);
      void task.finally(() => {
        if (sessionQueues.get(sessionId) === task) sessionQueues.delete(sessionId);
      });
    } else {
      task = handle(envelope);
    }
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  for await (const line of lines) {
    try {
      dispatch(JSON.parse(line) as InputEnvelope);
    } catch (error) {
      process.stderr.write(
        `Invalid agent request: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
  }
  await Promise.allSettled([...active]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
