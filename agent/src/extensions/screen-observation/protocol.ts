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

export type NativeHelperConfiguration = {
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
  visualSignature?: number[];
};

export type CaptureStatus =
  | "complete"
  | "partial"
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
  completedAt?: string;
  failureReason?: ScreenshotFailureReason;
  mimeType?: "image/jpeg";
  dataBase64?: string;
  width?: number;
  height?: number;
};

export type ScreenshotFailureReason =
  | "permission_denied"
  | "no_window"
  | "no_display"
  | "target_resolution_failed"
  | "capture_failed"
  | "jpeg_encoding_failed";

export type AccessibilityCapture = {
  status: CaptureStatus;
  quality?: AccessibilityQuality;
  durationMilliseconds: number;
  completedAt?: string;
  snapshot?: AccessibilitySnapshot;
  failureReason?: AccessibilityFailureReason;
  windowIdentifiers?: number[];
  missingWindowIdentifiers?: number[];
  activation?: {
    status: "enabled" | "cached" | "unsupported" | "failed";
    attempts: Array<{
      method: "enhanced_ui" | "manual_accessibility";
      status: "enabled" | "cached" | "unsupported" | "failed";
    }>;
    waitMilliseconds: number;
    nodeCountBefore?: number;
    nodeCountAfter?: number;
  };
  contentRootFound?: boolean;
  semanticNodeCount?: number;
  usefulTextCharacters?: number;
};

export type AccessibilityQuality =
  | "useful"
  | "shell_only"
  | "empty"
  | "unavailable";

export type CaptureWindowGroup = {
  processIdentifier: number;
  rootWindowIdentifier: number;
  memberWindowIdentifiers: number[];
  frame: WindowFrame;
};

export type AccessibilityFailureReason =
  | "permission_denied"
  | "focused_window_unavailable"
  | "target_mismatch"
  | "traversal_timed_out"
  | "snapshot_unavailable";

export type NativeCaptureResult = {
  startedAt?: string;
  capturedAt: string;
  validation: {
    preflightDurationMilliseconds: number;
    attestationDurationMilliseconds: number;
  };
  window: WindowMetadata;
  windowGroup?: CaptureWindowGroup;
  screenshot: ScreenshotCapture;
  accessibility: AccessibilityCapture;
  visualSignature?: number[];
};
const ACTIVITY_KINDS = new Set<NativeActivityKind>([
  "applicationActivated",
  "focusedWindowChanged",
  "focusedElementChanged",
  "mouseClick",
  "keyActivity",
  "accessibilityChanged",
  "visualChanged",
  "spaceChanged",
  "wake",
]);
const CAPTURE_STATUSES = new Set<CaptureStatus>([
  "complete",
  "partial",
  "permissionDenied",
  "timedOut",
  "unsupported",
  "failed",
]);
const ACCESSIBILITY_FAILURE_REASONS = new Set<AccessibilityFailureReason>([
  "permission_denied",
  "focused_window_unavailable",
  "target_mismatch",
  "traversal_timed_out",
  "snapshot_unavailable",
]);
const SCREENSHOT_FAILURE_REASONS = new Set<ScreenshotFailureReason>([
  "permission_denied",
  "no_window",
  "no_display",
  "target_resolution_failed",
  "capture_failed",
  "jpeg_encoding_failed",
]);
const ACCESSIBILITY_QUALITIES = new Set<AccessibilityQuality>([
  "useful",
  "shell_only",
  "empty",
  "unavailable",
]);

export class NonJSONHelperOutputError extends Error {
  constructor() {
    super("Non-JSON helper output");
    this.name = "NonJSONHelperOutputError";
  }
}

export class InvalidCaptureResultError extends Error {
  constructor(readonly requestId: string) {
    super("Invalid helper capture result");
    this.name = "InvalidCaptureResultError";
  }
}

export type HelperCommand = {
  requestId: string;
} & ({
  type: "configure";
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  configuration: NativeHelperConfiguration;
} | {
  type: "capture";
  target: WindowMetadata;
} | {
  type: "shutdown";
});

