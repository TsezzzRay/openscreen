import type {
  CapturedAccessibility,
  CapturedContext,
} from "./api.js";
import type { CaptureArtifact } from "./artifact.js";
import {
  projectAccessibilityWithDiagnostics,
  type AccessibilityProjectionDiagnostics,
} from "./accessibility-projector.js";

export async function projectCapturedContext(
  artifact: CaptureArtifact,
  requestId: string | undefined,
  onAccessibilityProjection?: (
    diagnostics: AccessibilityProjectionDiagnostics,
  ) => void,
  intent: {
    intentRevision: number;
    intentContentEpoch: number;
  } = {
    intentRevision: artifact.activityRevision,
    intentContentEpoch: artifact.contentEpoch,
  },
): Promise<CapturedContext> {
  const windowIdentifier = artifact.target.windowIdentifier;
  if (windowIdentifier === undefined) {
    throw new Error("Capture artifact is missing an exact window identifier");
  }
  let accessibility: CapturedAccessibility | undefined;
  let accessibilityProjection: AccessibilityProjectionDiagnostics;
  try {
    const projected = projectAccessibilityWithDiagnostics(artifact);
    accessibility = projected.context;
    accessibilityProjection = projected.diagnostics;
    onAccessibilityProjection?.(projected.diagnostics);
  } catch {
    accessibilityProjection = {
      included: false,
      omittedReason: "projection_failed",
      projectedNodeCount: 0,
    };
    onAccessibilityProjection?.(accessibilityProjection);
  }
  const screenshot = artifact.result.screenshot;
  let image: CapturedContext["image"];
  const persistedScreenshot = artifact.persistence?.screenshot;
  if (
    screenshot.status === "complete" &&
    persistedScreenshot !== undefined &&
    persistedScreenshot.mimeType === "image/jpeg" &&
    persistedScreenshot.width === screenshot.width &&
    persistedScreenshot.height === screenshot.height
  ) {
    image = {
      path: persistedScreenshot.path,
      mimeType: persistedScreenshot.mimeType,
      width: persistedScreenshot.width,
      height: persistedScreenshot.height,
    };
  }
  const status = image !== undefined && accessibility !== undefined
    ? "complete"
    : image !== undefined
      ? "screenshot_only"
      : accessibility !== undefined
        ? "ax_only"
        : "unavailable";
  return {
    ...(requestId === undefined ? {} : { requestId }),
    captureId: artifact.captureId,
    occurredAt: artifact.signal.occurredAt,
    ...(artifact.result.startedAt === undefined
      ? {}
      : { startedAt: artifact.result.startedAt }),
    capturedAt: artifact.result.capturedAt,
    status,
    target: {
      application: {
        processIdentifier: artifact.target.processIdentifier,
        ...(artifact.target.bundleIdentifier === undefined
          ? {}
          : { bundleIdentifier: artifact.target.bundleIdentifier }),
        name: artifact.target.applicationName,
      },
      window: {
        identifier: windowIdentifier,
        ...(artifact.target.title === undefined
          ? {}
          : { title: artifact.target.title }),
        ...(artifact.target.frame === undefined
          ? {}
          : { frame: artifact.target.frame }),
      },
    },
    ...(image === undefined ? {} : { image }),
    ...(accessibility === undefined ? {} : { accessibility }),
    diagnostics: {
      intentRevision: intent.intentRevision,
      artifactRevision: artifact.activityRevision,
      completedRevision: artifact.completedActivityRevision,
      intentContentEpoch: intent.intentContentEpoch,
      artifactContentEpoch: artifact.contentEpoch,
      completedContentEpoch: artifact.completedContentEpoch,
      screenshotStatus: image === undefined ? "unavailable" : "available",
      accessibilityStatus: accessibility === undefined
        ? "unavailable"
        : "available",
      accessibilityProjection,
    },
  };
}
