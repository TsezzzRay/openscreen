import {
  finishModelAttempt,
  startModelAttempt,
  type FinishModelAttempt,
  type StartModelAttempt,
} from "../db/attempts.js";
import {
  changeCount,
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import { ProducerJobs, type ProducerJobClaim } from "../shared/producer-jobs.js";
import { wakeGlobalConsolidation } from "../shared/consolidation-job.js";
import type { MemoryPipelineConfig } from "../types.js";
import type { ScreenObservation } from "../../../extensions/screen-observation/types.js";
import { projectChronicleObservation } from "./model-projection.js";
import type { ChronicleSummary } from "./types.js";
import { chronicleWindowFor } from "./window-scheduler.js";
import type { ObservationEvidence } from "../evidence.js";

const JOB_KIND = "chronicle_summarization" as const;

function milliseconds(value: string, name: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function jobKey(windowId: string) {
  return `chronicle:${windowId}`;
}

export type ChronicleClaim = ProducerJobClaim & { kind: typeof JOB_KIND };

export class ChronicleRepository {
  private readonly jobs: ProducerJobs;

  constructor(
    private readonly database: MemoryDatabase,
    readonly config: MemoryPipelineConfig,
  ) {
    this.jobs = new ProducerJobs(database, config);
  }

  ingestObservation(
    observation: ScreenObservation,
    ingestedAt = Date.now(),
    evidence?: ObservationEvidence,
  ) {
    const projection = projectChronicleObservation(observation);
    const occurredAt = milliseconds(observation.occurredAt, "Observation timestamp");
    const capturedAt = milliseconds(observation.capturedAt, "Observation capture timestamp");
    const window = chronicleWindowFor(occurredAt, {
      windowMilliseconds: this.config.chronicle.observationWindowMilliseconds,
      graceMilliseconds: this.config.chronicle.observationGraceMilliseconds,
    });
    return this.database.transaction(() => {
      const inserted = changeCount(this.database.connection.prepare(`
        INSERT INTO chronicle_sources (
          id, source_key, occurred_at, captured_at, projection_json,
          structured_path, structured_sha256, screenshot_path, screenshot_sha256,
          structured_delete_after, screenshot_delete_after, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_key) DO NOTHING
      `).run(
        projection.sourceId,
        projection.sourceId,
        occurredAt,
        capturedAt,
        JSON.stringify(projection),
        evidence?.structured.path ?? null,
        evidence?.structured.sha256 ?? null,
        evidence?.screenshot?.path ?? null,
        evidence?.screenshot?.sha256 ?? null,
        evidence
          ? ingestedAt + this.config.evidence.failedRetentionMilliseconds
          : null,
        evidence?.screenshot
          ? ingestedAt + this.config.evidence.screenshotRetentionMilliseconds
          : null,
        ingestedAt,
      ));
      if (inserted === 0) {
        const existing = this.database.connection.prepare(`
          SELECT w.id, w.eligible_at, w.source_generation
          FROM chronicle_windows w
          JOIN chronicle_window_sources ws ON ws.window_id = w.id
          WHERE ws.source_id = ?
        `).get(projection.sourceId) as DatabaseRow | undefined;
        if (!existing) throw new Error("Chronicle source is missing its window");
        return {
          duplicate: true,
          sourceId: projection.sourceId,
          windowId: String(existing.id),
          eligibleAt: integer(existing.eligible_at, "Chronicle eligibility"),
          sourceGeneration: integer(existing.source_generation, "Chronicle generation"),
        };
      }

      this.database.connection.prepare(`
        INSERT INTO chronicle_windows (
          id, start_at, end_at, eligible_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (start_at, end_at) DO NOTHING
      `).run(
        window.id,
        window.startAt,
        window.endAt,
        window.eligibleAt,
        ingestedAt,
        ingestedAt,
      );
      const stored = this.database.connection.prepare(`
        SELECT id FROM chronicle_windows WHERE start_at = ? AND end_at = ?
      `).get(window.startAt, window.endAt) as DatabaseRow;
      const windowId = String(stored.id);
      const ordinal = integer(this.database.connection.prepare(`
        SELECT count(*) AS count FROM chronicle_window_sources WHERE window_id = ?
      `).get(windowId)?.count, "Chronicle source ordinal");
      this.database.connection.prepare(`
        INSERT INTO chronicle_window_sources (window_id, source_id, ordinal)
        VALUES (?, ?, ?)
      `).run(windowId, projection.sourceId, ordinal);
      this.database.connection.prepare(`
        UPDATE chronicle_windows
        SET source_generation = source_generation + 1, updated_at = ?
        WHERE id = ?
      `).run(ingestedAt, windowId);
      const updated = this.database.connection.prepare(`
        SELECT source_generation, eligible_at FROM chronicle_windows WHERE id = ?
      `).get(windowId) as DatabaseRow;
      const sourceGeneration = integer(updated.source_generation, "Chronicle generation");
      const eligibleAt = integer(updated.eligible_at, "Chronicle eligibility");
      this.jobs.queue({
        jobKey: jobKey(windowId),
        kind: JOB_KIND,
        sourceId: windowId,
        sourceGeneration,
        eligibleAt,
      });
      return {
        duplicate: false,
        sourceId: projection.sourceId,
        windowId,
        eligibleAt,
        sourceGeneration,
      };
    });
  }

  claimNext(options: { workerId: string; now?: number }) {
    return this.jobs.claimNext(JOB_KIND, options) as ChronicleClaim | null;
  }

  heartbeat(claim: ChronicleClaim, now: number) {
    return this.jobs.heartbeat(claim, now);
  }

  fail(claim: ChronicleClaim, error: string, failedAt = Date.now()) {
    const failed = this.jobs.fail(claim, error, failedAt);
    if (failed) {
      this.database.connection.prepare(`
        UPDATE chronicle_sources SET structured_delete_after = ?
        WHERE id IN (
          SELECT source_id FROM chronicle_window_sources WHERE window_id = ?
        ) AND structured_path IS NOT NULL
      `).run(
        failedAt + this.config.evidence.failedRetentionMilliseconds,
        claim.sourceId,
      );
    }
    return failed;
  }

  loadClaimSources(claim: ChronicleClaim) {
    this.jobs.owned(claim, -1);
    return (this.database.connection.prepare(`
      SELECT s.projection_json
      FROM chronicle_window_sources ws
      JOIN chronicle_sources s ON s.id = ws.source_id
      WHERE ws.window_id = ?
      ORDER BY s.occurred_at, s.id
    `).all(claim.sourceId) as DatabaseRow[]).map((row) =>
      JSON.parse(String(row.projection_json)) as
        ReturnType<typeof projectChronicleObservation>);
  }

  complete(claim: ChronicleClaim, output: ChronicleSummary, completedAt = Date.now()) {
    return this.database.transaction(() => {
      this.jobs.owned(claim, completedAt);
      const rows = this.database.connection.prepare(`
        SELECT s.id, s.occurred_at
        FROM chronicle_window_sources ws
        JOIN chronicle_sources s ON s.id = ws.source_id
        WHERE ws.window_id = ?
        ORDER BY s.occurred_at, s.id
      `).all(claim.sourceId) as DatabaseRow[];
      const sourceById = new Map(rows.map((row) => [String(row.id), row]));
      const covered = new Set<string>();
      for (const activity of output.activities) {
        for (const sourceId of activity.sourceIds) {
          if (!sourceById.has(sourceId)) {
            throw new Error(`Chronicle returned unknown source ${sourceId}`);
          }
          if (covered.has(sourceId)) {
            throw new Error(`Chronicle returned source ${sourceId} more than once`);
          }
          covered.add(sourceId);
        }
      }
      for (const sourceId of sourceById.keys()) {
        if (!covered.has(sourceId)) {
          throw new Error(`Chronicle output is missing source ${sourceId}`);
        }
      }
      const watermark = integer(this.database.connection.prepare(`
        SELECT coalesce(max(source_updated_at), 0) + 1 AS watermark
        FROM (
          SELECT source_updated_at FROM chronicle_summaries
          UNION ALL
          SELECT source_updated_at FROM turn_memory_extractions
        )
      `).get()?.watermark, "memory source watermark");
      this.database.connection.prepare(`
        INSERT INTO chronicle_summaries (
          job_key, source_generation, source_updated_at, source_summary, generated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET
          source_generation = excluded.source_generation,
          source_updated_at = excluded.source_updated_at,
          source_summary = excluded.source_summary,
          generated_at = excluded.generated_at
      `).run(
        claim.jobKey,
        claim.sourceGeneration,
        watermark,
        output.sourceSummary,
        completedAt,
      );
      this.database.connection.prepare(
        "DELETE FROM chronicle_activities WHERE job_key = ?",
      ).run(claim.jobKey);
      this.database.connection.prepare(
        "DELETE FROM chronicle_summary_sources WHERE job_key = ?",
      ).run(claim.jobKey);
      const insertSummarySource = this.database.connection.prepare(`
        INSERT INTO chronicle_summary_sources (job_key, source_id) VALUES (?, ?)
      `);
      for (const sourceId of sourceById.keys()) {
        insertSummarySource.run(claim.jobKey, sourceId);
      }
      this.database.connection.prepare(`
        UPDATE chronicle_sources SET structured_delete_after = ?
        WHERE id IN (
          SELECT source_id FROM chronicle_window_sources WHERE window_id = ?
        ) AND structured_path IS NOT NULL
      `).run(
        completedAt + this.config.evidence.successRetentionMilliseconds,
        claim.sourceId,
      );
      const insertActivity = this.database.connection.prepare(`
        INSERT INTO chronicle_activities (
          id, job_key, occurred_at, summary, application, window_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertActivitySource = this.database.connection.prepare(`
        INSERT INTO chronicle_activity_sources (activity_id, source_id)
        VALUES (?, ?)
      `);
      output.activities.forEach((activity, index) => {
        const id = `${claim.jobKey}:activity:${index + 1}`;
        insertActivity.run(
          id,
          claim.jobKey,
          Math.min(...activity.sourceIds.map((sourceId) =>
            integer(sourceById.get(sourceId)!.occurred_at, "Chronicle activity time"))),
          activity.summary,
          activity.application ?? null,
          activity.windowTitle ?? null,
          completedAt,
        );
        for (const sourceId of activity.sourceIds) {
          insertActivitySource.run(id, sourceId);
        }
      });
      wakeGlobalConsolidation(this.database.connection, this.config, watermark);
      if (!this.jobs.complete(claim, completedAt)) {
        throw new Error("Chronicle summarization ownership lost");
      }
      return { sourceUpdatedAt: watermark };
    });
  }

  startModelAttempt(attempt: StartModelAttempt) {
    startModelAttempt(this.database.connection, attempt);
  }

  finishModelAttempt(attempt: FinishModelAttempt) {
    finishModelAttempt(this.database.connection, attempt);
  }
}
