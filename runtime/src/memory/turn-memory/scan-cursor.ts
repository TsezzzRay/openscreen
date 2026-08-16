import type { DatabaseRow, MemoryDatabase } from "../database.js";

export interface TurnMemoryScanCursor {
  fileVersion: string;
  lastTerminalEntryId?: string;
  status: "valid" | "invalid";
  lastError?: string;
}

export class TurnMemoryScanCursorRepository {
  constructor(private readonly database: MemoryDatabase) {}

  load(sessionId: string): TurnMemoryScanCursor | undefined {
    const row = this.database.connection.prepare(`
      SELECT file_version, last_terminal_entry_id, status, last_error
      FROM turn_memory_session_scans WHERE session_id = ?
    `).get(sessionId) as DatabaseRow | undefined;
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

  shouldScan(sessionId: string, fileVersion: string): boolean {
    return this.load(sessionId)?.fileVersion !== fileVersion;
  }

  recordSuccess({
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
    this.database.connection.prepare(`
      INSERT INTO turn_memory_session_scans (
        session_id, file_version, last_terminal_entry_id,
        status, last_error, scanned_at
      ) VALUES (?, ?, ?, 'valid', NULL, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version,
        last_terminal_entry_id = excluded.last_terminal_entry_id,
        status = 'valid',
        last_error = NULL,
        scanned_at = excluded.scanned_at
    `).run(
      sessionId,
      fileVersion,
      lastTerminalEntryId ?? null,
      scannedAt,
    );
  }

  recordFailure({
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
    this.database.connection.prepare(`
      INSERT INTO turn_memory_session_scans (
        session_id, file_version, last_terminal_entry_id,
        status, last_error, scanned_at
      ) VALUES (?, ?, NULL, 'invalid', ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version,
        status = 'invalid',
        last_error = excluded.last_error,
        scanned_at = excluded.scanned_at
    `).run(sessionId, fileVersion, error, scannedAt);
  }
}
