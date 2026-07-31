import { createHash } from "node:crypto";

import type {
  NativeCaptureResult,
  WindowMetadata,
} from "./protocol.js";

export type ObservationContentSignature = {
  windowKey: string;
  accessibilityHash?: string;
  visualSignature?: number[];
};

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

export function windowKey(window: WindowMetadata) {
  return `${window.processIdentifier}:${window.windowIdentifier ?? window.title ?? ""}`;
}

export function axContentHash(snapshot: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export function contentSignature(
  result: NativeCaptureResult,
): ObservationContentSignature {
  return {
    windowKey: windowKey(result.window),
    accessibilityHash: result.accessibility.snapshot === undefined
      ? `${result.accessibility.status}:${result.screenshot.status}`
      : axContentHash(result.accessibility.snapshot),
    visualSignature: result.visualSignature,
  };
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
  visualThreshold: number,
) {
  if (previous === undefined || boundary || previous.windowKey !== current.windowKey) return true;
  if (previous.accessibilityHash !== current.accessibilityHash) return true;
  return visualDistance(previous.visualSignature, current.visualSignature) >= visualThreshold;
}

export class Dedupe {
  private previous?: ObservationContentSignature;

  constructor(private readonly visualThreshold: number) {}

  isNewWindow(window: WindowMetadata) {
    return this.previous?.windowKey !== windowKey(window);
  }

  accept(result: NativeCaptureResult, boundary: boolean) {
    const current = contentSignature(result);
    if (!shouldEmitObservation(
      this.previous,
      current,
      boundary,
      this.visualThreshold,
    )) return false;
    this.previous = current;
    return true;
  }
}
