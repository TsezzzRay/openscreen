import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

import { runChat } from "./harness/session/runner.js";
import { loadRuntimeConfig } from "./config.js";
import {
  createSession,
  appendSessionEvents,
  listSessions,
  loadSession,
  renameSession,
} from "./harness/session/store.js";
import type {
  StoredSession,
} from "./harness/session/types.js";
import { withSessionLock } from "./harness/session/lock.js";
import { ScreenObservationExtension } from "./extensions/screen-observation/extension.js";
import {
  materializeTurnScreenContext,
  type ModelAccessibilityProjectionDiagnostics,
} from "./extensions/screen-observation/screen-context.js";
import { CaptureArtifactStore } from "./extensions/screen-observation/artifact-store.js";
import {
  CaptureDiagnostics,
  screenshotDiagnosticFields,
} from "./extensions/screen-observation/diagnostics.js";
import { MemoryWorkerClient } from "./harness/memory/worker/client.js";
import { createSystemToolRegistry } from "./tools/system/index.js";
import {
  parseInputEnvelope,
  serializeOutputEnvelope,
  type InputEnvelope,
  type OutputEnvelope,
  type SessionSnapshotPayload,
} from "./protocol.js";

function emit(event: OutputEnvelope) {
  process.stdout.write(`${serializeOutputEnvelope(event)}\n`);
}

export function startObservationInBackground(
  start: () => Promise<void>,
  onUnavailable: (error: unknown) => void,
) {
  void start().catch(onUnavailable);
}

function snapshot(session: StoredSession): SessionSnapshotPayload {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.visibleTurns.map(({ id, user, assistant, reasoning, status, images, error }) => ({
      id,
      user,
      assistant,
      reasoning,
      status,
      images,
      error,
    })),
  };
}