export type HelperOutput = {
  type: "ready";
  processIdentifier: number;
} | {
  type: "configured";
  requestId: string;
} | {
  type: "signal";
  signal: NativeActivitySignal;
} | {
  type: "captureResult";
  requestId: string;
  result: NativeCaptureResult;
} | {
  type: "status";
  component: "accessibility" | "eventTap" | "visualStream";
  status: "ready" | "degraded" | "stopped";
  message?: string;
} | {
  type: "diagnostic";
  event:
    | "cached_target_rejected"
    | "visual.stream_stopped"
    | "visual.restarting"
    | "visual.recovered";
  reason?: string;
  generation?: number;
  windowIdentifier?: number;
  delayMilliseconds?: number;
} | {
  type: "error";
  requestId?: string;
  code: string;
  message: string;
};

function invalid(): never {
  throw new Error("Invalid helper message");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid();
  return value.trim().length === 0 ? undefined : value;
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function nonNegativeNumber(value: unknown) {
  const parsed = number(value);
  if (parsed < 0) invalid();
  return parsed;
}

function integer(value: unknown) {
  const parsed = number(value);
  if (!Number.isInteger(parsed)) invalid();
  return parsed;
}

function nonNegativeInteger(value: unknown) {
  const parsed = integer(value);
  if (parsed < 0) invalid();
  return parsed;
}

function timestamp(value: unknown) {
  const parsed = text(value);
  if (Number.isNaN(Date.parse(parsed))) invalid();
  return parsed;
}

function boolean(value: unknown) {
  if (typeof value !== "boolean") invalid();
  return value;
}

function optionalNumber(value: unknown) {
  return value === undefined || value === null ? undefined : number(value);
}

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid();
  return value;
}

function integerArray(value: unknown) {
  if (!Array.isArray(value)) invalid();
  return value.map(integer);
}

function frame(value: unknown): WindowFrame {
  const item = record(value);
  return {
    x: number(item.x),
    y: number(item.y),
    width: number(item.width),
    height: number(item.height),
  };
}

function windowMetadata(value: unknown): WindowMetadata {
  const item = record(value);
  const bundleIdentifier = optionalText(item.bundleIdentifier);
  const windowIdentifier = optionalNumber(item.windowIdentifier);
  const title = optionalText(item.title);
  return {
    processIdentifier: integer(item.processIdentifier),
    applicationName: text(item.applicationName),
    ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
    ...(windowIdentifier === undefined ? {} : { windowIdentifier }),
    ...(title === undefined ? {} : { title }),
    ...(item.frame === undefined ? {} : { frame: frame(item.frame) }),
  };
}

function activitySignal(value: unknown): NativeActivitySignal {
  const item = record(value);
  const kind = text(item.kind) as NativeActivityKind;
  if (!ACTIVITY_KINDS.has(kind)) invalid();
  const occurredAt = text(item.occurredAt);
  if (Number.isNaN(Date.parse(occurredAt))) invalid();
  let visualSignature: number[] | undefined;
  if (item.visualSignature !== undefined) {
    if (kind !== "visualChanged") invalid();
    visualSignature = integerArray(item.visualSignature);
    if (
      visualSignature.length === 0 ||
      visualSignature.some((pixel) => pixel < 0 || pixel > 255)
    ) invalid();
  }
  return {
    kind,
    occurredAt,
    window: windowMetadata(item.window),
    ...(visualSignature === undefined ? {} : { visualSignature }),
  };
}

function status(value: unknown): CaptureStatus {
  const parsed = text(value) as CaptureStatus;
  if (!CAPTURE_STATUSES.has(parsed)) invalid();
  return parsed;
}

function accessibilityNode(value: unknown): AccessibilityNode {
  const item = record(value);
  return {
    role: text(item.role),
    subrole: optionalText(item.subrole),
    title: optionalText(item.title),
    value: optionalText(item.value),
    identifier: optionalText(item.identifier),
    description: optionalText(item.description),
    frame: item.frame === undefined ? undefined : frame(item.frame),
    focused: optionalBoolean(item.focused),
    enabled: optionalBoolean(item.enabled),
    selected: optionalBoolean(item.selected),
    children: item.children === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(item.children)) invalid();
          return item.children.map(accessibilityNode);
        })(),
  };
}

