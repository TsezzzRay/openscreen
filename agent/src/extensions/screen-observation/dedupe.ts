import { createHash } from "node:crypto";

import type {
  AccessibilityNode,
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

function normalizedText(value?: string) {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : undefined;
}

function semanticNode(node: AccessibilityNode): unknown {
  const children = node.children?.map(semanticNode);
  return {
    role: node.role,
    ...(normalizedText(node.subrole) === undefined
      ? {}
      : { subrole: normalizedText(node.subrole) }),
    ...(normalizedText(node.title) === undefined
      ? {}
      : { title: normalizedText(node.title) }),
    ...(normalizedText(node.value) === undefined
      ? {}
      : { value: normalizedText(node.value) }),
    ...(normalizedText(node.description) === undefined
      ? {}
      : { description: normalizedText(node.description) }),
    ...(node.focused === true ? { focused: true } : {}),
    ...(children === undefined || children.length === 0 ? {} : { children }),
  };
}

export function contentSignature(
  result: NativeCaptureResult,
): ObservationContentSignature {
  const semanticAccessibility = result.accessibility.snapshot === undefined
    ? `${result.accessibility.status}:${result.screenshot.status}`
    : {
        windowTitle: normalizedText(result.window.title),
        root: semanticNode(result.accessibility.snapshot.root),
      };
  return {
    windowKey: windowKey(result.window),
    accessibilityHash: typeof semanticAccessibility === "string"
      ? semanticAccessibility
      : axContentHash(semanticAccessibility),
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

  candidate(result: NativeCaptureResult, boundary: boolean) {
    const current = contentSignature(result);
    if (!shouldEmitObservation(
      this.previous,
      current,
      boundary,
      this.visualThreshold,
    )) return undefined;
    return current;
  }

  commit(candidate: ObservationContentSignature) {
    this.previous = candidate;
  }
}
