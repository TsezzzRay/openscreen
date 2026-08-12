import type {
  AccessibilityCapture,
  AccessibilityNode,
  CaptureWindowGroup,
  NativeActivityKind,
  ScreenshotCapture,
  WindowMetadata,
} from "./protocol.js";

export type FocusedElement = Omit<AccessibilityNode, "children">;

export type ScreenObservation = {
  schemaVersion: 1;
  id: string;
  captureId: string;
  activityRevision: number;
  occurredAt: string;
  startedAt?: string;
  capturedAt: string;
  trigger: {
    type: NativeActivityKind;
  };
  window: WindowMetadata;
  windowGroup?: CaptureWindowGroup;
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
