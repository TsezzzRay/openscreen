import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { projectChronicleFrame } from "./chronicle/model-projection.js";
import type { ChronicleFrameInput, ChronicleFrameProjection } from "./chronicle/types.js";
import { chronicleWindowFor } from "./chronicle/window-scheduler.js";

// Durable state that cannot live in Mastra's LibSQL store, kept as small and
// simple as possible now that there is no job queue, no lease/ownership
// tokens, and no multi-worker contention (a single background loop drives
// everything). Two concerns:
//  1. Turn scan cursor — per pi Session, so completed Turns aren't rescanned.
//  2. Chronicle ingest — the generation cursor + completion flag that gates
//     Capture retention (safety-critical: losing it could let Capture delete
//     frames Memory hasn't consumed yet), plus a buffer for frames that have
//     been ingested but not yet grouped into an eligible, summarized window.
//     Once a window is summarized, its pending frames are deleted; a frame
//     that arrives very late for an already-summarized window is dropped
//     (logged, not retried) — Chronicle is a best-effort coverage index, not
//     a guaranteed-complete record, per the migration plan.

const DATABASE_FILENAME = "cursors.sqlite3";
const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_SUMMARIZE_ATTEMPTS = 5;

type Row = Record<string, unknown>;

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export interface TurnScanCursor {
  fileVersion: string;
  lastTerminalEntryId?: string;
  status: "valid" | "invalid";
  lastError?: string;
}

export interface ChronicleDueWindow {
  windowId: string;
  eligibleAt: number;
}

export class MemoryCursors {
  constructor(private readonly connection: DatabaseSync) {}

  close(): void {
    this.connection.close();
  }

  // --- Turn scan cursor ---------------------------------------------------

