import { DatabaseSync } from "node:sqlite";

import {
  screenpipeMonitorKey,
  screenpipeNullableString,
  screenpipeRequiredString,
  screenpipeSourceId,
  screenpipeTimestamp,
  type ScreenFrameSource,
  type ScreenpipeFrameRow,
} from "./frame-source.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_SAFE_SQLITE_ID = 9_007_199_254_740_991;
const MAX_INCREMENTAL_FRAME_LIMIT = 1_000;
const FRAME_COLUMNS = `
  id,
  timestamp,
  device_name,
  snapshot_path,
  capture_trigger,
  app_name,
  window_name,
  browser_url,
  focused,
  accessibility_text
`;

export type ScreenpipeDatabase = {
  close(): void;
  framesAfter(cursor: number, limit: number): ScreenpipeFrameBatch;
};

export type ScreenpipeFrameBatch = {
  frames: ScreenFrameSource[];
  cursor: number;
  hasMore: boolean;
};

function optionalString(
  value: unknown,
): { valid: true; value?: string } | { valid: false } {
  const mapped = screenpipeNullableString(value);
  if (mapped === undefined) return { valid: false };
  return mapped === null
    ? { valid: true }
    : { valid: true, value: mapped };
}

// screenpipe's native `ignoredWindows` recorder option (see recorder.ts) does
// not reliably keep this app's own window out of `frames` — confirmed against
// live capture data (OpenScreen was ~57% of frames in one generation). This
// re-checks the same config at the read boundary as a backstop, matching
// screenpipe's own legacy (unscoped) pattern semantics: case-insensitive
// substring match against either the app name or the window title.
function matchesIgnoredWindow(
  ignoredWindows: readonly string[],
  application: string | undefined,
  windowTitle: string | undefined,
): boolean {
  const app = (application ?? "").toLowerCase();
  const title = (windowTitle ?? "").toLowerCase();
  return ignoredWindows.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "") return false;
    return app.includes(pattern) || title.includes(pattern);
  });
}

type ProjectedFrame = {
  frame: ScreenFrameSource;
  timestampMs: number;
  id: number;
};

function projectFrame(
  row: ScreenpipeFrameRow,
  generationId: string,
  ignoredWindows: readonly string[],
): ProjectedFrame | undefined {
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0) {
    return undefined;
  }
  const capturedAt = screenpipeTimestamp(row.timestamp);
  const deviceName = screenpipeRequiredString(row.device_name);
  const imagePath = screenpipeRequiredString(row.snapshot_path);
  const trigger = screenpipeRequiredString(row.capture_trigger);
  const monitorKey = imagePath === undefined
    ? undefined
    : screenpipeMonitorKey(imagePath);
  if (
    capturedAt === undefined
    || deviceName === undefined
    || imagePath === undefined
    || trigger === undefined
    || monitorKey === undefined
  ) {
    return undefined;
  }

  const application = optionalString(row.app_name);
  const windowTitle = optionalString(row.window_name);
  const url = optionalString(row.browser_url);
  const visibleText = screenpipeNullableString(row.accessibility_text);
  if (
    !application.valid
    || !windowTitle.valid
    || !url.valid
    || visibleText === undefined
  ) {
    return undefined;
  }
  if (matchesIgnoredWindow(ignoredWindows, application.value, windowTitle.value)) {
    return undefined;
  }

  let focused: boolean | undefined;
  if (row.focused !== null) {
    if (row.focused !== 0 && row.focused !== 1) return undefined;
    focused = row.focused === 1;
  }

  const frame: ScreenFrameSource = {
    sourceId: screenpipeSourceId(generationId, String(row.id)),
    generationId,
    frameId: String(row.id),
    monitorKey,
    deviceName,
    capturedAt,
    trigger,
    imagePath,
    ...(application.value === undefined ? {} : { application: application.value }),
    ...(windowTitle.value === undefined ? {} : { windowTitle: windowTitle.value }),
    ...(url.value === undefined ? {} : { url: url.value }),
    ...(focused === undefined ? {} : { focused }),
    ...(visibleText === null ? {} : { visibleText }),
  };
  return {
    frame,
    timestampMs: Date.parse(capturedAt),
    id: row.id,
  };
}

function incrementalCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_SQLITE_ID) {
    throw new Error("Screenpipe frame cursor must be a non-negative safe SQLite id");
  }
  return value;
}

function incrementalLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_INCREMENTAL_FRAME_LIMIT
  ) {
    throw new Error(
      `Screenpipe frame limit must be a safe integer from 1 to ${MAX_INCREMENTAL_FRAME_LIMIT}`,
    );
  }
  return value;
}

class OpenScreenpipeDatabase implements ScreenpipeDatabase {
  private readonly framesAfterScan;

  constructor(
    private readonly connection: DatabaseSync,
    private readonly generationId: string,
    private readonly ignoredWindows: readonly string[],
  ) {
    this.framesAfterScan = connection.prepare(`
      SELECT
        ${FRAME_COLUMNS}
      FROM frames
      WHERE typeof(id) = 'integer'
        AND id > ?
        AND id <= ${MAX_SAFE_SQLITE_ID}
      ORDER BY id ASC
      LIMIT ?
    `);
  }

  close(): void {
    if (this.connection.isOpen) this.connection.close();
  }

  framesAfter(cursor: number, limit: number): ScreenpipeFrameBatch {
    const after = incrementalCursor(cursor);
    const boundedLimit = incrementalLimit(limit);
    const rows = this.framesAfterScan.all(
      after,
      boundedLimit + 1,
    ) as unknown as ScreenpipeFrameRow[];
    const scannedRows = rows.slice(0, boundedLimit);
    let nextCursor = after;
    const frames: ScreenFrameSource[] = [];
    for (const row of scannedRows) {
      if (
        typeof row.id === "number" &&
        Number.isSafeInteger(row.id) &&
        row.id > nextCursor
      ) {
        nextCursor = row.id;
      }
      const projected = projectFrame(row, this.generationId, this.ignoredWindows);
      if (projected !== undefined) frames.push({ ...projected.frame });
    }
    return {
      frames,
      cursor: nextCursor,
      hasMore: rows.length > boundedLimit,
    };
  }
}

export function openScreenpipeDatabase(
  path: string,
  generationId: string,
  ignoredWindows: readonly string[],
): ScreenpipeDatabase {
  if (typeof generationId !== "string" || generationId.trim().length === 0) {
    throw new Error("generationId must be a non-empty string");
  }
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
    return new OpenScreenpipeDatabase(connection, generationId, ignoredWindows);
  } catch (error) {
    connection.close();
    throw error;
  }
}
