import type {
  ScreenObservationConfig,
} from "../../config.js";
import type {
  NativeActivityKind,
  NativeActivitySignal,
  WindowMetadata,
} from "./protocol.js";

export type PlannedCapture = {
  signal: NativeActivitySignal;
  dueAtMilliseconds: number;
  activityRevision?: number;
  contentEpoch?: number;
};

type PendingCapture = PlannedCapture & {
  firstAtMilliseconds: number;
};

export type PlannerPushDecision = {
  decision: "scheduled" | "deduplicated" | "coalesced";
  dueAtMilliseconds?: number;
  supersededCount?: number;
  superseded?: PlannedCapture[];
};

const BOUNDARY_KINDS = new Set<NativeActivityKind>([
  "applicationActivated",
  "focusedWindowChanged",
  "spaceChanged",
  "wake",
]);

const IMMEDIATE_KINDS = new Set<NativeActivityKind>([
  ...BOUNDARY_KINDS,
  "mouseClick",
  "keyActivity",
]);

const EVENT_TIME_PRUNE_THRESHOLD = 256;

function eventKey(signal: NativeActivitySignal) {
  return JSON.stringify([
    signal.kind,
    signal.window.bundleIdentifier ?? "",
    signal.window.windowIdentifier ?? signal.window.title ?? "",
  ]);
}

export function isBoundaryKind(kind: NativeActivityKind) {
  return BOUNDARY_KINDS.has(kind);
}

export class CapturePlanner {
  private readonly pending = new Map<string, PendingCapture>();
  private readonly lastEventAt = new Map<string, number>();

  constructor(
    private readonly config: ScreenObservationConfig["scheduling"],
  ) {}

  push(
    signal: NativeActivitySignal,
    nowMilliseconds: number,
    activityRevision?: number,
    contentEpoch?: number,
  ): PlannerPushDecision {
    const key = eventKey(signal);
    const lastEventAt = this.lastEventAt.get(key);
    if (lastEventAt !== undefined && nowMilliseconds - lastEventAt <
        this.config.eventDeduplicationWindowMilliseconds) {
      return { decision: "deduplicated" };
    }
    this.lastEventAt.set(key, nowMilliseconds);
    if (this.lastEventAt.size >= EVENT_TIME_PRUNE_THRESHOLD) {
      const cutoff = nowMilliseconds - this.config.eventDeduplicationWindowMilliseconds;
      for (const [event, occurredAt] of this.lastEventAt) {
        if (occurredAt < cutoff) this.lastEventAt.delete(event);
      }
    }

    if (isBoundaryKind(signal.kind)) {
      const superseded = [...this.pending.values()].map(plannedCapture);
      const supersededCount = superseded.length;
      for (const capture of this.pending.values()) {
        this.lastEventAt.delete(eventKey(capture.signal));
      }
      this.pending.clear();
      this.pending.set("boundary", {
        signal,
        firstAtMilliseconds: nowMilliseconds,
        dueAtMilliseconds: nowMilliseconds,
        ...(activityRevision === undefined ? {} : { activityRevision }),
        ...(contentEpoch === undefined ? {} : { contentEpoch }),
      });
      return {
        decision: "scheduled",
        dueAtMilliseconds: nowMilliseconds,
        ...(supersededCount === 0 ? {} : { supersededCount }),
        ...(supersededCount === 0 ? {} : { superseded }),
      };
    }

    const superseded: PlannedCapture[] = [];
    if (IMMEDIATE_KINDS.has(signal.kind)) {
      const accessibility = this.pending.get("accessibilityChanged");
      if (accessibility !== undefined) {
        superseded.push(plannedCapture(accessibility));
      }
      this.pending.delete("accessibilityChanged");
    }

    const delay = this.config.delaysMilliseconds[
      signal.kind as keyof ScreenObservationConfig["scheduling"]["delaysMilliseconds"]
    ];
    if (delay === undefined) {
      throw new Error(`Unsupported activity kind: ${signal.kind}`);
    }
    const previous = this.pending.get(signal.kind);
    if (previous !== undefined) superseded.push(plannedCapture(previous));
    const firstAtMilliseconds = previous?.firstAtMilliseconds ?? nowMilliseconds;
    const cap = this.config.capsMilliseconds[
      signal.kind as keyof ScreenObservationConfig["scheduling"]["capsMilliseconds"]
    ];
    const dueAtMilliseconds = Math.min(
      nowMilliseconds + delay,
      cap === undefined ? Number.POSITIVE_INFINITY : firstAtMilliseconds + cap,
    );
    this.pending.set(signal.kind, {
      signal,
      firstAtMilliseconds,
      dueAtMilliseconds,
      ...(activityRevision === undefined ? {} : { activityRevision }),
      ...(contentEpoch === undefined ? {} : { contentEpoch }),
    });
    return {
      decision: previous === undefined ? "scheduled" : "coalesced",
      dueAtMilliseconds,
      ...(superseded.length === 0
        ? {}
        : { supersededCount: superseded.length, superseded }),
    };
  }

  takeDue(nowMilliseconds: number): PlannedCapture[] {
    const due = [...this.pending.entries()]
      .filter(([, capture]) => capture.dueAtMilliseconds <= nowMilliseconds)
      .sort((left, right) => left[1].dueAtMilliseconds - right[1].dueAtMilliseconds);
    for (const [key] of due) this.pending.delete(key);
    return due.map(([, {
      signal,
      dueAtMilliseconds,
      activityRevision,
      contentEpoch,
    }]) => ({
      signal,
      dueAtMilliseconds,
      ...(activityRevision === undefined ? {} : { activityRevision }),
      ...(contentEpoch === undefined ? {} : { contentEpoch }),
    }));
  }

  discardKind(kind: NativeActivityKind) {
    const capture = this.pending.get(kind);
    this.pending.delete(kind);
    if (capture === undefined) return undefined;
    this.lastEventAt.delete(eventKey(capture.signal));
    return plannedCapture(capture);
  }

  discardCovered(target: WindowMetadata, activityRevision: number) {
    let discarded = 0;
    for (const [key, capture] of this.pending) {
      if (
        capture.activityRevision !== undefined &&
        capture.activityRevision <= activityRevision &&
        sameWindow(capture.signal.window, target)
      ) {
        this.pending.delete(key);
        this.lastEventAt.delete(eventKey(capture.signal));
        discarded += 1;
      }
    }
    return discarded;
  }

  forgetCovered(signal: NativeActivitySignal) {
    this.lastEventAt.delete(eventKey(signal));
  }

}

function plannedCapture(capture: PendingCapture): PlannedCapture {
  return {
    signal: capture.signal,
    dueAtMilliseconds: capture.dueAtMilliseconds,
    ...(capture.activityRevision === undefined
      ? {}
      : { activityRevision: capture.activityRevision }),
    ...(capture.contentEpoch === undefined
      ? {}
      : { contentEpoch: capture.contentEpoch }),
  };
}

function sameWindow(left: WindowMetadata, right: WindowMetadata) {
  return left.processIdentifier === right.processIdentifier &&
    left.windowIdentifier !== undefined &&
    left.windowIdentifier === right.windowIdentifier;
}
