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
  listSessions,
  loadSession,
  renameSession,
  saveSession,
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
};

type SessionSnapshot = SessionSummary & {
  turns: Array<{
    id?: string;
    user: string;
    assistant: string;
    reasoning?: string;
  }>;
};

type AgentOutput = OutputEnvelope | {
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
    turns: session.turns.map(({ id, user, assistant, reasoning }) => ({
      id,
      user,
      assistant,
      reasoning,
    })),
  };
}

function automaticTitle(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "New Chat";
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

  for await (const line of lines) {
    const envelope = JSON.parse(line) as InputEnvelope;
    const { requestId } = envelope;
    try {
      if (envelope.type === "list_sessions") {
        emit({ requestId, type: "sessions", sessions: await listSessions(sessionsDirectory) });
        emit({ requestId, type: "completed" });
        continue;
      }
      if (envelope.type === "create_session") {
        emit({ requestId, type: "session", session: snapshot(await createSession(sessionsDirectory)) });
        emit({ requestId, type: "completed" });
        continue;
      }
      if (envelope.type === "load_session") {
        emit({ requestId, type: "session", session: snapshot(
          await loadSession(sessionsDirectory, envelope.sessionId),
        ) });
        emit({ requestId, type: "completed" });
        continue;
      }
      if (envelope.type === "rename_session") {
        emit({ requestId, type: "session", session: snapshot(
          await renameSession(sessionsDirectory, envelope.sessionId, envelope.title),
        ) });
        emit({ requestId, type: "completed" });
        continue;
      }

      const session = await loadSession(sessionsDirectory, envelope.sessionId);
      const { input } = envelope;
      emit({ requestId, type: "started" });
      const compact = () => compactSession(
        session,
        context.keepRecentTokens,
        (turns) => countTurns(client, model, turns),
        (previousSummary, turns) => summarizeTurns(
          client,
          model,
          previousSummary,
          turns,
          context.summaryMaxOutputTokens,
        ),
      );
      const buildRequest = () => makeRequest(
        model,
        input.text,
        input.image,
        context.maxOutputTokens,
        session,
      );
      let request = await buildRequest();
      await compactIfNeeded(
        context.compactAtTokens,
        () => countRequestTokens(client, request),
        async () => {
          const compacted = await compact();
          request = await buildRequest();
          return compacted;
        },
      );
      const stream = await client.responses.create(request);
      const result = await relayStream(requestId, stream, emit);
      if (result !== null) {
        const wasEmpty = session.turns.length === 0;
        session.turns.push({
          id: requestId,
          user: input.text,
          assistant: result.output,
          reasoning: result.reasoning,
          screenshotPath: input.image,
          outputItems: result.outputItems,
        });
        if (wasEmpty && session.title === "New Chat") {
          session.title = automaticTitle(input.text);
        }
        session.updatedAt = new Date().toISOString();
        if ((result.totalTokens ?? 0) >= context.compactAtTokens) {
          try {
            await compact();
          } catch (error) {
            process.stderr.write(
              `Turn-end compaction deferred: ${error instanceof Error ? error.message : "unknown error"}\n`,
            );
          }
        }
        await saveSession(sessionsDirectory, session);
        emit({ requestId, type: "completed" });
      }
    } catch (error) {
      emit({
        requestId,
        type: "failed",
        message: error instanceof Error ? error.message : "Model request failed",
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
