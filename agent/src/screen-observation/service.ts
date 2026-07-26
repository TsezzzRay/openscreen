import { createHash, randomUUID } from "node:crypto";

import {
  CapturePlanner,
  axContentHash,
  isBoundaryKind,
  shouldEmitObservation,
} from "./policy.js";
import type {
  AccessibilityNode,
  FocusedElement,
  NativeActivitySignal,
  NativeCaptureResult,
  ObservationContentSignature,
  ScreenObservation,
  WindowMetadata,
} from "./types.js";

type ScreenObservationServiceOptions = {
  capture: (signal: NativeActivitySignal) => Promise<NativeCaptureResult>;
  onObservation: (observation: ScreenObservation) => void;
  visualThreshold?: number;
};

const ORDINARY_CAPTURE_GAP_MILLISECONDS = 2_000;

export class ScreenObservationService {
  private readonly planner = new CapturePlanner();
  private previousSignature?: ObservationContentSignature;
  private deferredSignal?: NativeActivitySignal;
  private lastCaptureAtMilliseconds = Number.NEGATIVE_INFINITY;
  private capturing = false;

  constructor(private readonly options: ScreenObservationServiceOptions) {}

  push(signal: NativeActivitySignal, nowMilliseconds = Date.now()) {
    if (isBoundaryKind(signal.kind)) this.deferredSignal = undefined;
    this.planner.push(signal, nowMilliseconds);
  }

  async tick(nowMilliseconds = Date.now()) {
    if (this.capturing) return;
    const due = this.planner.takeDue(nowMilliseconds);
    if (due.length > 0) {
      this.deferredSignal = due
        .map((capture) => capture.signal)
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
        .at(-1);
    }
    const signal = this.deferredSignal;
    if (signal === undefined) return;

    const boundaryRequested = isBoundaryKind(signal.kind) &&
      this.previousSignature?.windowKey !== windowKey(signal.window);
    if (
      !boundaryRequested &&
      nowMilliseconds - this.lastCaptureAtMilliseconds < ORDINARY_CAPTURE_GAP_MILLISECONDS
    ) return;

    this.deferredSignal = undefined;
    this.capturing = true;
    this.lastCaptureAtMilliseconds = nowMilliseconds;
    try {
      const result = await this.options.capture(signal);
      if (windowKey(result.window) !== windowKey(signal.window)) return;
      const signature = contentSignature(result);
      if (!shouldEmitObservation(
        this.previousSignature,
        signature,
        boundaryRequested,
        this.options.visualThreshold,
      )) return;
      this.previousSignature = signature;
      await this.options.onObservation(buildObservation(signal, result));
    } finally {
      this.capturing = false;
    }
  }
}

function windowKey(window: WindowMetadata) {
  return `${window.processIdentifier}:${window.windowIdentifier ?? window.title ?? ""}`;
}

function contentSignature(result: NativeCaptureResult): ObservationContentSignature {
  return {
    windowKey: windowKey(result.window),
    accessibilityHash: result.accessibility.snapshot === undefined
      ? `${result.accessibility.status}:${result.screenshot.status}`
      : axContentHash(result.accessibility.snapshot),
    visualSignature: result.visualSignature,
  };
}

function buildObservation(
  signal: NativeActivitySignal,
  result: NativeCaptureResult,
): ScreenObservation {
  const normalized = normalizeAccessibility(result.accessibility.snapshot?.root);
  const screenshotHash = result.screenshot.dataBase64 === undefined
    ? undefined
    : createHash("sha256")
      .update(Buffer.from(result.screenshot.dataBase64, "base64"))
      .digest("hex");
  return {
    schemaVersion: 1,
    id: randomUUID(),
    occurredAt: signal.occurredAt,
    capturedAt: result.capturedAt,
    trigger: { type: signal.kind },
    window: result.window,
    screenshot: {
      ...result.screenshot,
      ...(screenshotHash === undefined ? {} : { sha256: screenshotHash }),
    },
    accessibility: result.accessibility,
    ...(normalized.focusedElement === undefined
      ? {}
      : { focusedElement: normalized.focusedElement }),
    visibleText: normalized.visibleText,
    ...(normalized.url === undefined ? {} : { url: normalized.url }),
    diagnostics: {
      triggerToCaptureMilliseconds: Math.max(
        0,
        Date.parse(result.capturedAt) - Date.parse(signal.occurredAt),
      ),
      screenshotDurationMilliseconds: result.screenshot.durationMilliseconds,
      accessibilityDurationMilliseconds: result.accessibility.durationMilliseconds,
    },
  };
}

function normalizeAccessibility(root?: AccessibilityNode): {
  focusedElement?: FocusedElement;
  visibleText: string;
  url?: string;
} {
  if (root === undefined) return { visibleText: "" };
  const lines: string[] = [];
  const seen = new Set<string>();
  let focusedElement: FocusedElement | undefined;
  let url: string | undefined;

  const visit = (node: AccessibilityNode) => {
    if (node.focused && focusedElement === undefined) {
      const { children: _, ...element } = node;
      focusedElement = element;
    }
    for (const candidate of [node.title, node.value, node.description]) {
      const text = candidate?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lines.push(text);
      if (url === undefined && /^https?:\/\/\S+$/i.test(text)) url = text;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return {
    ...(focusedElement === undefined ? {} : { focusedElement }),
    visibleText: lines.join("\n"),
    ...(url === undefined ? {} : { url }),
  };
}
