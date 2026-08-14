import type {
  NativeActivitySignal,
  NativeCaptureResult,
  WindowMetadata,
} from "./native/protocol.js";

export type PersistedCaptureScreenshot = {
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sha256: string;
  bytes: number;
};

export type CaptureArtifactPersistence = {
  structuredPath: string;
  screenshot?: PersistedCaptureScreenshot;
};

export type CaptureArtifactStatus =
  | "complete"
  | "screenshot_only"
  | "ax_only"
  | "failed";

export type CaptureArtifact = {
  captureId: string;
  activityRevision: number;
  completedActivityRevision: number;
  contentEpoch: number;
  completedContentEpoch: number;
  signal: NativeActivitySignal;
  target: WindowMetadata;
  result: NativeCaptureResult;
  status: CaptureArtifactStatus;
  completedAtMilliseconds: number;
  persistence?: CaptureArtifactPersistence;
};

export type CaptureResolution = {
  decision: "join" | "reuse" | "new";
  intentRevision: number;
  intentContentEpoch: number;
  intentActivityKind: NativeActivitySignal["kind"];
  artifact: CaptureArtifact;
};
