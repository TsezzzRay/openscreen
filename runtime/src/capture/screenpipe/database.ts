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
  latestFrames(): ScreenFrameSource[];
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

function projectFrame(
  row: ScreenpipeFrameRow,
  generationId: string,
): { frame: ScreenFrameSource; timestampMs: number; id: number } | undefined {
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

function sameProjectedFrame(
  left: ScreenFrameSource,
  right: ScreenFrameSource,
): boolean {
  return left.sourceId === right.sourceId
    && left.generationId === right.generationId
    && left.frameId === right.frameId
    && left.monitorKey === right.monitorKey
    && left.deviceName === right.deviceName
    && left.capturedAt === right.capturedAt
    && left.trigger === right.trigger
    && left.imagePath === right.imagePath
    && left.application === right.application
    && left.windowTitle === right.windowTitle
    && left.url === right.url
    && left.focused === right.focused
    && left.visibleText === right.visibleText;
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
  private readonly frameScan;
  private readonly frameById;
  private readonly framesAfterScan;
  private lastScannedFrameId = 0;
  private readonly latestByMonitor = new Map<string, {
    frame: ScreenFrameSource;
    timestampMs: number;
    id: number;
  }>();

  constructor(private readonly connection: DatabaseSync, private readonly generationId: string) {
    this.frameScan = connection.prepare(`
      SELECT
        ${FRAME_COLUMNS}
      FROM frames
      WHERE typeof(id) = 'integer'
        AND id > ?
        AND id <= ${MAX_SAFE_SQLITE_ID}
      ORDER BY id ASC
    `);
    this.frameById = connection.prepare(`
      SELECT
        ${FRAME_COLUMNS}
      FROM frames
      WHERE typeof(id) = 'integer'
        AND id = ?
        AND id <= ${MAX_SAFE_SQLITE_ID}
    `);
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

  latestFrames(): ScreenFrameSource[] {
    const priorCursor = this.lastScannedFrameId;
    const priorLatest = new Map(this.latestByMonitor);
    this.connection.exec("BEGIN");
    try {
      let rebuild = false;
      for (const winner of this.latestByMonitor.values()) {
        const rawRow = this.frameById.get(winner.id);
        const row = rawRow === undefined
          ? undefined
          : rawRow as unknown as ScreenpipeFrameRow;
        const projected = row === undefined
          ? undefined
          : projectFrame(row, this.generationId);
        if (
          projected === undefined
          || !sameProjectedFrame(winner.frame, projected.frame)
        ) {
          rebuild = true;
          break;
        }
      }

      if (rebuild) {
        this.latestByMonitor.clear();
        this.lastScannedFrameId = 0;
      }
      for (const rawRow of this.frameScan.iterate(this.lastScannedFrameId)) {
        const row = rawRow as unknown as ScreenpipeFrameRow;
        if (
          typeof row.id === "number"
          && Number.isSafeInteger(row.id)
          && row.id > this.lastScannedFrameId
        ) {
          this.lastScannedFrameId = row.id;
        }
        const projected = projectFrame(row, this.generationId);
        if (projected === undefined) continue;
        const prior = this.latestByMonitor.get(projected.frame.monitorKey);
        if (
          prior === undefined
          || projected.timestampMs > prior.timestampMs
          || (
            projected.timestampMs === prior.timestampMs
            && projected.id > prior.id
          )
        ) {
          this.latestByMonitor.set(projected.frame.monitorKey, projected);
        }
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original query error.
      }
      this.lastScannedFrameId = priorCursor;
      this.latestByMonitor.clear();
      for (const [monitorKey, winner] of priorLatest) {
        this.latestByMonitor.set(monitorKey, winner);
      }
      throw error;
    }
    return [...this.latestByMonitor.values()]
      .sort((left, right) => (
        Number(left.frame.monitorKey) - Number(right.frame.monitorKey)
      ))
      .map((item) => ({ ...item.frame }));
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
      const projected = projectFrame(row, this.generationId);
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
): ScreenpipeDatabase {
  if (typeof generationId !== "string" || generationId.trim().length === 0) {
    throw new Error("generationId must be a non-empty string");
  }
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
    return new OpenScreenpipeDatabase(connection, generationId);
  } catch (error) {
    connection.close();
    throw error;
  }
}
