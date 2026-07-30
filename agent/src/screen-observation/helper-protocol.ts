import type {
  AccessibilityCapture,
  AccessibilityNode,
  AccessibilitySnapshot,
  CaptureStatus,
  NativeActivityKind,
  NativeActivitySignal,
  NativeCaptureResult,
  NativeHelperConfiguration,
  ScreenshotCapture,
  WindowFrame,
  WindowMetadata,
} from "./types.js";

export const HELPER_PROTOCOL_VERSION = 3 as const;
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
  "permissionDenied",
  "timedOut",
  "unsupported",
  "failed",
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
  protocolVersion: typeof HELPER_PROTOCOL_VERSION;
  requestId: string;
} & ({
  type: "configure";
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  configuration: NativeHelperConfiguration;
} | {
  type: "capture";
  signal: NativeActivitySignal;
} | {
  type: "shutdown";
});

export type HelperOutput = {
  protocolVersion: typeof HELPER_PROTOCOL_VERSION;
} & ({
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
  component: "accessibility" | "eventTap" | "screenCapture" | "visualStream";
  status: "ready" | "degraded" | "stopped";
  message?: string;
} | {
  type: "error";
  requestId?: string;
  code: string;
  message: string;
});

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

function integer(value: unknown) {
  const parsed = number(value);
  if (!Number.isInteger(parsed)) invalid();
  return parsed;
}

function optionalNumber(value: unknown) {
  return value === undefined || value === null ? undefined : number(value);
}

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid();
  return value;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) invalid();
  return value.map(text);
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
  return { kind, occurredAt, window: windowMetadata(item.window) };
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
  const result: ScreenshotCapture = {
    status: status(item.status),
    durationMilliseconds: number(item.durationMilliseconds),
    mimeType: optionalText(item.mimeType) as "image/jpeg" | undefined,
    dataBase64: optionalText(item.dataBase64),
    width: optionalNumber(item.width),
    height: optionalNumber(item.height),
  };
  if (result.mimeType !== undefined && result.mimeType !== "image/jpeg") invalid();
  if (
    result.status === "complete" &&
    (
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
  const result: AccessibilityCapture = {
    status: status(item.status),
    durationMilliseconds: number(item.durationMilliseconds),
    snapshot: item.snapshot === undefined ? undefined : accessibilitySnapshot(item.snapshot),
  };
  if (result.status === "complete" && result.snapshot === undefined) invalid();
  return result;
}

function captureResult(value: unknown): NativeCaptureResult {
  const item = record(value);
  const capturedAt = text(item.capturedAt);
  if (Number.isNaN(Date.parse(capturedAt))) invalid();
  let visualSignature: number[] | undefined;
  if (item.visualSignature !== undefined) {
    visualSignature = integerArray(item.visualSignature);
    if (visualSignature.some((pixel) => pixel < 0 || pixel > 255)) invalid();
  }
  return {
    capturedAt,
    window: windowMetadata(item.window),
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
  if (integer(value.protocolVersion) !== HELPER_PROTOCOL_VERSION) {
    throw new Error("Unsupported helper protocol version");
  }
  const type = text(value.type);
  if (type === "ready") {
    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
      type,
      processIdentifier: integer(value.processIdentifier),
    };
  }
  if (type === "configured") {
    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
      type,
      requestId: text(value.requestId),
    };
  }
  if (type === "signal") {
    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
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
      protocolVersion: HELPER_PROTOCOL_VERSION,
      type,
      requestId,
      result,
    };
  }
  if (type === "status") {
    const component = text(value.component);
    const helperStatus = text(value.status);
    if (
      !["accessibility", "eventTap", "screenCapture", "visualStream"].includes(component) ||
      !["ready", "degraded", "stopped"].includes(helperStatus)
    ) invalid();
    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
      type,
      component: component as Extract<HelperOutput, { type: "status" }>["component"],
      status: helperStatus as Extract<HelperOutput, { type: "status" }>["status"],
      message: optionalText(value.message),
    };
  }
  if (type === "error") {
    return {
      protocolVersion: HELPER_PROTOCOL_VERSION,
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
