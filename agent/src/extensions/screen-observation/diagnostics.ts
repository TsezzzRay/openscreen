import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

import type { ScreenshotCapture } from "./protocol.js";
import type {
  AccessibilityQuality,
  CaptureStatus,
  NativeActivityKind,
  ScreenshotFailureReason,
} from "./protocol.js";

export type CaptureDiagnosticEventName =
  | "activity.capture_skipped"
  | "activity.covered_by_request"
  | "activity.planner_decision"
  | "activity.due_selected"
  | "activity.due_collapsed"
  | "activity.rate_limited"
  | "activity.boundary_superseded"
  | "helper.component_status"
  | "cached_target_rejected"
  | "visual.stream_stopped"
  | "visual.restarting"
  | "visual.recovered"
  | "capture.intent_received"
  | "capture.decision"
  | "capture.skipped"
  | "capture.started"
  | "capture.completed"
  | "capture.attestation_failed"
  | "capture.consumer_cancelled"
  | "capture.persistence_failed"
  | "target_invalidated"
  | "observation.resolved"
  | "chat.context_attached";

export type CaptureDiagnosticEvent = {
  event: CaptureDiagnosticEventName;
  intentId?: string;
  requestId?: string;
  captureId?: string;
  observationId?: string;
  consumer?: "activity" | "request";
  targetKey?: string;
  activityRevision?: number;
  intentRevision?: number;
  artifactRevision?: number;
  completedRevision?: number;
  contentEpoch?: number;
  intentContentEpoch?: number;
  artifactContentEpoch?: number;
  completedContentEpoch?: number;
  activityKind?: NativeActivityKind;
  activityRevisionEnd?: number;
  activityChangedDuringCapture?: boolean;
  decision?: "join" | "reuse" | "new" | "unavailable";
  reason?: string;
  cachedAgeMs?: number;
  queueWaitMs?: number;
  preflightMs?: number;
  screenshotMs?: number;
  accessibilityMs?: number;
  attestationMs?: number;
  totalMs?: number;
  persistenceMs?: number;
  servedConsumerCount?: number;
  captureStartedAt?: string;
  screenshotCompletedAt?: string;
  accessibilityCompletedAt?: string;
  captureCompletedAt?: string;
  semanticChanged?: boolean;
  visualChanged?: boolean;
  visualDistance?: number;
  plannerDecision?: "scheduled" | "deduplicated" | "coalesced";
  scheduledDelayMs?: number;
  supersededCount?: number;
  coveredPendingCount?: number;
  coveredDeferred?: boolean;
  nextEligibleMs?: number;
  generation?: number;
  restartDelayMs?: number;
  rootWindowIdentifier?: number;
  memberWindowCount?: number;
  component?: "accessibility" | "eventTap" | "visualStream";
  componentStatus?: "ready" | "degraded" | "stopped";
  status?: "complete" | "screenshot_only" | "ax_only" | "failed";
  result?: "created" | "reused" | "unavailable";
  contextMode?: "both" | "screenshot_only" | "ax_only" | "none";
  screenshot?: {
    status: CaptureStatus;
    failureReason?: ScreenshotFailureReason;
    mimeType?: "image/jpeg";
    width?: number;
    height?: number;
    bytes?: number;
  };
  accessibility?: {
    status: string;
    quality?: AccessibilityQuality;
    failureReason?: string;
    nodeCount?: number;
    truncated?: boolean;
    included?: boolean;
    omittedReason?: string;
    projectedNodeCount?: number;
    projectedCharacters?: number;
    candidateNodeCount?: number;
    usefulTextCharacters?: number;
    semanticNodeCount?: number;
    uniqueTextBlocks?: number;
    contentRootFound?: boolean;
    projectionTruncated?: boolean;
    activationStatus?: "enabled" | "cached" | "unsupported" | "failed";
    activationWaitMs?: number;
    activationNodeCountBefore?: number;
    activationNodeCountAfter?: number;
    activationAttempts?: Array<{
      method: "enhanced_ui" | "manual_accessibility";
      status: "enabled" | "cached" | "unsupported" | "failed";
    }>;
    capturedWindowCount?: number;
    missingWindowCount?: number;
  };
};

export type CaptureDiagnosticsSink = {
  emit(event: CaptureDiagnosticEvent): void;
};

export function screenshotDiagnosticFields(
  screenshot: ScreenshotCapture,
): Pick<CaptureDiagnosticEvent, "screenshot"> {
  if (
    screenshot.status !== "complete" ||
    screenshot.mimeType !== "image/jpeg" ||
    screenshot.dataBase64 === undefined ||
    screenshot.width === undefined ||
    screenshot.height === undefined
  ) {
    return {
      screenshot: {
        status: screenshot.status,
        ...(screenshot.failureReason === undefined
          ? {}
          : { failureReason: screenshot.failureReason }),
      },
    };
  }
  return {
    screenshot: {
      status: screenshot.status,
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      bytes: Buffer.from(screenshot.dataBase64, "base64").byteLength,
    },
  };
}

