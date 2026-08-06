import type { DatabaseRow, MemoryDatabase } from "../db/database.js";

export class SessionScanRepository {
  constructor(private readonly database: MemoryDatabase) {}

  shouldScan(
    sessionId: string,
    fileVersion: string,
    includeInterrupted: boolean,
  ) {
    const row = this.database.connection.prepare(`
      SELECT file_version, status, includes_interrupted
      FROM turn_memory_session_scans WHERE session_id = ?
    `).get(sessionId) as DatabaseRow | undefined;
    if (!row || String(row.file_version) !== fileVersion) return true;
    if (row.status === "invalid") return false;
    return includeInterrupted && Number(row.includes_interrupted) === 0;
  }

  recordSuccess(
    sessionId: string,
    fileVersion: string,
    includeInterrupted: boolean,
    scannedAt = Date.now(),
  ) {
    this.database.connection.prepare(`
      INSERT INTO turn_memory_session_scans (
        session_id, file_version, status, includes_interrupted,
        last_error, scanned_at
      ) VALUES (?, ?, 'valid', ?, NULL, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version,
        status = excluded.status,
        includes_interrupted = CASE
          WHEN turn_memory_session_scans.file_version = excluded.file_version
          THEN max(turn_memory_session_scans.includes_interrupted,
                   excluded.includes_interrupted)
          ELSE excluded.includes_interrupted
        END,
        last_error = NULL,
        scanned_at = excluded.scanned_at
    `).run(sessionId, fileVersion, includeInterrupted ? 1 : 0, scannedAt);
  }

  recordFailure(
    sessionId: string,
    fileVersion: string,
    error: string,
    scannedAt = Date.now(),
  ) {
    this.database.connection.prepare(`
      INSERT INTO turn_memory_session_scans (
        session_id, file_version, status, includes_interrupted,
        last_error, scanned_at
      ) VALUES (?, ?, 'invalid', 0, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        file_version = excluded.file_version,
        status = excluded.status,
        includes_interrupted = 0,
        last_error = excluded.last_error,
        scanned_at = excluded.scanned_at
    `).run(sessionId, fileVersion, error, scannedAt);
  }
}
