import { createHash } from "node:crypto";

import type {
  NativeCaptureResult,
  WindowMetadata,
} from "./protocol.js";
import { normalizeAccessibility } from "./observation.js";

export type ObservationContentSignature = {
  windowKey: string;
  contentHash: string;
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
  const normalized = normalizeAccessibility(result.accessibility.snapshot?.root);
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
  };
}

export function shouldEmitObservation(
  previous: ObservationContentSignature | undefined,
  current: ObservationContentSignature,
  boundary: boolean,
) {
  if (previous === undefined || boundary || previous.windowKey !== current.windowKey) return true;
  if (previous.contentHash !== current.contentHash) return true;
  return false;
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
