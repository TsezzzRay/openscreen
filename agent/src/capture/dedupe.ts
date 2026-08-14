import { createHash } from "node:crypto";

import type {
  NativeCaptureResult,
  WindowMetadata,
} from "./native/protocol.js";
import { normalizeAccessibility } from "./observation.js";

export type ObservationContentSignature = {
  windowKey: string;
  contentHash: string;
  semanticAvailable?: boolean;
  visualSignature?: number[];
};

export type ObservationContentComparison = {
  shouldEmit: boolean;
  semanticChanged: boolean;
  visualChanged: boolean;
  visualDistance?: number;
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

export function businessContentHash(content: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}

function normalizedText(value?: string) {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : undefined;
}

export function contentSignature(
  result: NativeCaptureResult,
): ObservationContentSignature {
  const semanticAvailable = result.accessibility.snapshot !== undefined &&
    (
      result.accessibility.quality === undefined ||
      result.accessibility.quality === "useful"
    );
  const normalized = normalizeAccessibility(
    semanticAvailable ? result.accessibility.snapshot?.root : undefined,
  );
  const semanticAccessibility = {
    application: result.window.bundleIdentifier ?? result.window.applicationName,
    windowTitle: normalizedText(result.window.title),
    focusedRole: normalized.focusedElement?.role,
    focusedValue: normalizedText(normalized.focusedElement?.value),
    visibleText: normalized.visibleText,
    url: normalized.url,
  };
  return {
    windowKey: windowKey(result.window),
    contentHash: businessContentHash(semanticAccessibility),
    semanticAvailable,
    ...(result.visualSignature === undefined
      ? {}
      : { visualSignature: [...result.visualSignature] }),
  };
}

export function shouldEmitObservation(
  previous: ObservationContentSignature | undefined,
  current: ObservationContentSignature,
  boundary: boolean,
  visualChangeThreshold: number | undefined = 0.05,
) {
  return compareObservationContent(
    previous,
    current,
    boundary,
    visualChangeThreshold,
  ).shouldEmit;
}

export function compareObservationContent(
  previous: ObservationContentSignature | undefined,
  current: ObservationContentSignature,
  boundary: boolean,
  visualChangeThreshold = 0.05,
): ObservationContentComparison {
  const previousSemanticAvailable = previous?.semanticAvailable ?? true;
  const currentSemanticAvailable = current.semanticAvailable ?? true;
  const semanticChanged = currentSemanticAvailable &&
    (previous === undefined ||
      !previousSemanticAvailable ||
      previous.contentHash !== current.contentHash);
  const distance = previous?.visualSignature === undefined ||
      current.visualSignature === undefined
    ? undefined
    : visualDistance(previous.visualSignature, current.visualSignature);
  const visualChanged = current.visualSignature !== undefined &&
    (previous?.visualSignature === undefined ||
      (distance !== undefined && distance >= visualChangeThreshold));
  const currentUnavailable = !currentSemanticAvailable &&
    current.visualSignature === undefined;
  return {
    shouldEmit: previous === undefined ||
      boundary ||
      previous.windowKey !== current.windowKey ||
      semanticChanged ||
      visualChanged ||
      currentUnavailable,
    semanticChanged,
    visualChanged,
    ...(distance === undefined ? {} : { visualDistance: distance }),
  };
}

export function visualDistance(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) {
    return left.length === 0 && right.length === 0 ? 0 : 1;
  }
  const difference = left.reduce(
    (total, value, index) => total + Math.abs(value - right[index]!),
    0,
  );
  return difference / (left.length * 255);
}

export class Dedupe {
  private previous?: ObservationContentSignature;

  candidate(result: NativeCaptureResult, boundary: boolean) {
    const current = contentSignature(result);
    if (!shouldEmitObservation(
      this.previous,
      current,
      boundary,
    )) return undefined;
    return current;
  }

  commit(candidate: ObservationContentSignature) {
    this.previous = candidate;
  }
}