type CaptureDiagnosticsOptions = {
  directory: string;
  retentionMilliseconds: number;
  now?: () => Date;
  onError?: (error: Error) => void;
};

const ALLOWED_KEYS = new Set([
  "event",
  "intentId",
  "requestId",
  "captureId",
  "observationId",
  "consumer",
  "targetKey",
  "activityRevision",
  "intentRevision",
  "artifactRevision",
  "completedRevision",
  "contentEpoch",
  "intentContentEpoch",
  "artifactContentEpoch",
  "completedContentEpoch",
  "activityKind",
  "activityRevisionEnd",
  "activityChangedDuringCapture",
  "decision",
  "reason",
  "cachedAgeMs",
  "queueWaitMs",
  "preflightMs",
  "screenshotMs",
  "accessibilityMs",
  "attestationMs",
  "totalMs",
  "persistenceMs",
  "servedConsumerCount",
  "captureStartedAt",
  "screenshotCompletedAt",
  "accessibilityCompletedAt",
  "captureCompletedAt",
  "semanticChanged",
  "visualChanged",
  "visualDistance",
  "plannerDecision",
  "scheduledDelayMs",
  "supersededCount",
  "coveredPendingCount",
  "coveredDeferred",
  "nextEligibleMs",
  "generation",
  "restartDelayMs",
  "rootWindowIdentifier",
  "memberWindowCount",
  "component",
  "componentStatus",
  "status",
  "result",
  "contextMode",
  "screenshot",
  "accessibility",
]);

export class CaptureDiagnostics implements CaptureDiagnosticsSink {
  private writes = Promise.resolve();
  private cleanedDay?: string;
  private readonly now: () => Date;

  constructor(private readonly options: CaptureDiagnosticsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  emit(event: CaptureDiagnosticEvent) {
    const timestamp = this.now();
    const safe = sanitize(event);
    this.writes = this.writes.then(async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await chmod(this.options.directory, 0o700);
      const day = timestamp.toISOString().slice(0, 10);
      if (this.cleanedDay !== day) {
        await this.cleanup(timestamp.getTime());
        this.cleanedDay = day;
      }
      const path = join(
        this.options.directory,
        "capture-events-" + day + ".jsonl",
      );
      await appendFile(path, JSON.stringify({
        timestamp: timestamp.toISOString(),
        ...safe,
      }) + "\n", { mode: 0o600 });
      await chmod(path, 0o600);
    }).catch((error) => {
      const normalized = error instanceof Error
        ? error
        : new Error("Unknown capture diagnostics error");
      if (this.options.onError !== undefined) this.options.onError(normalized);
      else {
        process.stderr.write(
          "OpenScreen capture diagnostics unavailable: " +
          normalized.message +
          "\n",
        );
      }
    });
  }

  async flush() {
    await this.writes;
  }

  private async cleanup(nowMilliseconds: number) {
    const names = await readdir(this.options.directory);
    await Promise.all(names.map(async (name) => {
      if (!/^capture-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) return;
      const path = join(this.options.directory, name);
      const metadata = await stat(path);
      if (
        nowMilliseconds - metadata.mtimeMs >
        this.options.retentionMilliseconds
      ) {
        await rm(path);
      }
    }));
  }
}

function sanitize(
  event: CaptureDiagnosticEvent,
): CaptureDiagnosticEvent {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_KEYS.has(key) || value === undefined) continue;
    if (key === "screenshot" && isRecord(value)) {
      safe.screenshot = pick(value, [
        "status",
        "failureReason",
        "mimeType",
        "width",
        "height",
        "bytes",
      ]);
      continue;
    }
    if (key === "accessibility" && isRecord(value)) {
      const recordValue: Record<string, unknown> = value;
      const accessibility: Record<string, unknown> = pick(recordValue, [
        "status",
        "quality",
        "failureReason",
        "nodeCount",
        "truncated",
        "included",
        "omittedReason",
        "projectedNodeCount",
        "projectedCharacters",
        "candidateNodeCount",
        "usefulTextCharacters",
        "semanticNodeCount",
        "uniqueTextBlocks",
        "contentRootFound",
        "projectionTruncated",
        "activationStatus",
        "activationWaitMs",
        "activationNodeCountBefore",
        "activationNodeCountAfter",
        "capturedWindowCount",
        "missingWindowCount",
      ]);
      if (Array.isArray(recordValue.activationAttempts)) {
        const activationAttempts: unknown[] = recordValue.activationAttempts;
        accessibility.activationAttempts = activationAttempts
          .filter(isRecord)
          .map((attempt) => pick(attempt, ["method", "status"]));
      }
      safe.accessibility = accessibility;
      continue;
    }
    safe[key] = value;
  }
  return safe as CaptureDiagnosticEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}
