import type {
  AccessibilityCapture,
  AccessibilityNode,
  NativeActivityKind,
  ScreenshotCapture,
  WindowMetadata,
} from "./protocol.js";

export type FocusedElement = Omit<AccessibilityNode, "children">;

export type ScreenObservation = {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  capturedAt: string;
  trigger: {
    type: NativeActivityKind;
  };
  window: WindowMetadata;
  screenshot: ScreenshotCapture & {
    sha256?: string;
  };
  accessibility: AccessibilityCapture;
  focusedElement?: FocusedElement;
  visibleText: string;
  url?: string;
  diagnostics: {
    triggerToCaptureMilliseconds: number;
    screenshotDurationMilliseconds: number;
    accessibilityDurationMilliseconds: number;
  };
};
