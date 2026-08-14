export type CapturedImage = {
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
};

export type CapturedApplication = {
  processIdentifier: number;
  bundleIdentifier?: string;
  name: string;
};

export type CapturedWindow = {
  identifier: number;
  title?: string;
  frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type CapturedAccessibility = {
  captureId: string;
  application: string;
  windowTitle?: string;
  url?: string;
  focusedElement?: {
    role: string;
    title?: string;
    value?: string;
  };
  elements?: Array<{
    role: string;
    name?: string;
    value?: string;
    enabled?: boolean;
    selected?: boolean;
  }>;
  visibleText?: string;
};

export type CapturedContextStatus =
  | "complete"
  | "screenshot_only"
  | "ax_only"
  | "unavailable";

export type CaptureDiagnosticMetadata = {
  intentRevision: number;
  artifactRevision: number;
  completedRevision: number;
  intentContentEpoch: number;
  artifactContentEpoch: number;
  completedContentEpoch: number;
  screenshotStatus: "available" | "unavailable";
  accessibilityStatus: "available" | "unavailable";
  accessibilityProjection?: {
    included: boolean;
    omittedReason?:
      | "capture_unavailable"
      | "no_useful_content"
      | "projection_failed";
    projectedNodeCount: number;
    projectedCharacters?: number;
    candidateNodeCount?: number;
    usefulTextCharacters?: number;
    uniqueTextBlocks?: number;
    contentRootFound?: boolean;
    projectionTruncated?: boolean;
  };
};

export type CapturedContext = {
  requestId?: string;
  captureId: string;
  occurredAt: string;
  startedAt?: string;
  capturedAt: string;
  status: CapturedContextStatus;
  target: {
    application: CapturedApplication;
    window: CapturedWindow;
  };
  image?: CapturedImage;
  accessibility?: CapturedAccessibility;
  diagnostics: CaptureDiagnosticMetadata;
};

export interface CaptureService {
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(requestId: string, signal?: AbortSignal): Promise<CapturedContext>;
}
