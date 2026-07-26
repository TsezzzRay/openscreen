import { createHash } from "node:crypto";

import type {
  NativeActivityKind,
  NativeActivitySignal,
  ObservationContentSignature,
  PlannedCapture,
} from "./types.js";

type PendingCapture = PlannedCapture & {
  firstAtMilliseconds: number;
};

const BOUNDARY_KINDS = new Set<NativeActivityKind>([
  "applicationActivated",
  "focusedWindowChanged",
  "spaceChanged",
  "wake",
]);

const DELAYS: Partial<Record<NativeActivityKind, number>> = {
  mouseClick: 400,
  focusedElementChanged: 500,
  keyActivity: 1_500,
  accessibilityChanged: 3_000,
  visualChanged: 750,
};

const CAPS: Partial<Record<NativeActivityKind, number>> = {
  keyActivity: 30_000,
  visualChanged: 10_000,
};

export function isBoundaryKind(kind: NativeActivityKind) {
  return BOUNDARY_KINDS.has(kind);
}

export class CapturePlanner {
  private readonly pending = new Map<string, PendingCapture>();

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

    const delay = DELAYS[signal.kind];
    if (delay === undefined) {
      throw new Error(`Unsupported activity kind: ${signal.kind}`);
    }
    const previous = this.pending.get(signal.kind);
    const firstAtMilliseconds = previous?.firstAtMilliseconds ?? nowMilliseconds;
    const cap = CAPS[signal.kind];
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
      next = next === undefined ? capture.dueAtMilliseconds : Math.min(next, capture.dueAtMilliseconds);
    }
    return next;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function axContentHash(snapshot: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export function visualDistance(left?: number[], right?: number[]) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined || right === undefined || left.length !== right.length) return 1;
  if (left.length === 0) return 0;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index]! - right[index]!);
  }
  return difference / (left.length * 255);
}

export function shouldEmitObservation(
  previous: ObservationContentSignature | undefined,
  current: ObservationContentSignature,
  boundary: boolean,
  visualThreshold = 0.08,
) {
  if (previous === undefined || boundary || previous.windowKey !== current.windowKey) return true;
  if (previous.accessibilityHash !== current.accessibilityHash) return true;
  return visualDistance(previous.visualSignature, current.visualSignature) >= visualThreshold;
}
