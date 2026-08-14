import {
  CapturePlanner,
  isBoundaryKind,
  type PlannedCapture,
} from "./scheduler.js";
import type { CaptureConfig } from "./config.js";
import type { CaptureArtifact } from "./artifact.js";
import { visualDistance } from "./dedupe.js";
import { windowKey } from "./dedupe.js";
import type { ObservationResolution } from "./observation-resolver.js";
import type { NativeActivitySignal } from "./native/protocol.js";
import type { CaptureDiagnosticsSink } from "./diagnostics.js";

type BackgroundCaptureOptions = {
  config: CaptureConfig;
  capture: (signal: NativeActivitySignal) => Promise<CaptureArtifact>;
  resolveObservation: (
    artifact: CaptureArtifact,
  ) => Promise<ObservationResolution>;
  diagnostics?: CaptureDiagnosticsSink;
};

export class BackgroundCapture {
  private readonly planner: CapturePlanner;
  private deferredCapture?: PlannedCapture;
  private pendingDelivery?: {
    artifact: CaptureArtifact;
    retryAtMilliseconds: number;
  };
  private lastCaptureAtMilliseconds = Number.NEGATIVE_INFINITY;
  private readonly lastCaptureAtByWindow = new Map<string, number>();
  private readonly captureFailuresByWindow = new Map<string, {
    consecutiveFailures: number;
    nextEligibleAtMilliseconds: number;
  }>();
  private readonly lastVisualSignatureByWindow = new Map<string, number[]>();
  private rateLimitedKey?: string;
  private capturing = false;

  constructor(private readonly options: BackgroundCaptureOptions) {
    this.planner = new CapturePlanner(options.config.scheduling);
  }

  shouldAdvanceContentEpoch(signal: NativeActivitySignal) {
    if (signal.kind !== "visualChanged") {
      return CONTENT_ACTIVITY_KINDS.has(signal.kind);
    }
    if (signal.visualSignature === undefined) return false;
    const distance = this.visualDistanceFromBaseline(signal);
    return distance === undefined ||
      distance >= this.options.config.visualMonitoring.changeThreshold;
  }

  push(
    signal: NativeActivitySignal,
    nowMilliseconds = Date.now(),
    activityRevision?: number,
    contentEpoch?: number,
  ) {
    if (isBoundaryKind(signal.kind) && this.deferredCapture !== undefined) {
      this.emitPlannedEvent(
        "activity.boundary_superseded",
        this.deferredCapture,
        signal.kind,
      );
      this.deferredCapture = undefined;
      this.rateLimitedKey = undefined;
    }
    if (signal.kind === "visualChanged") {
      const distance = this.visualDistanceFromBaseline(signal);
      if (
        signal.visualSignature === undefined ||
        (distance !== undefined &&
          distance < this.options.config.visualMonitoring.changeThreshold)
      ) {
        const discarded = this.planner.discardKind("visualChanged");
        if (discarded !== undefined) {
          this.emitPlannedEvent(
            "activity.due_collapsed",
            discarded,
            "visual_baseline_recovered",
          );
        }
        if (this.deferredCapture?.signal.kind === "visualChanged") {
          this.emitPlannedEvent(
            "activity.due_collapsed",
            this.deferredCapture,
            "visual_baseline_recovered",
          );
          this.deferredCapture = undefined;
          this.rateLimitedKey = undefined;
        }
        this.options.diagnostics?.emit({
          event: "activity.capture_skipped",
          consumer: "activity",
          activityKind: signal.kind,
          ...(activityRevision === undefined ? {} : { activityRevision }),
          ...(contentEpoch === undefined ? {} : { contentEpoch }),
          reason: signal.visualSignature === undefined
            ? "missing_visual_signature"
            : "visual_change_below_capture_threshold",
          ...(distance === undefined ? {} : { visualDistance: distance }),
        });
        return;
      }
    }
    const planner = this.planner.push(
      signal,
      nowMilliseconds,
      activityRevision,
      contentEpoch,
    );
    for (const superseded of planner.superseded ?? []) {
      this.emitPlannedEvent(
        isBoundaryKind(signal.kind)
          ? "activity.boundary_superseded"
          : "activity.due_collapsed",
        superseded,
        isBoundaryKind(signal.kind)
          ? signal.kind
          : "coalesced_by_newer_activity",
      );
    }
    this.options.diagnostics?.emit({
      event: "activity.planner_decision",
      consumer: "activity",
      activityKind: signal.kind,
      ...(activityRevision === undefined ? {} : { activityRevision }),
      ...(contentEpoch === undefined ? {} : { contentEpoch }),
      plannerDecision: planner.decision,
      ...(planner.dueAtMilliseconds === undefined
        ? {}
        : {
          scheduledDelayMs: Math.max(
            0,
            planner.dueAtMilliseconds - nowMilliseconds,
          ),
        }),
      ...(planner.supersededCount === undefined
        ? {}
        : { supersededCount: planner.supersededCount }),
    });
  }

