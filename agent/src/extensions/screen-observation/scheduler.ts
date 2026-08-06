import type {
  ScreenObservationConfig,
} from "../../config.js";
import type {
  NativeActivityKind,
  NativeActivitySignal,
} from "./protocol.js";

type PlannedCapture = {
  signal: NativeActivitySignal;
  dueAtMilliseconds: number;
};

type PendingCapture = PlannedCapture & {
  firstAtMilliseconds: number;
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

  push(signal: NativeActivitySignal, nowMilliseconds: number) {
    const key = eventKey(signal);
    const lastEventAt = this.lastEventAt.get(key);
    if (lastEventAt !== undefined && nowMilliseconds - lastEventAt <
        this.config.eventDeduplicationWindowMilliseconds) {
      return;
    }
    this.lastEventAt.set(key, nowMilliseconds);
    if (this.lastEventAt.size >= EVENT_TIME_PRUNE_THRESHOLD) {
      const cutoff = nowMilliseconds - this.config.eventDeduplicationWindowMilliseconds;
      for (const [event, occurredAt] of this.lastEventAt) {
        if (occurredAt < cutoff) this.lastEventAt.delete(event);
      }
    }

    if (isBoundaryKind(signal.kind)) {
      this.pending.clear();
      this.pending.set("boundary", {
        signal,
        firstAtMilliseconds: nowMilliseconds,
        dueAtMilliseconds: nowMilliseconds,
      });
      return;
    }

    if (IMMEDIATE_KINDS.has(signal.kind)) {
      this.pending.delete("accessibilityChanged");
    }

    const delay = this.config.delaysMilliseconds[
      signal.kind as keyof ScreenObservationConfig["scheduling"]["delaysMilliseconds"]
    ];
    if (delay === undefined) {
      throw new Error(`Unsupported activity kind: ${signal.kind}`);
    }
    const previous = this.pending.get(signal.kind);
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
    });
  }

  takeDue(nowMilliseconds: number): PlannedCapture[] {
    const due = [...this.pending.entries()]
      .filter(([, capture]) => capture.dueAtMilliseconds <= nowMilliseconds)
      .sort((left, right) => left[1].dueAtMilliseconds - right[1].dueAtMilliseconds);
    for (const [key] of due) this.pending.delete(key);
    return due.map(([, { signal, dueAtMilliseconds }]) => ({ signal, dueAtMilliseconds }));
  }

}
