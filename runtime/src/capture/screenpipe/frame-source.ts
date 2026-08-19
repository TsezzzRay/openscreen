import { basename } from "node:path";

export type ScreenFrameSource = {
  sourceId: string;
  generationId: string;
  frameId: string;
  monitorKey: string;
  deviceName: string;
  capturedAt: string;
  trigger: string;
  imagePath: string;
  application?: string;
  windowTitle?: string;
  url?: string;
  focused?: boolean;
  visibleText?: string;
};

export type ScreenpipeFrameRow = {
  id: unknown;
  timestamp: unknown;
  device_name: unknown;
  snapshot_path: unknown;
  capture_trigger: unknown;
  app_name: unknown;
  window_name: unknown;
  browser_url: unknown;
  focused: unknown;
  accessibility_text: unknown;
};

const SNAPSHOT_NAME = /^(\d+)_m(\d+)\.(?:jpg|jpeg)$/i;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function screenpipeSourceId(
  generationId: string,
  frameId: string,
): string {
  return `screenpipe-frame:${generationId}:${frameId}`;
}

export function screenpipeMonitorKey(snapshotPath: string): string | undefined {
  const match = SNAPSHOT_NAME.exec(basename(snapshotPath));
  if (!match) return undefined;
  const timestampMs = Number(match[1]);
  const monitorId = Number(match[2]);
  if (!Number.isSafeInteger(timestampMs) || !Number.isSafeInteger(monitorId)) {
    return undefined;
  }
  return String(monitorId);
}

export function screenpipeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetMatch = match[7] === "Z"
    ? undefined
    : /^[+-](\d{2}):?(\d{2})$/.exec(match[7]);
  if (match[7] !== "Z" && offsetMatch === null) return undefined;
  const offsetHours = offsetMatch?.[1] === undefined ? 0 : Number(offsetMatch[1]);
  const offsetMinutes = offsetMatch?.[2] === undefined ? 0 : Number(offsetMatch[2]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > (daysInMonth ?? 0)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59
  ) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function screenpipeRequiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

export function screenpipeNullableString(value: unknown): string | undefined | null {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}
