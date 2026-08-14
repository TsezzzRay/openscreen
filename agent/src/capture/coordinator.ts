import { createHash, randomUUID } from "node:crypto";

import type {
  NativeActivitySignal,
  NativeCaptureResult,
  WindowMetadata,
} from "./native/protocol.js";
import type {
  CaptureArtifact,
  CaptureArtifactPersistence,
  CaptureArtifactStatus,
  CaptureResolution,
} from "./artifact.js";
import {
  screenshotDiagnosticFields,
  type CaptureDiagnosticEvent,
  type CaptureDiagnosticsSink,
} from "./diagnostics.js";

export type CaptureConsumer = "activity" | "request";

export type FrozenCaptureTarget = {
  activityRevision: number;
  contentEpoch: number;
  signal: NativeActivitySignal;
  target: WindowMetadata;
};

type CaptureCoordinatorOptions = {
  reuseWindowMilliseconds: number;
  capture: (target: WindowMetadata) => Promise<NativeCaptureResult>;
  now?: () => number;
  makeCaptureId?: () => string;
  diagnostics?: CaptureDiagnosticsSink;
  persistArtifact?: (
    artifact: CaptureArtifact,
  ) => Promise<CaptureArtifactPersistence>;
};

type CaptureDiagnosticContext = {
  intentId: string;
  consumer: CaptureConsumer;
  activityRevision: number;
  contentEpoch: number;
  activityKind: NativeActivitySignal["kind"];
  targetKey: string;
};

type CaptureDiagnosticDetails = Omit<
  CaptureDiagnosticEvent,
  "intentId" | "requestId" | "consumer" | "activityRevision" | "targetKey"
>;

export class CaptureInvalidatedError extends Error {
  constructor() {
    super("Capture invalidated because the foreground target changed");
    this.name = "CaptureInvalidatedError";
  }
}

export class CaptureCoordinator {
  private activityRevision = 0;
  private contentEpoch = 0;
  private latest?: FrozenCaptureTarget;
  private readonly frozenBySignal = new WeakMap<
    NativeActivitySignal,
    FrozenCaptureTarget
  >();
  private completed?: CaptureArtifact;
  private readonly inFlight = new Map<string, {
    captureId: string;
    promise: Promise<CaptureArtifact>;
    consumers: { count: number };
  }>();
  private queue = Promise.resolve();
  private readonly now: () => number;
  private readonly makeCaptureId: () => string;
  private readonly targetSalt = randomUUID();

  constructor(private readonly options: CaptureCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.makeCaptureId = options.makeCaptureId ?? randomUUID;
  }

  observe(
    signal: NativeActivitySignal,
    options: { contentChanged?: boolean } = {},
  ): FrozenCaptureTarget {
    this.activityRevision += 1;
    if (
      options.contentChanged ?? isContentActivityKind(signal.kind)
    ) this.contentEpoch += 1;
    const frozen = {
      activityRevision: this.activityRevision,
      contentEpoch: this.contentEpoch,
      signal,
      target: signal.window,
    };
    if (signal.window.windowIdentifier !== undefined) {
      this.latest = frozen;
    } else if (this.latest !== undefined) {
      const invalidated = this.latest;
      this.latest = undefined;
      if (
        this.completed !== undefined &&
        sameWindowIdentity(this.completed.target, invalidated.target)
      ) {
        this.completed = undefined;
      }
      this.options.diagnostics?.emit({
        event: "target_invalidated",
        consumer: "activity",
        activityRevision: this.activityRevision,
        contentEpoch: this.contentEpoch,
        activityKind: signal.kind,
        targetKey: this.targetKey(invalidated.target),
        reason: "missing_window_identifier",
      });
    }
    this.frozenBySignal.set(signal, frozen);
    return frozen;
  }

  freezeLatest() {
    return this.latest;
  }

  frozenFor(signal: NativeActivitySignal) {
    return this.frozenBySignal.get(signal);
  }

