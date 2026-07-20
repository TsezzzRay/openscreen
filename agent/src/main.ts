import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

import { runChat } from "./chat/runner.js";
import { loadRuntimeConfig } from "./config.js";
import {
  createSession,
  appendSessionEvents,
  listSessions,
  loadSession,
  renameSession,
  type SessionSummary,
  type StoredSession,
} from "./session/store.js";
import { withSessionLock } from "./session/lock.js";
import {
  parseInputEnvelope,
  type InputEnvelope,
  type OutputEnvelope,
} from "./protocol.js";

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
      await runChat(envelope, sessionsDirectory, client, model, context, emit, signal!);
    } catch (error) {
      emit({
        requestId,
        type: "failed",
        message: error instanceof Error ? error.message : "Model request failed",
      });
    }
  };

  const dispatch = (envelope: InputEnvelope) => {
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
      dispatch(parseInputEnvelope(line));
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