  cover(
    artifact: CaptureArtifact,
    intentRevision = artifact.activityRevision,
    intentActivityKind = artifact.signal.kind,
    intentContentEpoch = artifact.contentEpoch,
  ) {
    const coveredPendingCount = this.planner.discardCovered(
      artifact.target,
      intentRevision,
    );
    const deferred = this.deferredCapture;
    const coveredDeferred =
      deferred?.activityRevision !== undefined &&
      deferred.activityRevision <= intentRevision &&
      windowKey(deferred.signal.window) === windowKey(artifact.target);
    if (coveredDeferred) {
      this.deferredCapture = undefined;
      this.rateLimitedKey = undefined;
      this.planner.forgetCovered(deferred.signal);
    }
    this.options.diagnostics?.emit({
      event: "activity.covered_by_request",
      consumer: "request",
      captureId: artifact.captureId,
      activityRevision: intentRevision,
      intentRevision,
      artifactRevision: artifact.activityRevision,
      completedRevision: artifact.completedActivityRevision,
      contentEpoch: intentContentEpoch,
      intentContentEpoch,
      artifactContentEpoch: artifact.contentEpoch,
      completedContentEpoch: artifact.completedContentEpoch,
      activityKind: intentActivityKind,
      coveredPendingCount,
      coveredDeferred,
    });
    this.lastCaptureAtMilliseconds = Math.max(
      this.lastCaptureAtMilliseconds,
      artifact.completedAtMilliseconds,
    );
    const targetKey = windowKey(artifact.target);
    this.lastCaptureAtByWindow.set(
      targetKey,
      Math.max(
        this.lastCaptureAtByWindow.get(targetKey) ?? Number.NEGATIVE_INFINITY,
        artifact.completedAtMilliseconds,
      ),
    );
    this.captureFailuresByWindow.delete(targetKey);
  }

  recordObservationResolution(
    artifact: CaptureArtifact,
    resolution: ObservationResolution,
  ) {
    if (resolution.decision === "created") {
      this.rememberVisualSignature(artifact);
    }
  }