  capture(
    consumer: CaptureConsumer,
    frozen: FrozenCaptureTarget,
    intentId: string = randomUUID(),
    consumerSignal?: AbortSignal,
  ): Promise<CaptureResolution> {
    const key = captureKey(frozen);
    const targetKey = this.targetKey(frozen.target);
    const diagnosticContext = {
      intentId,
      consumer,
      activityRevision: frozen.activityRevision,
      contentEpoch: frozen.contentEpoch,
      activityKind: frozen.signal.kind,
      targetKey,
    };
    this.emitDiagnostic(diagnosticContext, {
      event: "capture.intent_received",
    });
    if (consumerSignal?.aborted) {
      this.emitConsumerCancelled(diagnosticContext);
      return Promise.reject(consumerCancelledError());
    }
    if (frozen.target.windowIdentifier === undefined) {
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.decision",
        decision: "unavailable",
        reason: "missing_window_identifier",
      });
      return Promise.reject(
        new Error("Frozen capture target has no exact window identifier"),
      );
    }
    if (!this.isCurrentTarget(frozen)) {
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.decision",
        decision: "unavailable",
        reason: "target_changed",
      });
      return Promise.reject(new CaptureInvalidatedError());
    }
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) {
      inFlight.consumers.count += 1;
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.decision",
        captureId: inFlight.captureId,
        decision: "join",
        reason: "same_frozen_target_in_flight",
      });
      return this.waitForConsumer(inFlight.promise.then((artifact) => ({
        decision: "join",
        intentRevision: frozen.activityRevision,
        intentContentEpoch: frozen.contentEpoch,
        intentActivityKind: frozen.signal.kind,
        artifact,
      })), consumerSignal, {
        ...diagnosticContext,
        captureId: inFlight.captureId,
      });
    }

    const completed = this.completed;
    if (
      completed !== undefined &&
      captureKey(completed) === key &&
      this.isCurrentTarget(frozen) &&
      this.now() - completed.completedAtMilliseconds <=
        this.options.reuseWindowMilliseconds
    ) {
      const cachedAgeMs = this.now() - completed.completedAtMilliseconds;
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.decision",
        captureId: completed.captureId,
        decision: "reuse",
        reason: "fresh_completed_capture",
        cachedAgeMs,
      });
      return this.waitForConsumer(
        Promise.resolve({
          decision: "reuse",
          intentRevision: frozen.activityRevision,
          intentContentEpoch: frozen.contentEpoch,
          intentActivityKind: frozen.signal.kind,
          artifact: completed,
        }),
        consumerSignal,
        {
          ...diagnosticContext,
          captureId: completed.captureId,
        },
      );
    }

    const captureId = this.makeCaptureId();
    const queuedAt = this.now();
    const consumers = { count: 1 };
    this.emitDiagnostic(diagnosticContext, {
      event: "capture.decision",
      captureId,
      decision: "new",
      reason: "no_reusable_capture",
    });
    const physicalCapture = this.enqueue(() => this.performCapture(
      frozen,
      captureId,
      diagnosticContext,
      queuedAt,
      consumers,
    ));
    this.inFlight.set(key, { captureId, promise: physicalCapture, consumers });
    const clear = () => {
      if (this.inFlight.get(key)?.promise === physicalCapture) {
        this.inFlight.delete(key);
      }
    };
    void physicalCapture.then(clear, clear);
    return this.waitForConsumer(
      physicalCapture.then((artifact) => ({
        decision: "new",
        intentRevision: frozen.activityRevision,
        intentContentEpoch: frozen.contentEpoch,
        intentActivityKind: frozen.signal.kind,
        artifact,
      })),
      consumerSignal,
      { ...diagnosticContext, captureId },
    );
  }

  private waitForConsumer(
    resolution: Promise<CaptureResolution>,
    signal: AbortSignal | undefined,
    context: CaptureDiagnosticContext & {
      captureId: string;
    },
  ) {
    if (signal === undefined) return resolution;
    return new Promise<CaptureResolution>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.emitConsumerCancelled(context, context.captureId);
        reject(consumerCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      resolution.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private emitConsumerCancelled(
    context: CaptureDiagnosticContext,
    captureId?: string,
  ) {
    this.emitDiagnostic(context, {
      event: "capture.consumer_cancelled",
      ...(captureId === undefined ? {} : { captureId }),
      reason: "consumer_aborted",
    });
  }

  private emitDiagnostic(
    context: CaptureDiagnosticContext,
    details: CaptureDiagnosticDetails,
  ) {
    this.options.diagnostics?.emit({
      ...details,
      intentId: context.intentId,
      ...(context.consumer === "request"
        ? { requestId: context.intentId }
        : {}),
      consumer: context.consumer,
      activityRevision: context.activityRevision,
      intentRevision: context.activityRevision,
      contentEpoch: context.contentEpoch,
      intentContentEpoch: context.contentEpoch,
      activityKind: context.activityKind,
      targetKey: context.targetKey,
    });
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performCapture(
    frozen: FrozenCaptureTarget,
    captureId: string,
    diagnosticContext: CaptureDiagnosticContext,
    queuedAt: number,
    consumers: { count: number },
  ): Promise<CaptureArtifact> {
    const startedAt = this.now();
    const queueWaitMs = Math.max(0, startedAt - queuedAt);
    try {
      this.assertCurrentTarget(frozen);
    } catch (error) {
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.skipped",
        captureId,
        queueWaitMs,
        reason: "target_changed",
      });
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.completed",
        captureId,
        queueWaitMs,
        totalMs: 0,
        servedConsumerCount: consumers.count,
        status: "failed",
        reason: "target_changed",
      });
      throw error;
    }
    this.emitDiagnostic(diagnosticContext, {
      event: "capture.started",
      captureId,
      queueWaitMs,
    });
    try {
      const result = await this.options.capture(frozen.target);
      if (!sameWindowIdentity(result.window, frozen.target)) {
        this.emitDiagnostic(diagnosticContext, {
          event: "capture.attestation_failed",
          captureId,
          reason: "target_identity_mismatch",
        });
        throw new Error("Capture target identity mismatch");
      }
      try {
        this.assertCurrentTarget(frozen);
      } catch (error) {
        this.emitDiagnostic(diagnosticContext, {
          event: "capture.attestation_failed",
          captureId,
          reason: "target_changed",
        });
        throw error;
      }
      const completedAtMilliseconds = this.now();
      const artifact: CaptureArtifact = {
        captureId,
        activityRevision: frozen.activityRevision,
        completedActivityRevision: this.activityRevision,
        contentEpoch: frozen.contentEpoch,
        completedContentEpoch: this.contentEpoch,
        signal: frozen.signal,
        target: frozen.target,
        result,
        status: artifactStatus(result),
        completedAtMilliseconds,
      };
      let persistenceMs: number | undefined;
      if (this.options.persistArtifact !== undefined) {
        const persistenceStartedAt = this.now();
        try {
          artifact.persistence = await this.options.persistArtifact(artifact);
          persistenceMs = Math.max(0, this.now() - persistenceStartedAt);
        } catch {
          persistenceMs = Math.max(0, this.now() - persistenceStartedAt);
          this.emitDiagnostic(diagnosticContext, {
            event: "capture.persistence_failed",
            captureId,
            persistenceMs,
            reason: "artifact_persistence_failed",
          });
        }
      }
      this.completed = artifact;
      const screenshot = result.screenshot;
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.completed",
        captureId,
        queueWaitMs,
        preflightMs: result.validation.preflightDurationMilliseconds,
        screenshotMs: screenshot.durationMilliseconds,
        accessibilityMs: result.accessibility.durationMilliseconds,
        attestationMs: result.validation.attestationDurationMilliseconds,
        totalMs: Math.max(0, completedAtMilliseconds - startedAt),
        ...(persistenceMs === undefined ? {} : { persistenceMs }),
        servedConsumerCount: consumers.count,
        ...(result.startedAt === undefined
          ? {}
          : { captureStartedAt: result.startedAt }),
        ...(screenshot.completedAt === undefined
          ? {}
          : { screenshotCompletedAt: screenshot.completedAt }),
        ...(result.accessibility.completedAt === undefined
          ? {}
          : {
            accessibilityCompletedAt:
              result.accessibility.completedAt,
          }),
        captureCompletedAt: result.capturedAt,
        status: artifact.status,
        artifactRevision: artifact.activityRevision,
        completedRevision: artifact.completedActivityRevision,
        contentEpoch: artifact.contentEpoch,
        artifactContentEpoch: artifact.contentEpoch,
        completedContentEpoch: artifact.completedContentEpoch,
        activityRevisionEnd: this.activityRevision,
        activityChangedDuringCapture:
          this.activityRevision !== frozen.activityRevision,
        ...(result.windowGroup === undefined
          ? {}
          : {
            rootWindowIdentifier: result.windowGroup.rootWindowIdentifier,
            memberWindowCount:
              result.windowGroup.memberWindowIdentifiers.length,
          }),
        ...screenshotDiagnosticFields(screenshot),
        accessibility: {
          status: result.accessibility.status,
          ...(result.accessibility.quality === undefined
            ? {}
            : { quality: result.accessibility.quality }),
          ...(result.accessibility.contentRootFound === undefined
            ? {}
            : { contentRootFound: result.accessibility.contentRootFound }),
          ...(result.accessibility.semanticNodeCount === undefined
            ? {}
            : { semanticNodeCount: result.accessibility.semanticNodeCount }),
          ...(result.accessibility.usefulTextCharacters === undefined
            ? {}
            : {
              usefulTextCharacters:
                result.accessibility.usefulTextCharacters,
            }),
          ...(result.accessibility.failureReason === undefined
            ? {}
            : { failureReason: result.accessibility.failureReason }),
          ...(result.accessibility.snapshot === undefined
            ? {}
            : {
              nodeCount: result.accessibility.snapshot.nodeCount,
              truncated: result.accessibility.snapshot.truncated,
            }),
          ...(result.accessibility.windowIdentifiers === undefined
            ? {}
            : {
              capturedWindowCount:
                result.accessibility.windowIdentifiers.length,
            }),
          ...(result.accessibility.missingWindowIdentifiers === undefined
            ? {}
            : {
              missingWindowCount:
                result.accessibility.missingWindowIdentifiers.length,
            }),
          ...(result.accessibility.activation === undefined
            ? {}
            : {
              activationStatus: result.accessibility.activation.status,
              activationAttempts:
                result.accessibility.activation.attempts,
              activationWaitMs:
                result.accessibility.activation.waitMilliseconds,
              ...(result.accessibility.activation.nodeCountBefore === undefined
                ? {}
                : {
                  activationNodeCountBefore:
                    result.accessibility.activation.nodeCountBefore,
                }),
              ...(result.accessibility.activation.nodeCountAfter === undefined
                ? {}
                : {
                  activationNodeCountAfter:
                    result.accessibility.activation.nodeCountAfter,
                }),
            }),
        },
      });
      return artifact;
    } catch (error) {
      const reason = captureFailureReason(error);
      if (TARGET_INVALIDATING_FAILURES.has(reason)) {
        this.invalidateTarget(frozen, diagnosticContext, captureId, reason);
      }
      if (reason === "target_changed_during_capture") {
        this.emitDiagnostic(diagnosticContext, {
          event: "capture.attestation_failed",
          captureId,
          reason,
        });
      }
      this.emitDiagnostic(diagnosticContext, {
        event: "capture.completed",
        captureId,
        queueWaitMs,
        totalMs: Math.max(0, this.now() - startedAt),
        servedConsumerCount: consumers.count,
        status: "failed",
        reason,
      });
      throw error;
    }
  }

  private invalidateTarget(
    frozen: FrozenCaptureTarget,
    diagnosticContext: CaptureDiagnosticContext,
    captureId: string,
    reason: string,
  ) {
    if (
      this.latest === undefined ||
      !sameWindowIdentity(this.latest.target, frozen.target)
    ) return;
    this.latest = undefined;
    if (
      this.completed !== undefined &&
      sameWindowIdentity(this.completed.target, frozen.target)
    ) {
      this.completed = undefined;
    }
    this.emitDiagnostic(diagnosticContext, {
      event: "target_invalidated",
      captureId,
      reason,
    });
  }

  private assertCurrentTarget(frozen: FrozenCaptureTarget) {
    if (!this.isCurrentTarget(frozen)) {
      throw new CaptureInvalidatedError();
    }
  }

  private isCurrentTarget(frozen: FrozenCaptureTarget) {
    return this.latest !== undefined &&
      sameWindowIdentity(this.latest.target, frozen.target);
  }

  private targetKey(target: WindowMetadata) {
    return createHash("sha256")
      .update([
        this.targetSalt,
        target.processIdentifier,
        target.windowIdentifier ?? "missing",
      ].join(":"))
      .digest("hex")
      .slice(0, 16);
  }
}

