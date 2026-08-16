import { createHash, randomUUID } from "node:crypto";

import type { DatabaseRow, MemoryDatabase } from "../database.js";
import { integer } from "../database.js";
import { recordMemorySourceInTransaction } from "../consolidate/source-repository.js";
import { projectChronicleFrame } from "./model-projection.js";
import { renderChronicleRollout } from "./rollout.js";
import type {
  ChronicleFrameInput,
  ChronicleFrameProjection,
  ChronicleSummary,
} from "./types.js";
import { chronicleWindowFor } from "./window-scheduler.js";

const JOB_KIND = "chronicle_summarization";

export interface ChroniclePolicy {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSourcesPerRequest: number;
  windowMilliseconds: number;
  graceMilliseconds: number;
  worker: {
    leaseMilliseconds: number;
    retryDelayMilliseconds: number;
    maxAttempts: number;
  };
}

export interface ChronicleClaim {
  jobKey: string;
  sourceId: string;
  sourceGeneration: number;
  workerId: string;
  ownershipToken: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jobKey(windowId: string): string {
  return `chronicle:${windowId}`;
}

export class ChronicleRepository {
  constructor(
    private readonly database: MemoryDatabase,
    readonly policy: ChroniclePolicy,
  ) {}

  generationCursor(generationId: string): number {
    if (!generationId.trim()) throw new Error("Chronicle generation ID is required");
    const row = this.database.connection.prepare(`
      SELECT last_frame_id FROM chronicle_ingest_cursors
      WHERE generation_id = ?
    `).get(generationId) as DatabaseRow | undefined;
    return row === undefined
      ? 0
      : integer(row.last_frame_id, "Chronicle ingest cursor");
  }

  generationComplete(generationId: string): boolean {
    if (!generationId.trim()) throw new Error("Chronicle generation ID is required");
    const row = this.database.connection.prepare(`
      SELECT completed_at FROM chronicle_ingest_cursors
      WHERE generation_id = ?
    `).get(generationId) as DatabaseRow | undefined;
    if (row === undefined || row.completed_at === null) return false;
    integer(row.completed_at, "Chronicle generation completion");
    return true;
  }

  advanceGenerationCursor(
    generationId: string,
    expectedCursor: number,
    nextCursor: number,
    updatedAt = Date.now(),
  ): boolean {
    if (
      !generationId.trim() ||
      !Number.isSafeInteger(expectedCursor) ||
      expectedCursor < 0 ||
      !Number.isSafeInteger(nextCursor) ||
      nextCursor < expectedCursor ||
      !Number.isSafeInteger(updatedAt)
    ) {
      throw new Error("Invalid Chronicle ingest cursor");
    }
    return this.database.transaction(() => {
      if (this.generationComplete(generationId)) return false;
      if (this.generationCursor(generationId) !== expectedCursor) return false;
      this.database.connection.prepare(`
        INSERT INTO chronicle_ingest_cursors (
          generation_id, last_frame_id, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT (generation_id) DO UPDATE SET
          last_frame_id = excluded.last_frame_id,
          updated_at = excluded.updated_at
      `).run(generationId, nextCursor, updatedAt);
      return true;
    });
  }

  completeGeneration(
    generationId: string,
    expectedCursor: number,
    completedAt = Date.now(),
  ): boolean {
    if (
      !generationId.trim() ||
      !Number.isSafeInteger(expectedCursor) ||
      expectedCursor < 0 ||
      !Number.isSafeInteger(completedAt)
    ) {
      throw new Error("Invalid Chronicle generation completion");
    }
    return this.database.transaction(() => {
      if (this.generationCursor(generationId) !== expectedCursor) return false;
      if (this.generationComplete(generationId)) return true;
      this.database.connection.prepare(`
        INSERT INTO chronicle_ingest_cursors (
          generation_id, last_frame_id, updated_at, completed_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (generation_id) DO UPDATE SET
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
        WHERE chronicle_ingest_cursors.last_frame_id = excluded.last_frame_id
          AND chronicle_ingest_cursors.completed_at IS NULL
      `).run(generationId, expectedCursor, completedAt, completedAt);
      return this.generationComplete(generationId);
    });
  }

