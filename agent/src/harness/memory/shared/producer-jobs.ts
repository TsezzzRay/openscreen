import { randomUUID } from "node:crypto";

import type { ModelOperation } from "../db/attempts.js";
import {
  changed,
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import type { MemoryPipelineConfig } from "../types.js";

export type ProducerJobKind = Exclude<ModelOperation, "global_memory_consolidation">;

export type ProducerJobClaim = {
  jobKey: string;
  kind: ProducerJobKind;
  sourceId: string;
  sourceGeneration: number;
  workerId: string;
  ownershipToken: string;
  leaseUntil: number;
};

export class ProducerJobs {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly config: MemoryPipelineConfig,
  ) {}

  queue({
    jobKey,
    kind,
    sourceId,
    sourceGeneration,
    eligibleAt,
  }: {
    jobKey: string;
    kind: ProducerJobKind;
    sourceId: string;
    sourceGeneration: number;
    eligibleAt: number;
  }) {
    this.database.connection.prepare(`
      INSERT INTO memory_jobs (
        job_key, kind, source_id, source_generation, status,
        eligible_at, retry_remaining
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (kind, source_id) DO UPDATE SET
        source_generation = excluded.source_generation,
        status = 'pending', eligible_at = excluded.eligible_at,
        worker_id = NULL, ownership_token = NULL, started_at = NULL,
        finished_at = NULL, lease_until = NULL, retry_at = NULL,
        retry_remaining = excluded.retry_remaining,
        abandonment_count = 0, last_error = NULL
    `).run(
      jobKey,
      kind,
      sourceId,
      sourceGeneration,
      eligibleAt,
      this.config.worker.maxAttempts,
    );
  }

  claimNext(
    kind: ProducerJobKind,
    { workerId, now = Date.now() }: { workerId: string; now?: number },
  ): ProducerJobClaim | null {
    if (!workerId) throw new Error("Invalid memory producer claim");
    return this.database.transaction(() => {
      while (true) {
        const row = this.database.connection.prepare(`
          SELECT job_key, kind, source_id, source_generation,
                 status, abandonment_count
          FROM memory_jobs
          WHERE kind = ? AND eligible_at <= ? AND (
            status = 'pending' OR
            (status = 'error' AND retry_remaining > 0 AND retry_at <= ?) OR
            (status = 'running' AND lease_until <= ?)
          )
          ORDER BY eligible_at, job_key
          LIMIT 1
        `).get(kind, now, now, now) as DatabaseRow | undefined;
        if (!row) return null;
        const expiredLease = row.status === "running";
        const abandonmentCount = integer(
          row.abandonment_count,
          "memory producer abandonment count",
        ) + (expiredLease ? 1 : 0);
        if (expiredLease &&
            abandonmentCount >= this.config.worker.maxConsecutiveExpiredLeases) {
          const parked = changed(this.database.connection.prepare(`
            UPDATE memory_jobs SET
              status = 'error', worker_id = NULL, ownership_token = NULL,
              finished_at = ?, lease_until = NULL, retry_at = ?,
              abandonment_count = ?, last_error = ?
            WHERE job_key = ? AND status = 'running' AND lease_until <= ?
          `).run(
            now,
            now + this.config.worker.retryDelayMilliseconds,
            abandonmentCount,
            `${kind} lease expired ${abandonmentCount} consecutive times`,
            String(row.job_key),
            now,
          ));
          if (parked) continue;
          return null;
        }
        const ownershipToken = randomUUID();
        const leaseUntil = now + this.config.worker.leaseMilliseconds;
        const claimed = changed(this.database.connection.prepare(`
          UPDATE memory_jobs SET
            status = 'running', worker_id = ?, ownership_token = ?,
            started_at = ?, finished_at = NULL, lease_until = ?, retry_at = NULL,
            attempt_count = attempt_count + 1, abandonment_count = ?,
            last_error = NULL
          WHERE job_key = ? AND kind = ? AND (
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
          kind,
          now,
          now,
        ));
        if (!claimed) return null;
        return {
          jobKey: String(row.job_key),
          kind,
          sourceId: String(row.source_id),
          sourceGeneration: integer(
            row.source_generation,
            "memory producer source generation",
          ),
          workerId,
          ownershipToken,
          leaseUntil,
        };
      }
    });
  }

  heartbeat(claim: ProducerJobClaim, now: number) {
    return changed(this.database.connection.prepare(`
      UPDATE memory_jobs SET lease_until = ?
      WHERE job_key = ? AND kind = ? AND status = 'running'
        AND ownership_token = ? AND source_generation = ? AND lease_until > ?
    `).run(
      now + this.config.worker.leaseMilliseconds,
      claim.jobKey,
      claim.kind,
      claim.ownershipToken,
      claim.sourceGeneration,
      now,
    ));
  }

  owned(claim: ProducerJobClaim, now: number) {
    const row = this.database.connection.prepare(`
      SELECT source_id, source_generation FROM memory_jobs
      WHERE job_key = ? AND kind = ? AND status = 'running'
        AND ownership_token = ? AND source_generation = ? AND lease_until > ?
    `).get(
      claim.jobKey,
      claim.kind,
      claim.ownershipToken,
      claim.sourceGeneration,
      now,
    ) as DatabaseRow | undefined;
    if (!row) throw new Error(`${claim.kind} ownership lost`);
    return row;
  }

  complete(claim: ProducerJobClaim, completedAt: number) {
    return changed(this.database.connection.prepare(`
      UPDATE memory_jobs SET
        status = 'succeeded', finished_at = ?, worker_id = NULL,
        ownership_token = NULL, lease_until = NULL, retry_at = NULL,
        abandonment_count = 0, last_error = NULL
      WHERE job_key = ? AND kind = ? AND status = 'running'
        AND ownership_token = ? AND source_generation = ? AND lease_until > ?
    `).run(
      completedAt,
      claim.jobKey,
      claim.kind,
      claim.ownershipToken,
      claim.sourceGeneration,
      completedAt,
    ));
  }

  fail(claim: ProducerJobClaim, error: string, failedAt = Date.now()) {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT retry_remaining FROM memory_jobs
        WHERE job_key = ? AND kind = ? AND status = 'running'
          AND ownership_token = ? AND source_generation = ? AND lease_until > ?
      `).get(
        claim.jobKey,
        claim.kind,
        claim.ownershipToken,
        claim.sourceGeneration,
        failedAt,
      ) as DatabaseRow | undefined;
      if (!row) return false;
      const retryRemaining = Math.max(
        0,
        integer(row.retry_remaining, "memory producer retries") - 1,
      );
      return changed(this.database.connection.prepare(`
        UPDATE memory_jobs SET
          status = 'error', finished_at = ?, worker_id = NULL,
          ownership_token = NULL, lease_until = NULL,
          retry_at = ?, retry_remaining = ?, abandonment_count = 0,
          last_error = ?
        WHERE job_key = ? AND kind = ? AND status = 'running'
          AND ownership_token = ? AND source_generation = ? AND lease_until > ?
      `).run(
        failedAt,
        retryRemaining > 0
          ? failedAt + this.config.worker.retryDelayMilliseconds
          : null,
        retryRemaining,
        error,
        claim.jobKey,
        claim.kind,
        claim.ownershipToken,
        claim.sourceGeneration,
        failedAt,
      ));
    });
  }
}