function captureKey(
  value: Pick<CaptureArtifact, "target" | "contentEpoch">,
) {
  return [
    value.target.processIdentifier,
    value.target.windowIdentifier ?? "missing",
    value.contentEpoch,
  ].join(":");
}

const CONTENT_ACTIVITY_KINDS = new Set<NativeActivitySignal["kind"]>([
  "focusedElementChanged",
  "mouseClick",
  "keyActivity",
  "accessibilityChanged",
  "visualChanged",
]);

function isContentActivityKind(kind: NativeActivitySignal["kind"]) {
  return CONTENT_ACTIVITY_KINDS.has(kind);
}

function sameWindowIdentity(left: WindowMetadata, right: WindowMetadata) {
  return left.processIdentifier === right.processIdentifier &&
    left.windowIdentifier !== undefined &&
    left.windowIdentifier === right.windowIdentifier;
}

function artifactStatus(result: NativeCaptureResult): CaptureArtifactStatus {
  const hasScreenshot = result.screenshot.status === "complete" &&
    result.screenshot.dataBase64 !== undefined &&
    result.screenshot.mimeType !== undefined;
  const hasAccessibility = result.accessibility.snapshot !== undefined &&
    (
      result.accessibility.quality === undefined ||
      result.accessibility.quality === "useful"
    );
  if (hasScreenshot && hasAccessibility) return "complete";
  if (hasScreenshot) return "screenshot_only";
  if (hasAccessibility) return "ax_only";
  return "failed";
}

function consumerCancelledError() {
  const error = new Error("Capture consumer cancelled");
  error.name = "AbortError";
  return error;
}

const SAFE_CAPTURE_FAILURE_CODES = new Set([
  "target_unavailable",
  "target_changed_during_capture",
  "capture_timeout",
  "helper_not_ready",
  "capture_busy",
  "capture_failed",
]);

const TARGET_INVALIDATING_FAILURES = new Set([
  "target_unavailable",
  "target_changed_during_capture",
]);

function captureFailureReason(error: unknown) {
  if (error instanceof CaptureInvalidatedError) {
    return "target_changed";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_CAPTURE_FAILURE_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "capture_failed";
}