  async tick(nowMilliseconds = Date.now()) {
    if (this.capturing) return;
    const pendingDelivery = this.pendingDelivery;
    if (pendingDelivery !== undefined) {
      if (pendingDelivery.retryAtMilliseconds > nowMilliseconds) return;
      this.capturing = true;
      try {
        const resolution = await this.options.resolveObservation(
          pendingDelivery.artifact,
        );
        this.recordObservationResolution(pendingDelivery.artifact, resolution);
        this.pendingDelivery = undefined;
      } catch (error) {
        pendingDelivery.retryAtMilliseconds = nowMilliseconds +
          this.options.config.scheduling.ordinaryCaptureGapMilliseconds;
        throw error;
      } finally {
        this.capturing = false;
      }
      return;
    }
    const due = this.planner.takeDue(nowMilliseconds);
    if (due.length > 0) {
      const previous = this.deferredCapture;
      const candidates = previous === undefined ? due : [previous, ...due];
      const selected = [...candidates].sort(compareCapturePriority).at(-1)!;
      if (selected !== previous) {
        if (previous !== undefined) {
          this.emitPlannedEvent(
            "activity.due_collapsed",
            previous,
            "higher_priority_due",
          );
        }
        this.deferredCapture = selected;
        this.rateLimitedKey = undefined;
        this.emitPlannedEvent("activity.due_selected", selected);
      }
      for (const candidate of due) {
        if (candidate === selected) continue;
        this.emitPlannedEvent(
          "activity.due_collapsed",
          candidate,
          "higher_priority_due",
        );
      }
    }
    const deferred = this.deferredCapture;
    if (deferred === undefined) return;
    const signal = deferred.signal;

    if (signal.kind === "visualChanged") {
      const distance = this.visualDistanceFromBaseline(signal);
      if (
        signal.visualSignature === undefined ||
        (distance !== undefined &&
          distance < this.options.config.visualMonitoring.changeThreshold)
      ) {
        this.deferredCapture = undefined;
        this.rateLimitedKey = undefined;
        this.options.diagnostics?.emit({
          event: "activity.capture_skipped",
          consumer: "activity",
          activityKind: signal.kind,
          ...(deferred.activityRevision === undefined
            ? {}
            : { activityRevision: deferred.activityRevision }),
          ...(deferred.contentEpoch === undefined
            ? {}
            : { contentEpoch: deferred.contentEpoch }),
          reason: signal.visualSignature === undefined
            ? "missing_visual_signature"
            : "visual_change_below_capture_threshold",
          ...(distance === undefined ? {} : { visualDistance: distance }),
        });
        return;
      }
    }

    const boundaryRequested = isBoundaryKind(signal.kind);
    const requestedWindowKey = windowKey(signal.window);
    const failure = this.captureFailuresByWindow.get(requestedWindowKey);
    if (
      failure !== undefined &&
      failure.nextEligibleAtMilliseconds > nowMilliseconds
    ) {
      const key = plannedKey(deferred);
      if (this.rateLimitedKey !== key) {
        this.rateLimitedKey = key;
        this.emitPlannedEvent(
          "activity.rate_limited",
          deferred,
          "failure_backoff",
          failure.nextEligibleAtMilliseconds - nowMilliseconds,
        );
      }
      return;
    }
    const lastWindowCapture = this.lastCaptureAtByWindow.get(requestedWindowKey) ??
      Number.NEGATIVE_INFINITY;
    if (!boundaryRequested) {
      const limits = [
        {
          at: this.lastCaptureAtMilliseconds +
            this.options.config.scheduling.ordinaryCaptureGapMilliseconds,
          reason: "global_gap",
        },
        {
          at: lastWindowCapture +
            this.options.config.scheduling.sameWindowCaptureGapMilliseconds,
          reason: "same_window_gap",
        },
        ...(signal.kind === "visualChanged"
          ? [{
              at: lastWindowCapture +
                this.options.config.scheduling.visualOnlyCaptureGapMilliseconds,
              reason: "visual_only_gap",
            }]
          : []),
      ];
      const limiting = limits.sort((left, right) => left.at - right.at).at(-1)!;
      if (limiting.at > nowMilliseconds) {
        const key = plannedKey(deferred);
        if (this.rateLimitedKey !== key) {
          this.rateLimitedKey = key;
          this.emitPlannedEvent(
            "activity.rate_limited",
            deferred,
            limiting.reason,
            Math.max(0, limiting.at - nowMilliseconds),
          );
        }
        return;
      }
    }

    this.deferredCapture = undefined;
    this.rateLimitedKey = undefined;
    this.capturing = true;
    try {
      let result: CaptureArtifact;
      try {
        result = await this.options.capture(signal);
      } catch (error) {
        this.rememberCaptureFailure(requestedWindowKey, nowMilliseconds);
        throw error;
      }
      this.lastCaptureAtMilliseconds = nowMilliseconds;
      this.lastCaptureAtByWindow.set(requestedWindowKey, nowMilliseconds);
      this.captureFailuresByWindow.delete(requestedWindowKey);
      const delivery = {
        artifact: result,
        retryAtMilliseconds: nowMilliseconds,
      };
      this.pendingDelivery = delivery;
      try {
        const resolution = await this.options.resolveObservation(
          delivery.artifact,
        );
        this.recordObservationResolution(delivery.artifact, resolution);
        this.pendingDelivery = undefined;
      } catch (error) {
        delivery.retryAtMilliseconds = nowMilliseconds +
          this.options.config.scheduling.ordinaryCaptureGapMilliseconds;
        throw error;
      }
    } finally {
      this.capturing = false;
    }
  }

