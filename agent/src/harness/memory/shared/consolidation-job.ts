import type { DatabaseSync } from "node:sqlite";

import type { MemoryPipelineConfig } from "../types.js";
import { integer, type DatabaseRow } from "../db/database.js";

const JOB_KEY = "global";

export function wakeGlobalConsolidation(
  connection: DatabaseSync,
  config: MemoryPipelineConfig,
  inputWatermark: number,
) {
  const row = connection.prepare(`
    SELECT status, input_watermark, retry_remaining
    FROM consolidation_jobs WHERE job_key = ?
  `).get(JOB_KEY) as DatabaseRow | undefined;
  if (!row) {
    connection.prepare(`
      INSERT INTO consolidation_jobs (
        job_key, status, retry_remaining, input_watermark, last_success_watermark
      ) VALUES (?, 'pending', ?, ?, 0)
    `).run(JOB_KEY, config.worker.maxAttempts, inputWatermark);
    return;
  }
  const nextWatermark = Math.max(
    inputWatermark,
    integer(row.input_watermark, "Consolidation input watermark"),
  );
  const currentStatus = String(row.status);
  const retries = integer(row.retry_remaining, "Consolidation retries");
  if (currentStatus === "running" || (currentStatus === "error" && retries > 0)) {
    connection.prepare(`
      UPDATE consolidation_jobs SET input_watermark = ? WHERE job_key = ?
    `).run(nextWatermark, JOB_KEY);
    return;
  }
  connection.prepare(`
    UPDATE consolidation_jobs SET
      status = 'pending', input_watermark = ?, retry_remaining = ?,
      retry_at = NULL, abandonment_count = 0, last_error = NULL,
      finished_at = CASE WHEN status = 'error' THEN NULL ELSE finished_at END
    WHERE job_key = ?
  `).run(nextWatermark, config.worker.maxAttempts, JOB_KEY);
}
