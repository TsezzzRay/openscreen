import type {
  ScreenObservationConfig,
} from "../config.js";
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

export function isBoundaryKind(kind: NativeActivityKind) {
  return BOUNDARY_KINDS.has(kind);
}

export class CapturePlanner {
  private readonly pending = new Map<string, PendingCapture>();

  constructor(
    private readonly config: ScreenObservationConfig["scheduling"],
  ) {}

  push(signal: NativeActivitySignal, nowMilliseconds: number) {
    if (isBoundaryKind(signal.kind)) {
      this.pending.clear();
      this.pending.set("boundary", {
        signal,
        firstAtMilliseconds: nowMilliseconds,
        dueAtMilliseconds: nowMilliseconds,
      });
      return;
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

  nextDueAt(): number | undefined {
    let next: number | undefined;
    for (const capture of this.pending.values()) {
      next = next === undefined
        ? capture.dueAtMilliseconds
        : Math.min(next, capture.dueAtMilliseconds);
    }
    return next;
  }
}
