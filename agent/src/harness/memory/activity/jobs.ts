import { randomUUID } from "node:crypto";

import {
  finishModelAttempt as finishRecordedModelAttempt,
  startModelAttempt as recordModelAttempt,
  type FinishModelAttempt,
  type StartModelAttempt,
} from "../db/attempts.js";
import {
  changeCount,
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import type { MemoryPipelineConfig } from "../types.js";
import { projectObservation, projectTurnBatch } from "./projection.js";
import { activitySourceRows } from "./sources.js";

export type ClaimedActivityJob = {
  jobKey: string;
  sourceKind: "observation_window" | "turn_batch";
  sourceId: string;
  sourceGeneration: number;
  workerId: string;
  ownershipToken: string;
  leaseUntil: number;
};

export class ActivityJobs {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly config: MemoryPipelineConfig,
  ) {}

  claimNext({
    workerId,
    now = Date.now(),
  }: {
    workerId: string;
    now?: number;
  }): ClaimedActivityJob | null {
    if (!workerId) throw new Error("Invalid Activity claim");
    return this.database.transaction(() => {
      while (true) {
        const row = this.database.connection.prepare(`
          SELECT job_key, source_kind, source_id, source_generation,
                 status, abandonment_count
          FROM activity_jobs
          WHERE eligible_at <= ? AND (
            status = 'pending' OR
            (status = 'error' AND retry_remaining > 0 AND retry_at <= ?) OR
            (status = 'running' AND lease_until <= ?)
          )
          ORDER BY eligible_at, job_key
          LIMIT 1
        `).get(now, now, now) as DatabaseRow | undefined;
        if (!row) return null;
        const expiredLease = row.status === "running";
        const abandonmentCount = integer(
          row.abandonment_count,
          "Activity abandonment count",
        ) + (expiredLease ? 1 : 0);
        if (expiredLease &&
            abandonmentCount >=
              this.config.worker.maxConsecutiveExpiredLeases) {
          const parked = changeCount(this.database.connection.prepare(`
            UPDATE activity_jobs SET
              status = 'error', worker_id = NULL, ownership_token = NULL,
              finished_at = ?, lease_until = NULL, retry_at = ?,
              abandonment_count = ?, last_error = ?
            WHERE job_key = ? AND status = 'running' AND lease_until <= ?
          `).run(
            now,
            now + this.config.worker.retryDelayMilliseconds,
            abandonmentCount,
            `Activity lease expired ${abandonmentCount} consecutive times`,
            String(row.job_key),
            now,
          ));
          if (parked === 1) continue;
          return null;
        }
        const ownershipToken = randomUUID();
        const leaseUntil = now + this.config.worker.leaseMilliseconds;
        const claimed = changeCount(this.database.connection.prepare(`
          UPDATE activity_jobs SET
            status = 'running', worker_id = ?, ownership_token = ?,
            started_at = ?, finished_at = NULL, lease_until = ?, retry_at = NULL,
            attempt_count = attempt_count + 1, abandonment_count = ?,
            last_error = NULL
          WHERE job_key = ? AND (
            status = 'pending' OR
            (status = 'error' AND retry_remaining > 0 AND retry_at <= ?) OR
            (status = 'running' AND lease_until <= ?)
          )
        `).run(
          workerId,
          ownershipToken,
          now,
          leaseUntil,
          abandonmentCount,
          String(row.job_key),
          now,
          now,
        ));
        if (claimed !== 1) return null;
        return {
          jobKey: String(row.job_key),
          sourceKind: String(row.source_kind) as ClaimedActivityJob["sourceKind"],
          sourceId: String(row.source_id),
          sourceGeneration: integer(row.source_generation, "Activity source generation"),
          workerId,
          ownershipToken,
          leaseUntil,
        };
      }
    });
  }

  heartbeat(
    jobKey: string,
    ownershipToken: string,
    now: number,
  ) {
    return changeCount(this.database.connection.prepare(`
      UPDATE activity_jobs SET lease_until = ?
      WHERE job_key = ? AND status = 'running' AND ownership_token = ?
        AND lease_until > ?
    `).run(
      now + this.config.worker.leaseMilliseconds,
      jobKey,
      ownershipToken,
      now,
    )) === 1;
  }

  loadClaimSources(claim: ClaimedActivityJob) {
    const job = this.database.connection.prepare(`
      SELECT source_kind, source_id, source_generation
      FROM activity_jobs
      WHERE job_key = ? AND status = 'running' AND ownership_token = ?
    `).get(claim.jobKey, claim.ownershipToken) as DatabaseRow | undefined;
    if (!job ||
        integer(job.source_generation, "Activity source generation") !==
          claim.sourceGeneration) {
      throw new Error("Activity ownership lost");
    }
    const sources = activitySourceRows(this.database.connection, job);
    if (claim.sourceKind === "observation_window") {
      return {
        sourceKind: claim.sourceKind,
        observations: sources.map((source) =>
          JSON.parse(String(source.projection_json)) as
            ReturnType<typeof projectObservation>),
      } as const;
    }
    const sessionIds = new Set(sources.map((source) => String(source.session_id)));
    if (sessionIds.size !== 1) throw new Error("Turn batch spans multiple Sessions");
    return {
      sourceKind: claim.sourceKind,
      sessionId: [...sessionIds][0]!,
      turns: sources.map((source) => JSON.parse(String(source.projection_json)) as
        ReturnType<typeof projectTurnBatch>["turns"][number]),
    } as const;
  }

  fail(
    jobKey: string,
    ownershipToken: string,
    error: string,
    failedAt = Date.now(),
  ) {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT retry_remaining, source_kind, source_id FROM activity_jobs
        WHERE job_key = ? AND status = 'running' AND ownership_token = ?
          AND lease_until > ?
      `).get(jobKey, ownershipToken, failedAt) as DatabaseRow | undefined;
      if (!row) return false;
      const retryRemaining = Math.max(
        0,
        integer(row.retry_remaining, "Activity retries") - 1,
      );
      for (const source of activitySourceRows(this.database.connection, row)) {
        this.database.connection.prepare(`
          UPDATE source_items SET sidecar_delete_after = ?
          WHERE id = ? AND sidecar_path IS NOT NULL
        `).run(
          failedAt + this.config.evidence.failedRetentionMilliseconds,
          String(source.id),
        );
      }
      const result = changeCount(this.database.connection.prepare(`
        UPDATE activity_jobs SET
          status = 'error', finished_at = ?, worker_id = NULL,
          ownership_token = NULL, lease_until = NULL,
          retry_at = ?, retry_remaining = ?, abandonment_count = 0,
          last_error = ?
        WHERE job_key = ? AND status = 'running' AND ownership_token = ?
          AND lease_until > ?
      `).run(
        failedAt,
        retryRemaining > 0
          ? failedAt + this.config.worker.retryDelayMilliseconds
          : null,
        retryRemaining,
        error,
        jobKey,
        ownershipToken,
        failedAt,
      ));
      return result === 1;
    });
  }

  startModelAttempt(attempt: StartModelAttempt) {
    recordModelAttempt(this.database.connection, "activity", attempt);
  }

  finishModelAttempt(attempt: FinishModelAttempt) {
    finishRecordedModelAttempt(this.database.connection, attempt);
  }
}