function accessibilitySnapshot(value: unknown): AccessibilitySnapshot {
  const item = record(value);
  if (typeof item.truncated !== "boolean") invalid();
  return {
    root: accessibilityNode(item.root),
    nodeCount: integer(item.nodeCount),
    truncated: item.truncated,
  };
}

function screenshotCapture(value: unknown): ScreenshotCapture {
  const item = record(value);
  const failureReason = optionalText(item.failureReason) as
    | ScreenshotFailureReason
    | undefined;
  if (
    failureReason !== undefined &&
    !SCREENSHOT_FAILURE_REASONS.has(failureReason)
  ) invalid();
  const result: ScreenshotCapture = {
    status: status(item.status),
    durationMilliseconds: number(item.durationMilliseconds),
    completedAt: timestamp(item.completedAt),
    failureReason,
    mimeType: optionalText(item.mimeType) as "image/jpeg" | undefined,
    dataBase64: optionalText(item.dataBase64),
    width: optionalNumber(item.width),
    height: optionalNumber(item.height),
  };
  if (result.mimeType !== undefined && result.mimeType !== "image/jpeg") invalid();
  if (
    result.status === "complete" &&
    (
      result.failureReason !== undefined ||
      result.mimeType !== "image/jpeg" ||
      result.dataBase64 === undefined ||
      result.width === undefined ||
      result.height === undefined
    )
  ) invalid();
  return result;
}

function accessibilityCapture(value: unknown): AccessibilityCapture {
  const item = record(value);
  const quality = text(item.quality) as AccessibilityQuality;
  if (!ACCESSIBILITY_QUALITIES.has(quality)) invalid();
  const failureReason = optionalText(item.failureReason) as
    | AccessibilityFailureReason
    | undefined;
  if (
    failureReason !== undefined &&
    !ACCESSIBILITY_FAILURE_REASONS.has(failureReason)
  ) invalid();
  let activation: AccessibilityCapture["activation"];
  if (item.activation !== undefined) {
    const activationValue = record(item.activation);
    const activationStatus = text(activationValue.status);
    if (![
      "enabled",
      "cached",
      "unsupported",
      "failed",
    ].includes(activationStatus)) invalid();
    const nodeCountBefore = optionalNumber(activationValue.nodeCountBefore);
    const nodeCountAfter = optionalNumber(activationValue.nodeCountAfter);
    if (
      (nodeCountBefore !== undefined &&
        (!Number.isInteger(nodeCountBefore) || nodeCountBefore < 0)) ||
      (nodeCountAfter !== undefined &&
        (!Number.isInteger(nodeCountAfter) || nodeCountAfter < 0))
    ) invalid();
    if (!Array.isArray(activationValue.attempts)) invalid();
    const attempts = activationValue.attempts.map((value) => {
      const attempt = record(value);
      const method = text(attempt.method);
      const status = text(attempt.status);
      if (![
        "enhanced_ui",
        "manual_accessibility",
      ].includes(method) || ![
        "enabled",
        "cached",
        "unsupported",
        "failed",
      ].includes(status)) invalid();
      return {
        method: method as "enhanced_ui" | "manual_accessibility",
        status: status as "enabled" | "cached" | "unsupported" | "failed",
      };
    });
    activation = {
      status: activationStatus as NonNullable<
        AccessibilityCapture["activation"]
      >["status"],
      attempts,
      waitMilliseconds: nonNegativeNumber(activationValue.waitMilliseconds),
      ...(nodeCountBefore === undefined ? {} : { nodeCountBefore }),
      ...(nodeCountAfter === undefined ? {} : { nodeCountAfter }),
    };
  }
  const result: AccessibilityCapture = {
    status: status(item.status),
    quality,
    durationMilliseconds: number(item.durationMilliseconds),
    completedAt: timestamp(item.completedAt),
    snapshot: item.snapshot === undefined ? undefined : accessibilitySnapshot(item.snapshot),
    failureReason,
    activation,
    windowIdentifiers: item.windowIdentifiers === undefined
      ? undefined
      : integerArray(item.windowIdentifiers),
    missingWindowIdentifiers: item.missingWindowIdentifiers === undefined
      ? undefined
      : integerArray(item.missingWindowIdentifiers),
    contentRootFound: boolean(item.contentRootFound),
    semanticNodeCount: nonNegativeInteger(item.semanticNodeCount),
    usefulTextCharacters: nonNegativeInteger(item.usefulTextCharacters),
  };
  if (
    (result.status === "complete" || result.status === "partial") &&
    result.snapshot === undefined
  ) invalid();
  return result;
}