  private rememberCaptureFailure(
    requestedWindowKey: string,
    nowMilliseconds: number,
  ) {
    const previousFailures = this.captureFailuresByWindow.get(
      requestedWindowKey,
    )?.consecutiveFailures ?? 0;
    const consecutiveFailures = previousFailures + 1;
    const retryDelayMilliseconds = Math.min(
      FAILURE_RETRY_MAXIMUM_MILLISECONDS,
      FAILURE_RETRY_INITIAL_MILLISECONDS * 2 ** (consecutiveFailures - 1),
    );
    this.captureFailuresByWindow.set(requestedWindowKey, {
      consecutiveFailures,
      nextEligibleAtMilliseconds: nowMilliseconds + retryDelayMilliseconds,
    });
  }

  private visualDistanceFromBaseline(signal: NativeActivitySignal) {
    const signature = signal.visualSignature;
    if (signature === undefined) return undefined;
    const baseline = this.lastVisualSignatureByWindow.get(windowKey(signal.window));
    return baseline === undefined ? undefined : visualDistance(baseline, signature);
  }

  private rememberVisualSignature(artifact: CaptureArtifact) {
    const signature = artifact.result.visualSignature;
    if (artifact.status === "failed" || signature === undefined) return;
    this.lastVisualSignatureByWindow.set(windowKey(artifact.target), [...signature]);
  }

  private emitPlannedEvent(
    event: "activity.due_selected" | "activity.due_collapsed" |
      "activity.rate_limited" | "activity.boundary_superseded",
    capture: PlannedCapture,
    reason?: string,
    nextEligibleMs?: number,
  ) {
    this.options.diagnostics?.emit({
      event,
      consumer: "activity",
      activityKind: capture.signal.kind,
      ...(capture.activityRevision === undefined
        ? {}
        : { activityRevision: capture.activityRevision }),
      ...(capture.contentEpoch === undefined
        ? {}
        : { contentEpoch: capture.contentEpoch }),
      ...(reason === undefined ? {} : { reason }),
      ...(nextEligibleMs === undefined ? {} : { nextEligibleMs }),
    });
  }
}

const CONTENT_ACTIVITY_KINDS = new Set<NativeActivitySignal["kind"]>([
  "focusedElementChanged",
  "mouseClick",
  "keyActivity",
  "accessibilityChanged",
]);

const FAILURE_RETRY_INITIAL_MILLISECONDS = 1_000;
const FAILURE_RETRY_MAXIMUM_MILLISECONDS = 30_000;

const CAPTURE_PRIORITY: Record<NativeActivitySignal["kind"], number> = {
  applicationActivated: 4,
  focusedWindowChanged: 4,
  spaceChanged: 4,
  wake: 4,
  mouseClick: 3,
  keyActivity: 3,
  focusedElementChanged: 2,
  accessibilityChanged: 2,
  visualChanged: 1,
};

function compareCapturePriority(left: PlannedCapture, right: PlannedCapture) {
  return CAPTURE_PRIORITY[left.signal.kind] - CAPTURE_PRIORITY[right.signal.kind] ||
    Date.parse(left.signal.occurredAt) - Date.parse(right.signal.occurredAt);
}

function plannedKey(capture: PlannedCapture) {
  return capture.activityRevision === undefined
    ? `${capture.signal.kind}:${capture.signal.occurredAt}`
    : String(capture.activityRevision);
}
