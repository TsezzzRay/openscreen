import { createHash, randomUUID } from "node:crypto";

import type {
  AccessibilityNode,
  NativeActivitySignal,
  NativeCaptureResult,
} from "./protocol.js";
import type {
  FocusedElement,
  ScreenObservation,
} from "./types.js";

export function buildObservation(
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