function captureWindowGroup(value: unknown): CaptureWindowGroup {
  const item = record(value);
  return {
    processIdentifier: integer(item.processIdentifier),
    rootWindowIdentifier: integer(item.rootWindowIdentifier),
    memberWindowIdentifiers: integerArray(item.memberWindowIdentifiers),
    frame: frame(item.frame),
  };
}

function captureResult(value: unknown): NativeCaptureResult {
  const item = record(value);
  const startedAt = timestamp(item.startedAt);
  const capturedAt = timestamp(item.capturedAt);
  const validation = record(item.validation);
  let visualSignature: number[] | undefined;
  if (item.visualSignature !== undefined) {
    visualSignature = integerArray(item.visualSignature);
    if (visualSignature.some((pixel) => pixel < 0 || pixel > 255)) invalid();
  }
  return {
    startedAt,
    capturedAt,
    validation: {
      preflightDurationMilliseconds: nonNegativeNumber(
        validation.preflightDurationMilliseconds,
      ),
      attestationDurationMilliseconds: nonNegativeNumber(
        validation.attestationDurationMilliseconds,
      ),
    },
    window: windowMetadata(item.window),
    windowGroup: item.windowGroup === undefined
      ? undefined
      : captureWindowGroup(item.windowGroup),
    screenshot: screenshotCapture(item.screenshot),
    accessibility: accessibilityCapture(item.accessibility),
    visualSignature,
  };
}

export function parseHelperOutput(line: string): HelperOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new NonJSONHelperOutputError();
  }
  const value = record(parsed);
  const type = text(value.type);
  if (type === "ready") {
    return {
      type,
      processIdentifier: integer(value.processIdentifier),
    };
  }
  if (type === "configured") {
    return {
      type,
      requestId: text(value.requestId),
    };
  }
  if (type === "signal") {
    return {
      type,
      signal: activitySignal(value.signal),
    };
  }
  if (type === "captureResult") {
    const requestId = text(value.requestId);
    let result: NativeCaptureResult;
    try {
      result = captureResult(value.result);
    } catch {
      throw new InvalidCaptureResultError(requestId);
    }
    return {
      type,
      requestId,
      result,
    };
  }
  if (type === "status") {
    const component = text(value.component);
    const helperStatus = text(value.status);
    if (
      !["accessibility", "eventTap", "visualStream"].includes(component) ||
      !["ready", "degraded", "stopped"].includes(helperStatus)
    ) invalid();
    return {
      type,
      component: component as Extract<HelperOutput, { type: "status" }>["component"],
      status: helperStatus as Extract<HelperOutput, { type: "status" }>["status"],
      message: optionalText(value.message),
    };
  }
  if (type === "diagnostic") {
    const event = text(value.event);
    if (![
      "cached_target_rejected",
      "visual.stream_stopped",
      "visual.restarting",
      "visual.recovered",
    ].includes(event)) invalid();
    const generation = optionalNumber(value.generation);
    const windowIdentifier = optionalNumber(value.windowIdentifier);
    const delayMilliseconds = optionalNumber(value.delayMilliseconds);
    if (
      [generation, windowIdentifier, delayMilliseconds].some((candidate) =>
        candidate !== undefined &&
        (!Number.isInteger(candidate) || candidate < 0)
      )
    ) invalid();
    return {
      type,
      event: event as Extract<HelperOutput, { type: "diagnostic" }>["event"],
      reason: optionalText(value.reason),
      ...(generation === undefined ? {} : { generation }),
      ...(windowIdentifier === undefined ? {} : { windowIdentifier }),
      ...(delayMilliseconds === undefined ? {} : { delayMilliseconds }),
    };
  }
  if (type === "error") {
    return {
      type,
      requestId: optionalText(value.requestId),
      code: text(value.code),
      message: text(value.message),
    };
  }
  return invalid();
}

export function encodeHelperCommand(command: HelperCommand) {
  return `${JSON.stringify(command)}\n`;
}