  loadTurnScanCursor(sessionId: string): TurnScanCursor | undefined {
    const row = this.connection.prepare(`
      SELECT file_version, last_terminal_entry_id, status, last_error
      FROM turn_scan_cursors WHERE session_id = ?
    `).get(sessionId) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      fileVersion: String(row.file_version),
      ...(row.last_terminal_entry_id === null
        ? {}
        : { lastTerminalEntryId: String(row.last_terminal_entry_id) }),
      status: String(row.status) as "valid" | "invalid",
      ...(row.last_error === null ? {} : { lastError: String(row.last_error) }),
    };
  }

  shouldScanSession(sessionId: string, fileVersion: string): boolean {
    return this.loadTurnScanCursor(sessionId)?.fileVersion !== fileVersion;
  }

  recordTurnScanSuccess({
    sessionId,
    fileVersion,
    lastTerminalEntryId,
    scannedAt = Date.now(),
  }: {
    sessionId: string;
    fileVersion: string;
    lastTerminalEntryId?: string;
    scannedAt?: number;
  }): void {
    this.connection.prepare(`
      INSERT INTO turn_scan_cursors (
        session_id, file_version, last_terminal_entry_id, status, last_error, scanned_at
      ) VALUES (?, ?, ?, 'valid', NULL, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version,
        last_terminal_entry_id = excluded.last_terminal_entry_id,
        status = 'valid', last_error = NULL, scanned_at = excluded.scanned_at
    `).run(sessionId, fileVersion, lastTerminalEntryId ?? null, scannedAt);
  }

  recordTurnScanFailure({
    sessionId,
    fileVersion,
    error,
    scannedAt = Date.now(),
  }: {
    sessionId: string;
    fileVersion: string;
    error: string;
    scannedAt?: number;
  }): void {
    this.connection.prepare(`
      INSERT INTO turn_scan_cursors (
        session_id, file_version, last_terminal_entry_id, status, last_error, scanned_at
      ) VALUES (?, ?, NULL, 'invalid', ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version, status = 'invalid',
        last_error = excluded.last_error, scanned_at = excluded.scanned_at
    `).run(sessionId, fileVersion, error, scannedAt);
  }

  // --- Chronicle generation ingest cursor ---------------------------------

  chronicleGenerationCursor(generationId: string): number {
    if (!generationId.trim()) throw new Error("Chronicle generation ID is required");
    const row = this.connection.prepare(`
      SELECT last_frame_id FROM chronicle_generation_cursors WHERE generation_id = ?
    `).get(generationId) as Row | undefined;
    return row === undefined ? 0 : integer(row.last_frame_id, "Chronicle ingest cursor");
  }

  chronicleGenerationComplete(generationId: string): boolean {
    if (!generationId.trim()) throw new Error("Chronicle generation ID is required");
    const row = this.connection.prepare(`
      SELECT completed_at FROM chronicle_generation_cursors WHERE generation_id = ?
    `).get(generationId) as Row | undefined;
    return row !== undefined && row.completed_at !== null;
  }

  advanceChronicleGenerationCursor(
    generationId: string,
    expectedCursor: number,
    nextCursor: number,
    updatedAt = Date.now(),
  ): boolean {
    if (
      !generationId.trim() || !Number.isSafeInteger(expectedCursor) || expectedCursor < 0 ||
      !Number.isSafeInteger(nextCursor) || nextCursor < expectedCursor ||
      !Number.isSafeInteger(updatedAt)
    ) {
      throw new Error("Invalid Chronicle ingest cursor");
    }
    if (this.chronicleGenerationComplete(generationId)) return false;
    if (this.chronicleGenerationCursor(generationId) !== expectedCursor) return false;
    this.connection.prepare(`
      INSERT INTO chronicle_generation_cursors (generation_id, last_frame_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (generation_id) DO UPDATE SET
        last_frame_id = excluded.last_frame_id, updated_at = excluded.updated_at
    `).run(generationId, nextCursor, updatedAt);
    return true;
  }

  completeChronicleGeneration(
    generationId: string,
    expectedCursor: number,
    completedAt = Date.now(),
  ): boolean {
    if (
      !generationId.trim() || !Number.isSafeInteger(expectedCursor) || expectedCursor < 0 ||
      !Number.isSafeInteger(completedAt)
    ) {
      throw new Error("Invalid Chronicle generation completion");
    }
    if (this.chronicleGenerationCursor(generationId) !== expectedCursor) return false;
    if (this.chronicleGenerationComplete(generationId)) return true;
    this.connection.prepare(`
      INSERT INTO chronicle_generation_cursors (generation_id, last_frame_id, updated_at, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (generation_id) DO UPDATE SET
        completed_at = excluded.completed_at, updated_at = excluded.updated_at
      WHERE chronicle_generation_cursors.last_frame_id = excluded.last_frame_id
        AND chronicle_generation_cursors.completed_at IS NULL
    `).run(generationId, expectedCursor, completedAt, completedAt);
    return this.chronicleGenerationComplete(generationId);
  }

  // --- Chronicle window buffer ---------------------------------------------

  /** Projects, dedupes, and buckets one frame into its UTC window. */
  ingestChronicleFrame(
    frame: ChronicleFrameInput,
    policy: { windowMilliseconds: number; graceMilliseconds: number },
    ingestedAt = Date.now(),
  ): { windowId: string; eligibleAt: number } {
    const projection = projectChronicleFrame(frame);
    const occurredAt = Date.parse(projection.capturedAt);
    const window = chronicleWindowFor(occurredAt, policy);
    return this.ingestChronicleFrameInner(projection, window, ingestedAt);
  }

  private ingestChronicleFrameInner(
    projection: ChronicleFrameProjection,
    window: { id: string; startAt: number; endAt: number; eligibleAt: number },
    ingestedAt: number,
  ): { windowId: string; eligibleAt: number } {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.prepare(`
        INSERT INTO chronicle_windows (window_id, start_at, end_at, eligible_at, summarized_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT (window_id) DO NOTHING
      `).run(window.id, window.startAt, window.endAt, window.eligibleAt, ingestedAt);
      const summarized = this.connection.prepare(`
        SELECT summarized_at FROM chronicle_windows WHERE window_id = ?
      `).get(window.id) as Row;
      if (summarized.summarized_at !== null) {
        // Window already summarized; this frame arrived too late. Drop it —
        // Chronicle is a best-effort coverage index, not a guaranteed-complete
        // record. Not re-triggering summarization keeps this migration free
        // of the job-queue/generation-versioning machinery it replaces.
        this.connection.exec("COMMIT");
        return { windowId: window.id, eligibleAt: window.eligibleAt };
      }
      this.connection.prepare(`
        INSERT INTO chronicle_pending_frames (source_id, window_id, occurred_at, projection_json, ingested_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO NOTHING
      `).run(
        projection.sourceId,
        window.id,
        Date.parse(projection.capturedAt),
        JSON.stringify(projection),
        ingestedAt,
      );
      this.connection.exec("COMMIT");
      return { windowId: window.id, eligibleAt: window.eligibleAt };
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Windows whose grace period has elapsed, that have at least one
   * unsummarized pending frame, and haven't exhausted MAX_SUMMARIZE_ATTEMPTS.
   * There is no lease/retry-count system anymore, so this cap is the only
   * thing stopping a permanently-broken window (e.g. persistently invalid
   * frame data) from being retried — and billed for a real model call —
   * every background tick forever.
   */
  dueChronicleWindows(now = Date.now()): ChronicleDueWindow[] {
    return (this.connection.prepare(`
      SELECT w.window_id, w.eligible_at FROM chronicle_windows w
      WHERE w.eligible_at <= ? AND w.summarized_at IS NULL AND w.attempt_count < ?
        AND EXISTS (SELECT 1 FROM chronicle_pending_frames p WHERE p.window_id = w.window_id)
      ORDER BY w.eligible_at, w.window_id
    `).all(now, MAX_SUMMARIZE_ATTEMPTS) as Row[]).map((row) => ({
      windowId: String(row.window_id),
      eligibleAt: integer(row.eligible_at, "Chronicle window eligibility"),
    }));
  }

  /** Call before attempting to summarize a window; returns the attempt number (1-based). */
  recordChronicleWindowAttempt(windowId: string): number {
    this.connection.prepare(`
      UPDATE chronicle_windows SET attempt_count = attempt_count + 1 WHERE window_id = ?
    `).run(windowId);
    const row = this.connection.prepare(`
      SELECT attempt_count FROM chronicle_windows WHERE window_id = ?
    `).get(windowId) as Row;
    return integer(row.attempt_count, "Chronicle window attempt count");
  }

  loadChronicleWindowFrames(windowId: string): ChronicleFrameProjection[] {
    const rows = this.connection.prepare(`
      SELECT projection_json FROM chronicle_pending_frames
      WHERE window_id = ? ORDER BY occurred_at, source_id
    `).all(windowId) as Row[];
    return rows.map((row) => JSON.parse(String(row.projection_json)) as ChronicleFrameProjection);
  }

  /** Marks a window summarized and deletes its now-superseded pending frames. */
  markChronicleWindowSummarized(windowId: string, summarizedAt = Date.now()): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.prepare(`
        UPDATE chronicle_windows SET summarized_at = ? WHERE window_id = ? AND summarized_at IS NULL
      `).run(summarizedAt, windowId);
      this.connection.prepare(`
        DELETE FROM chronicle_pending_frames WHERE window_id = ?
      `).run(windowId);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS turn_scan_cursors (
    session_id TEXT PRIMARY KEY,
    file_version TEXT NOT NULL,
    last_terminal_entry_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
    last_error TEXT,
    scanned_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS chronicle_generation_cursors (
    generation_id TEXT PRIMARY KEY,
    last_frame_id INTEGER NOT NULL,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS chronicle_windows (
    window_id TEXT PRIMARY KEY,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    eligible_at INTEGER NOT NULL,
    summarized_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS chronicle_windows_span ON chronicle_windows(start_at, end_at);

  CREATE TABLE IF NOT EXISTS chronicle_pending_frames (
    source_id TEXT PRIMARY KEY,
    window_id TEXT NOT NULL REFERENCES chronicle_windows(window_id),
    occurred_at INTEGER NOT NULL,
    projection_json TEXT NOT NULL,
    ingested_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS chronicle_pending_frames_window ON chronicle_pending_frames(window_id);
`;

export function cursorsDatabasePath(root: string): string {
  return join(root, DATABASE_FILENAME);
}

export function openMemoryCursors(root: string): MemoryCursors {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = cursorsDatabasePath(root);
  const connection = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    chmodSync(path, 0o600);
    connection.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS};
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
    `);
    connection.exec(SCHEMA);
    return new MemoryCursors(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