  private queue(windowId: string, sourceGeneration: number, eligibleAt: number): void {
    this.database.connection.prepare(`
      INSERT INTO memory_jobs (
        job_key, kind, source_id, source_generation, status, eligible_at,
        retry_remaining
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (kind, source_id) DO UPDATE SET
        source_generation = excluded.source_generation,
        status = 'pending', eligible_at = excluded.eligible_at,
        worker_id = NULL, ownership_token = NULL, started_at = NULL,
        finished_at = NULL, lease_until = NULL, retry_at = NULL,
        retry_remaining = excluded.retry_remaining, last_error = NULL
      WHERE memory_jobs.source_generation < excluded.source_generation
    `).run(
      jobKey(windowId),
      JOB_KIND,
      windowId,
      sourceGeneration,
      eligibleAt,
      this.policy.worker.maxAttempts,
    );
  }

  private owned(claim: ChronicleClaim): void {
    const row = this.database.connection.prepare(`
      SELECT 1 AS owned FROM memory_jobs
      WHERE job_key = ? AND kind = ? AND source_id = ?
        AND source_generation = ? AND status = 'running'
        AND worker_id = ? AND ownership_token = ?
    `).get(
      claim.jobKey,
      JOB_KIND,
      claim.sourceId,
      claim.sourceGeneration,
      claim.workerId,
      claim.ownershipToken,
    );
    if (row === undefined) throw new Error("Chronicle ownership lost");
  }

  ingest(frame: ChronicleFrameInput, ingestedAt = Date.now()): {
    duplicate: boolean;
    sourceId: string;
    windowId: string;
    eligibleAt: number;
    sourceGeneration: number;
  } {
    const projection = projectChronicleFrame(frame);
    const occurredAt = Date.parse(projection.capturedAt);
    const window = chronicleWindowFor(occurredAt, this.policy);
    const projectionJson = JSON.stringify(projection);
    const projectionHash = hash(projectionJson);
    return this.database.transaction(() => {
      const existing = this.database.connection.prepare(`
        SELECT projection_hash FROM chronicle_sources WHERE id = ?
      `).get(projection.sourceId) as DatabaseRow | undefined;
      if (existing !== undefined) {
        if (String(existing.projection_hash) !== projectionHash) {
          throw new Error("Chronicle source is immutable");
        }
        const linked = this.database.connection.prepare(`
          SELECT w.id, w.eligible_at, w.source_generation
          FROM chronicle_windows w
          JOIN chronicle_window_sources ws ON ws.window_id = w.id
          WHERE ws.source_id = ?
        `).get(projection.sourceId) as DatabaseRow | undefined;
        if (linked === undefined) throw new Error("Chronicle source is missing its window");
        return {
          duplicate: true,
          sourceId: projection.sourceId,
          windowId: String(linked.id),
          eligibleAt: integer(linked.eligible_at, "Chronicle eligibility"),
          sourceGeneration: integer(linked.source_generation, "Chronicle generation"),
        };
      }
      this.database.connection.prepare(`
        INSERT INTO chronicle_sources (
          id, occurred_at, projection_json, projection_hash, ingested_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(projection.sourceId, occurredAt, projectionJson, projectionHash, ingestedAt);
      this.database.connection.prepare(`
        INSERT INTO chronicle_windows (
          id, start_at, end_at, eligible_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (start_at, end_at) DO NOTHING
      `).run(window.id, window.startAt, window.endAt, window.eligibleAt, ingestedAt, ingestedAt);
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
        UPDATE chronicle_windows SET
          source_generation = source_generation + 1, updated_at = ?
        WHERE id = ?
      `).run(ingestedAt, windowId);
      const updated = this.database.connection.prepare(`
        SELECT source_generation, eligible_at FROM chronicle_windows WHERE id = ?
      `).get(windowId) as DatabaseRow;
      const sourceGeneration = integer(updated.source_generation, "Chronicle generation");
      const eligibleAt = integer(updated.eligible_at, "Chronicle eligibility");
      this.queue(windowId, sourceGeneration, eligibleAt);
      return { duplicate: false, sourceId: projection.sourceId, windowId, eligibleAt, sourceGeneration };
    });
  }

  claimNext({ workerId, now = Date.now() }: { workerId: string; now?: number }): ChronicleClaim | null {
    if (!workerId) throw new Error("Chronicle worker ID is required");
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE memory_jobs SET
          status = CASE WHEN retry_remaining > 1 THEN 'pending' ELSE 'error' END,
          worker_id = NULL, ownership_token = NULL, lease_until = NULL,
          retry_at = ?, retry_remaining = max(retry_remaining - 1, 0),
          last_error = 'worker lease expired', abandonment_count = abandonment_count + 1
        WHERE kind = ? AND status = 'running' AND lease_until <= ?
      `).run(now, JOB_KIND, now);
      const row = this.database.connection.prepare(`
        SELECT job_key, source_id, source_generation FROM memory_jobs
        WHERE kind = ? AND eligible_at <= ? AND retry_remaining > 0 AND (
          status = 'pending' OR (status = 'error' AND retry_at IS NOT NULL AND retry_at <= ?)
        ) ORDER BY eligible_at, job_key LIMIT 1
      `).get(JOB_KIND, now, now) as DatabaseRow | undefined;
      if (row === undefined) return null;
      const ownershipToken = randomUUID();
      const updated = this.database.connection.prepare(`
        UPDATE memory_jobs SET status = 'running', worker_id = ?, ownership_token = ?,
          started_at = ?, finished_at = NULL, lease_until = ?, retry_at = NULL,
          attempt_count = attempt_count + 1, last_error = NULL
        WHERE job_key = ? AND source_generation = ? AND status IN ('pending', 'error')
      `).run(
        workerId,
        ownershipToken,
        now,
        now + this.policy.worker.leaseMilliseconds,
        String(row.job_key),
        integer(row.source_generation, "Chronicle job generation"),
      );
      if (Number(updated.changes) !== 1) return null;
      return {
        jobKey: String(row.job_key),
        sourceId: String(row.source_id),
        sourceGeneration: integer(row.source_generation, "Chronicle job generation"),
        workerId,
        ownershipToken,
      };
    });
  }

  heartbeat(claim: ChronicleClaim, now = Date.now()): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_jobs SET lease_until = ?
      WHERE job_key = ? AND source_generation = ? AND status = 'running'
        AND worker_id = ? AND ownership_token = ?
    `).run(
      now + this.policy.worker.leaseMilliseconds,
      claim.jobKey,
      claim.sourceGeneration,
      claim.workerId,
      claim.ownershipToken,
    );
    return Number(result.changes) === 1;
  }

