import {
  changeCount,
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import type { MemoryPipelineConfig } from "../types.js";
import { activitySourceRows } from "./sources.js";
import type { ActivityOutput, TerminalTurnStatus } from "./types.js";

const GLOBAL_JOB_KEY = "global";

export class ActivityOutputs {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly config: MemoryPipelineConfig,
  ) {}

  complete(
    jobKey: string,
    ownershipToken: string,
    output: ActivityOutput,
    completedAt = Date.now(),
  ) {
    return this.database.transaction(() => {
      const job = this.database.connection.prepare(`
        SELECT source_kind, source_id, source_generation
        FROM activity_jobs
        WHERE job_key = ? AND status = 'running' AND ownership_token = ?
          AND lease_until > ?
      `).get(jobKey, ownershipToken, completedAt) as DatabaseRow | undefined;
      if (!job) throw new Error("Activity ownership lost");
      const sources = activitySourceRows(this.database.connection, job);
      const sourceById = new Map(sources.map((source) => [String(source.id), source]));
      const covered = new Set<string>();
      for (const activity of output.activities) {
        for (const sourceId of activity.sourceIds) {
          if (!sourceById.has(sourceId)) {
            throw new Error(`Activity returned unknown source ${sourceId}`);
          }
          if (covered.has(sourceId)) {
            throw new Error(`Activity returned source ${sourceId} more than once`);
          }
          covered.add(sourceId);
        }
      }
      for (const sourceId of sourceById.keys()) {
        if (!covered.has(sourceId)) {
          throw new Error(`Activity output is missing source ${sourceId}`);
        }
      }

      const globalJob = this.database.connection.prepare(`
        SELECT status, input_watermark, retry_remaining
        FROM consolidation_jobs WHERE job_key = ?
      `).get(GLOBAL_JOB_KEY) as DatabaseRow | undefined;
      const nextWatermark = globalJob
        ? integer(globalJob.input_watermark, "Consolidation input watermark") + 1
        : 1;
      if (globalJob) {
        const currentStatus = String(globalJob.status);
        const retryRemaining = integer(
          globalJob.retry_remaining,
          "Consolidation retries",
        );
        if (currentStatus === "running" ||
            (currentStatus === "error" && retryRemaining > 0)) {
          this.database.connection.prepare(`
            UPDATE consolidation_jobs SET input_watermark = ?
            WHERE job_key = ?
          `).run(nextWatermark, GLOBAL_JOB_KEY);
        } else {
          this.database.connection.prepare(`
            UPDATE consolidation_jobs SET
              status = 'pending', input_watermark = ?, retry_remaining = ?,
              retry_at = NULL, abandonment_count = 0, last_error = NULL,
              finished_at = CASE WHEN status = 'error' THEN NULL ELSE finished_at END
            WHERE job_key = ?
          `).run(
            nextWatermark,
            this.config.worker.maxAttempts,
            GLOBAL_JOB_KEY,
          );
        }
      } else {
        this.database.connection.prepare(`
          INSERT INTO consolidation_jobs (
            job_key, status, retry_remaining, input_watermark,
            last_success_watermark
          ) VALUES (?, 'pending', ?, ?, 0)
        `).run(
          GLOBAL_JOB_KEY,
          this.config.worker.maxAttempts,
          nextWatermark,
        );
      }

      this.database.connection.prepare(`
        INSERT INTO activity_summaries (
          job_key, source_generation, source_updated_at, source_summary,
          raw_memory, scope_json, generated_at, selected_for_consolidation,
          selected_for_consolidation_source_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT (job_key) DO UPDATE SET
          source_generation = excluded.source_generation,
          source_updated_at = excluded.source_updated_at,
          source_summary = excluded.source_summary,
          raw_memory = excluded.raw_memory,
          scope_json = excluded.scope_json,
          generated_at = excluded.generated_at,
          selected_for_consolidation = 0,
          selected_for_consolidation_source_updated_at = NULL
      `).run(
        jobKey,
        integer(job.source_generation, "Activity source generation"),
        nextWatermark,
        output.sourceSummary,
        output.rawMemory,
        JSON.stringify(output.scopeHints),
        completedAt,
      );
      this.database.connection.prepare(
        "DELETE FROM activity_records WHERE activity_job_key = ?",
      ).run(jobKey);
      this.database.connection.prepare(
        "DELETE FROM activity_summary_sources WHERE job_key = ?",
      ).run(jobKey);
      const insertOutputSource = this.database.connection.prepare(`
        INSERT INTO activity_summary_sources (job_key, source_id) VALUES (?, ?)
      `);
      for (const source of sources) insertOutputSource.run(jobKey, String(source.id));
      for (const source of sources) {
        this.database.connection.prepare(`
          UPDATE source_items SET sidecar_delete_after = ?
          WHERE id = ? AND sidecar_path IS NOT NULL
        `).run(
          completedAt + this.config.evidence.successRetentionMilliseconds,
          String(source.id),
        );
      }

      const insertActivity = this.database.connection.prepare(`
        INSERT INTO activity_records (
          id, activity_job_key, occurred_at, created_at, status, summary,
          application, window_title, entities_json, verbatim_evidence_json,
          scope_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertActivitySource = this.database.connection.prepare(`
        INSERT INTO activity_record_sources (activity_id, source_id) VALUES (?, ?)
      `);
      output.activities.forEach((activity, index) => {
        const activitySources = activity.sourceIds.map((sourceId) => sourceById.get(sourceId)!);
        const statuses = new Set(activitySources.map((source) => {
          if (source.source_type === "observation") return "observed";
          const projection = JSON.parse(String(source.projection_json)) as {
            status: TerminalTurnStatus;
          };
          return projection.status;
        }));
        if (statuses.size !== 1) {
          throw new Error("One activity cannot combine sources with different statuses");
        }
        const activityId = `${jobKey}:activity:${index + 1}`;
        insertActivity.run(
          activityId,
          jobKey,
          Math.min(...activitySources.map((source) =>
            integer(source.occurred_at, "Activity timestamp"))),
          completedAt,
          [...statuses][0],
          activity.summary,
          activity.application ?? null,
          activity.windowTitle ?? null,
          JSON.stringify(activity.entities),
          JSON.stringify(activity.verbatimEvidence),
          JSON.stringify(activity.scopeHints),
        );
        for (const sourceId of activity.sourceIds) {
          insertActivitySource.run(activityId, sourceId);
        }
      });

      const completed = changeCount(this.database.connection.prepare(`
        UPDATE activity_jobs SET
          status = 'succeeded', finished_at = ?, worker_id = NULL,
          ownership_token = NULL, lease_until = NULL, retry_at = NULL,
          abandonment_count = 0, last_error = NULL
        WHERE job_key = ? AND status = 'running' AND ownership_token = ?
          AND source_generation = ? AND lease_until > ?
      `).run(
        completedAt,
        jobKey,
        ownershipToken,
        integer(job.source_generation, "Activity source generation"),
        completedAt,
      ));
      if (completed !== 1) throw new Error("Activity ownership lost");
      return { inputWatermark: nextWatermark };
    });
  }
}