async function run() {
  const config = loadRuntimeConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const { model, context, session } = config;
  const defaultDataRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "OpenScreen",
  );
  const sessionsDirectory = process.env.OPENSCREEN_DATA_DIR ??
    join(defaultDataRoot, "sessions");
  const dataRoot = process.env.OPENSCREEN_DATA_DIR
    ? dirname(sessionsDirectory)
    : defaultDataRoot;
  const memoryRoot = process.env.OPENSCREEN_MEMORY_DIR ?? join(
    dataRoot,
    "memory",
  );
  const captureDiagnostics = new CaptureDiagnostics({
    directory: join(dataRoot, "diagnostics"),
    retentionMilliseconds:
      config.screenObservation.diagnostics.retentionMilliseconds,
  });
  const captureArtifactStore = new CaptureArtifactStore(dataRoot);
  const toolRegistry = createSystemToolRegistry({
    cwd: process.cwd(),
    outputDirectory: join(dataRoot, "tool-output"),
  });
  const memoryWorker = new MemoryWorkerClient({
    memoryRoot,
    sessionsDirectory,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model,
    contextWindowTokens: context.windowTokens,
    memory: config.memory,
  });
  try {
    await memoryWorker.ready();
  } catch (error) {
    process.stderr.write(
      `OpenScreen memory unavailable: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
  }
  const reportMemoryError = (error: unknown) => {
    process.stderr.write(
      `OpenScreen memory notification failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
  };
  const notifySessionMemory = (sessionId: string) => {
    void memoryWorker.scanSession(sessionId).catch(reportMemoryError);
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const observationBundleIdentifier = process.env.OPENSCREEN_BUNDLE_ID;
  const observationExtension = new ScreenObservationExtension({
    config: config.screenObservation,
    helperCommand: process.env.OPENSCREEN_HELPER_PATH ??
      join(process.cwd(), ".build", "debug", "ObservationHelper"),
    helperCurrentDirectory: process.cwd(),
    excludedProcessIdentifiers: [process.pid, process.ppid],
    excludedBundleIdentifiers: observationBundleIdentifier === undefined
      ? []
      : [observationBundleIdentifier],
    diagnostics: captureDiagnostics,
    persistArtifact: (artifact) => captureArtifactStore.persist(artifact),
    onObservation: async (observation) => {
      try {
        await memoryWorker.recordObservation(observation);
      } catch (error) {
        reportMemoryError(error);
        throw error;
      }
    },
  });
  startObservationInBackground(() => observationExtension.start(), (error) => {
    process.stderr.write(
      `OpenScreen observation unavailable: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
  });

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
              ...(envelope.input.images.length > 0 ? { images: envelope.input.images } : {}),
              startedAt: new Date().toISOString(),
            },
          },
          envelope.status === "cancelled"
            ? {
                type: "turn_cancelled",
                turnId: envelope.requestId,
                finishedAt: new Date().toISOString(),
              }
            : {
                type: "turn_failed",
                turnId: envelope.requestId,
                finishedAt: new Date().toISOString(),
                message: "Request failed. Please retry.",
                includeInContext: true,
              },
        ]);
        notifySessionMemory(envelope.sessionId);
        emit({ requestId, sessionId: envelope.sessionId, type: "completed" });
        return;
      }
      let screenContext;
      try {
        let accessibilityProjection:
          | ModelAccessibilityProjectionDiagnostics
          | undefined;
        const resolved = await observationExtension.captureForRequest(
          requestId,
          signal,
        );
        screenContext = await materializeTurnScreenContext(
          dataRoot,
          resolved.capture.artifact,
          resolved.observation?.observationId,
          (diagnostics) => {
            accessibilityProjection = diagnostics;
          },
          {
            intentRevision: resolved.capture.intentRevision,
            intentContentEpoch: resolved.capture.intentContentEpoch,
          },
        );
        const screenshot = resolved.capture.artifact.result.screenshot;
        captureDiagnostics.emit({
          event: "chat.context_attached",
          requestId,
          captureId: resolved.capture.artifact.captureId,
          ...(resolved.observation === undefined
            ? {}
            : { observationId: resolved.observation.observationId }),
          activityRevision: resolved.capture.intentRevision,
          intentRevision: resolved.capture.intentRevision,
          artifactRevision: resolved.capture.artifact.activityRevision,
          completedRevision:
            resolved.capture.artifact.completedActivityRevision,
          contentEpoch: resolved.capture.intentContentEpoch,
          intentContentEpoch: resolved.capture.intentContentEpoch,
          artifactContentEpoch:
            resolved.capture.artifact.contentEpoch,
          completedContentEpoch:
            resolved.capture.artifact.completedContentEpoch,
          status: resolved.capture.artifact.status,
          contextMode: screenContextMode(screenContext),
          ...screenshotDiagnosticFields(screenshot),
          accessibility: {
            status: resolved.capture.artifact.result.accessibility.status,
            ...(resolved.capture.artifact.result.accessibility.quality === undefined
              ? {}
              : {
                  quality:
                    resolved.capture.artifact.result.accessibility.quality,
                }),
            ...(resolved.capture.artifact.result.accessibility.contentRootFound === undefined
              ? {}
              : {
                  contentRootFound:
                    resolved.capture.artifact.result.accessibility.contentRootFound,
                }),
            ...(resolved.capture.artifact.result.accessibility.semanticNodeCount === undefined
              ? {}
              : {
                  semanticNodeCount:
                    resolved.capture.artifact.result.accessibility.semanticNodeCount,
                }),
            ...(resolved.capture.artifact.result.accessibility.activation === undefined
              ? {}
              : {
                  activationStatus:
                    resolved.capture.artifact.result.accessibility.activation.status,
                  activationAttempts:
                    resolved.capture.artifact.result.accessibility.activation.attempts,
                  activationWaitMs:
                    resolved.capture.artifact.result.accessibility.activation.waitMilliseconds,
                }),
            ...(resolved.capture.artifact.result.accessibility.failureReason === undefined
              ? {}
              : {
                  failureReason:
                    resolved.capture.artifact.result.accessibility.failureReason,
                }),
            ...(resolved.capture.artifact.result.accessibility.snapshot === undefined
              ? {}
              : {
                  nodeCount:
                    resolved.capture.artifact.result.accessibility.snapshot.nodeCount,
                }),
            ...accessibilityProjection,
          },
        });
      } catch (error) {
        captureDiagnostics.emit({
          event: "chat.context_attached",
          requestId,
          contextMode: "none",
          result: "unavailable",
          reason: signal?.aborted ? "request_cancelled" : "capture_unavailable",
        });
        if (!signal?.aborted) {
          process.stderr.write(
            `OpenScreen request screen context unavailable: ${
              error instanceof Error ? error.message : "unknown error"
            }\n`,
          );
        }
      }
      const toolSnapshot = toolRegistry.getSnapshot();
      await runChat(
        {
          requestId: envelope.requestId,
          sessionId: envelope.sessionId,
          input: {
            ...envelope.input,
            ...(screenContext === undefined ? {} : { screenContext }),
          },
        },
        sessionsDirectory,
        client,
        model,
        context,
        session,
        emit,
        signal!,
        [...toolSnapshot.tools],
        memoryRoot,
        toolSnapshot.capabilityPrompt,
      );
      notifySessionMemory(envelope.sessionId);
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

  try {
    for await (const line of lines) {
      try {
        const envelope = parseInputEnvelope(line);
        dispatch(envelope);
      } catch (error) {
        process.stderr.write(
          `Invalid agent request: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      }
    }
    await Promise.allSettled([...active]);
  } finally {
    await observationExtension.stop();
    await memoryWorker.stop();
    await captureDiagnostics.flush();
  }
}

function screenContextMode(context: {
  ref: { image?: unknown };
  accessibility?: unknown;
}) {
  if (context.ref.image !== undefined && context.accessibility !== undefined) {
    return "both" as const;
  }
  if (context.ref.image !== undefined) return "screenshot_only" as const;
  if (context.accessibility !== undefined) return "ax_only" as const;
  return "none" as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
