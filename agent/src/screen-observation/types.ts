export type NativeActivityKind =
  | "applicationActivated"
  | "focusedWindowChanged"
  | "focusedElementChanged"
  | "mouseClick"
  | "keyActivity"
  | "accessibilityChanged"
  | "visualChanged"
  | "spaceChanged"
  | "wake";

export type ScreenObservationConfig = {
  enabled: boolean;
  scheduling: {
    tickIntervalMilliseconds: number;
    ordinaryCaptureGapMilliseconds: number;
    delaysMilliseconds: {
      mouseClick: number;
      focusedElementChanged: number;
      keyActivity: number;
      accessibilityChanged: number;
      visualChanged: number;
    };
    capsMilliseconds: {
      keyActivity: number;
      visualChanged: number;
    };
  };
  deduplication: {
    visualDifferenceThreshold: number;
  };
  capture: {
    requestTimeoutMilliseconds: number;
  };
  helperLifecycle: {
    configurationTimeoutMilliseconds: number;
    shutdownTimeoutMilliseconds: number;
  };
  activityMonitoring: {
    coalescingIntervalMilliseconds: number;
  };
  accessibility: {
    maxDepth: number;
    maxNodes: number;
    timeoutMilliseconds: number;
    maxTextLength: number;
  };
  screenshot: {
    maxWidth: number;
    jpegQuality: number;
  };
  visualMonitoring: {
    maxWidth: number;
    sampleIntervalMilliseconds: number;
    queueDepth: number;
    changeThreshold: number;
    signatureWidth: number;
    signatureHeight: number;
  };
  windowSelection: {
    minimumWidth: number;
    minimumHeight: number;
    maximumAspectRatio: number;
  };
};

export type NativeHelperConfiguration = Pick<
  ScreenObservationConfig,
  | "activityMonitoring"
  | "accessibility"
  | "screenshot"
  | "visualMonitoring"
  | "windowSelection"
>;

export type WindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowMetadata = {
  processIdentifier: number;
  bundleIdentifier?: string;
  applicationName: string;
  windowIdentifier?: number;
  title?: string;
  frame?: WindowFrame;
};

export type NativeActivitySignal = {
  kind: NativeActivityKind;
  occurredAt: string;
  window: WindowMetadata;
};

export type CaptureStatus =
  | "complete"
  | "permissionDenied"
  | "timedOut"
  | "unsupported"
  | "failed";

export type AccessibilityNode = {
  role: string;
  subrole?: string;
  title?: string;
  value?: string;
  identifier?: string;
  description?: string;
  frame?: WindowFrame;
  focused?: boolean;
  enabled?: boolean;
  selected?: boolean;
  children?: AccessibilityNode[];
};

export type AccessibilitySnapshot = {
  root: AccessibilityNode;
  nodeCount: number;
  truncated: boolean;
};

export type ScreenshotCapture = {
  status: CaptureStatus;
  durationMilliseconds: number;
  mimeType?: "image/jpeg";
  dataBase64?: string;
  width?: number;
  height?: number;
};

export type AccessibilityCapture = {
  status: CaptureStatus;
  durationMilliseconds: number;
  snapshot?: AccessibilitySnapshot;
};

export type NativeCaptureResult = {
  capturedAt: string;
  window: WindowMetadata;
  screenshot: ScreenshotCapture;
  accessibility: AccessibilityCapture;
  visualSignature?: number[];
};

export type PlannedCapture = {
  signal: NativeActivitySignal;
  dueAtMilliseconds: number;
};

export type ObservationContentSignature = {
  windowKey: string;
  accessibilityHash?: string;
  visualSignature?: number[];
};

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