  fail(claim: ChronicleClaim, error: string, failedAt = Date.now()): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_jobs SET status = 'error', finished_at = ?, lease_until = NULL,
        retry_at = ?, retry_remaining = max(retry_remaining - 1, 0), last_error = ?,
        worker_id = NULL, ownership_token = NULL
      WHERE job_key = ? AND source_generation = ? AND status = 'running'
        AND worker_id = ? AND ownership_token = ?
    `).run(
      failedAt,
      failedAt + this.policy.worker.retryDelayMilliseconds,
      error,
      claim.jobKey,
      claim.sourceGeneration,
      claim.workerId,
      claim.ownershipToken,
    );
    return Number(result.changes) === 1;
  }

  loadClaimSources(claim: ChronicleClaim): ChronicleFrameProjection[] {
    this.owned(claim);
    const sources = (this.database.connection.prepare(`
      SELECT s.projection_json FROM chronicle_window_sources ws
      JOIN chronicle_sources s ON s.id = ws.source_id
      WHERE ws.window_id = ? ORDER BY s.occurred_at, s.id
    `).all(claim.sourceId) as DatabaseRow[]).map((row) =>
      JSON.parse(String(row.projection_json)) as ChronicleFrameProjection
    );
    if (sources.length === 0) throw new Error("Chronicle window has no sources");
    return sources;
  }

  complete(
    claim: ChronicleClaim,
    output: ChronicleSummary,
    completedAt = Date.now(),
  ): { sourceUpdatedAt: number } {
    return this.database.transaction(() => {
      this.owned(claim);
      const sources = this.loadClaimSources(claim);
      const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
      const covered = new Set<string>();
      for (const activity of output.activities) {
        for (const sourceId of activity.sourceFrameIds) {
          if (!sourceById.has(sourceId)) throw new Error(`Chronicle returned unknown source ${sourceId}`);
          if (covered.has(sourceId)) throw new Error(`Chronicle returned source ${sourceId} more than once`);
          covered.add(sourceId);
        }
      }
      if (covered.size !== sourceById.size) throw new Error("Chronicle output is missing source");
      const rollout = renderChronicleRollout({
        jobKey: claim.jobKey,
        sources,
        summary: output,
        generatedAt: completedAt,
      });
      const sourceUpdatedAt = recordMemorySourceInTransaction(this.database, {
        sourceKey: claim.jobKey,
        kind: "chronicle",
        sourceId: claim.sourceId,
        sourceGeneration: claim.sourceGeneration,
        sourceSummary: output.sourceSummary,
        rawMemory: null,
        artifactPath: rollout.relativePath,
        contentHash: rollout.contentHash,
        startedAt: Date.parse(sources[0]!.capturedAt),
        endedAt: Date.parse(sources[sources.length - 1]!.capturedAt),
        provenance: "passive_screen",
        supportsSuccess: false,
        sourceIds: sources.map(({ sourceId }) => sourceId),
        generatedAt: completedAt,
      }, this.policy.worker.maxAttempts);
      this.database.connection.prepare(`
        INSERT INTO chronicle_summaries (
          job_key, source_generation, source_updated_at, source_summary, generated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET source_generation = excluded.source_generation,
          source_updated_at = excluded.source_updated_at, source_summary = excluded.source_summary,
          generated_at = excluded.generated_at
      `).run(claim.jobKey, claim.sourceGeneration, sourceUpdatedAt, output.sourceSummary, completedAt);
      this.database.connection.prepare("DELETE FROM chronicle_activities WHERE job_key = ?").run(claim.jobKey);
      this.database.connection.prepare("DELETE FROM chronicle_summary_sources WHERE job_key = ?").run(claim.jobKey);
      const insertSummarySource = this.database.connection.prepare(`
        INSERT INTO chronicle_summary_sources (job_key, source_id) VALUES (?, ?)
      `);
      for (const sourceId of sourceById.keys()) insertSummarySource.run(claim.jobKey, sourceId);
      const insertActivity = this.database.connection.prepare(`
        INSERT INTO chronicle_activities (
          id, job_key, occurred_at, summary, application, window_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertActivitySource = this.database.connection.prepare(`
        INSERT INTO chronicle_activity_sources (activity_id, source_id) VALUES (?, ?)
      `);
      output.activities.forEach((activity, index) => {
        const id = `${claim.jobKey}:activity:${index + 1}`;
        insertActivity.run(
          id,
          claim.jobKey,
          Math.min(...activity.sourceFrameIds.map((sourceId) => Date.parse(sourceById.get(sourceId)!.capturedAt))),
          activity.summary,
          activity.application ?? null,
          activity.windowTitle ?? null,
          completedAt,
        );
        for (const sourceId of activity.sourceFrameIds) insertActivitySource.run(id, sourceId);
      });
      this.database.connection.prepare(`
        INSERT INTO memory_artifacts (
          artifact_key, kind, relative_path, content, content_hash,
          source_updated_at, generated_at, projected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT (artifact_key) DO UPDATE SET kind = excluded.kind,
          relative_path = excluded.relative_path, content = excluded.content,
          content_hash = excluded.content_hash, source_updated_at = excluded.source_updated_at,
          generated_at = excluded.generated_at,
          projected_at = CASE WHEN memory_artifacts.content_hash = excluded.content_hash
            THEN memory_artifacts.projected_at ELSE NULL END
      `).run(
        rollout.artifactKey,
        rollout.kind,
        rollout.relativePath,
        rollout.content,
        rollout.contentHash,
        sourceUpdatedAt,
        completedAt,
      );
      const completed = this.database.connection.prepare(`
        UPDATE memory_jobs SET status = 'succeeded', finished_at = ?, lease_until = NULL,
          retry_at = NULL, last_error = NULL, worker_id = NULL, ownership_token = NULL
        WHERE job_key = ? AND source_generation = ? AND status = 'running'
          AND worker_id = ? AND ownership_token = ?
      `).run(
        completedAt,
        claim.jobKey,
        claim.sourceGeneration,
        claim.workerId,
        claim.ownershipToken,
      );
      if (Number(completed.changes) !== 1) throw new Error("Chronicle ownership lost");
      return { sourceUpdatedAt };
    });
  }

  pendingArtifacts(): Array<{
    artifactKey: string;
    relativePath: string;
    content: string;
    contentHash: string;
  }> {
    return (this.database.connection.prepare(`
      SELECT artifact_key, relative_path, content, content_hash FROM memory_artifacts
      WHERE kind = 'chronicle_rollout' AND projected_at IS NULL ORDER BY relative_path
    `).all() as DatabaseRow[]).map((row) => ({
      artifactKey: String(row.artifact_key),
      relativePath: String(row.relative_path),
      content: String(row.content),
      contentHash: String(row.content_hash),
    }));
  }

  markArtifactProjected(artifactKey: string, contentHash: string, projectedAt = Date.now()): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_artifacts SET projected_at = ?
      WHERE artifact_key = ? AND content_hash = ? AND projected_at IS NULL
    `).run(projectedAt, artifactKey, contentHash);
    return Number(result.changes) === 1;
  }
}
