import OpenAI from "openai";

import type { RuntimeConfig } from "../config.js";
import type { InputEnvelope, OutputEnvelope } from "../protocol.js";
import {
  appendSessionEvents,
  loadSession,
  renameSession,
  type SessionEvent,
} from "../session/store.js";
import { compactIfNeeded, compactSession } from "./compaction.js";
import {
  countRequestTokens,
  countTurns,
  makeRequest,
  relayStream,
  summarizeTurns,
} from "./model.js";

const REQUEST_FAILED_MESSAGE = "Request failed. Please retry.";

type Emit = (event: OutputEnvelope & { sessionId: string }) => void;

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

export async function runChat(
  envelope: Extract<InputEnvelope, { type: "chat" }>,
  sessionsDirectory: string,
  client: OpenAI,
  model: string,
  context: RuntimeConfig["context"],
  emit: Emit,
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
        images: input.images,
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
      input.images,
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
      images: input.images,
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
