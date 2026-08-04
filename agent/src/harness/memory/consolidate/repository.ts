import { randomUUID } from "node:crypto";

import {
  finishModelAttempt as finishRecordedModelAttempt,
  startModelAttempt as recordModelAttempt,
  type FinishModelAttempt,
} from "../db/attempts.js";
import {
  changed,
  integer,
  type DatabaseRow as Row,
  type MemoryDatabase,
} from "../db/database.js";
import type { MemoryScopeHint } from "../activity/types.js";
import type { MemoryPipelineConfig } from "../types.js";
import { ConsolidationPublications } from "./publication.js";

export type { ConsolidationPublication } from "./publication.js";

const JOB_KEY = "global";

export type ConsolidationClaim = {
  workerId: string;
  ownershipToken: string;
  inputWatermark: number;
  leaseUntil: number;
};

export type ConsolidationInput = {
  jobKey: string;
  sourceKind: "observation_window" | "turn_batch";
  sourceId: string;
  sourceGeneration: number;
  sourceUpdatedAt: number;
  sourceSummary: string;
  rawMemory: string | null;
  scopeHints: MemoryScopeHint[];
  generatedAt: number;
};

export type ConsolidationClaimResult =
  | { status: "claimed"; claim: ConsolidationClaim }
  | {
      status: "skipped";
      reason:
        | "missing"
        | "up_to_date"
        | "running"
        | "retry"
        | "retry_exhausted"
        | "cooldown";
    };

export class ConsolidationRepository {
  private readonly publications: ConsolidationPublications;

  constructor(
    private readonly database: MemoryDatabase,
    readonly config: MemoryPipelineConfig,
  ) {
    this.publications = new ConsolidationPublications(database, config);
  }

  claim(workerId: string, now = Date.now()): ConsolidationClaimResult {
    if (!workerId) throw new Error("Consolidation worker ID is required");
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT status, lease_until, retry_at, retry_remaining,
               input_watermark, last_success_watermark, finished_at,
               ownership_token, abandonment_count
        FROM consolidation_jobs WHERE job_key = ?
      `).get(JOB_KEY) as Row | undefined;
      if (!row) return { status: "skipped", reason: "missing" };
      if (row.status === "done" &&
          integer(row.input_watermark, "Consolidation input watermark") <=
            integer(row.last_success_watermark, "Consolidation success watermark")) {
        return { status: "skipped", reason: "up_to_date" };
      }
      if (row.status === "running" &&
          row.lease_until !== null &&
          integer(row.lease_until, "Consolidation lease") > now) {
        return { status: "skipped", reason: "running" };
      }
      if (row.status === "error") {
        const retries = integer(row.retry_remaining, "Consolidation retries");
        if (retries === 0) {
          return { status: "skipped", reason: "retry_exhausted" };
        }
        if (row.retry_at !== null && integer(row.retry_at, "Consolidation retry") > now) {
          return { status: "skipped", reason: "retry" };
        }
      }
      if (row.finished_at !== null &&
          integer(row.finished_at, "Consolidation success time") +
            this.config.consolidation.cooldownMilliseconds > now &&
          row.status !== "error" && row.status !== "running") {
        return { status: "skipped", reason: "cooldown" };
      }

      const expiredLease = row.status === "running" &&
        row.lease_until !== null &&
        integer(row.lease_until, "Consolidation lease") <= now;
      const abandonmentCount = integer(
        row.abandonment_count,
        "Consolidation abandonment count",
      ) + (expiredLease ? 1 : 0);
      if (expiredLease &&
          abandonmentCount >=
            this.config.worker.maxConsecutiveExpiredLeases) {
        const parked = changed(this.database.connection.prepare(`
          UPDATE consolidation_jobs SET
            status = 'error', worker_id = NULL, ownership_token = NULL,
            finished_at = ?, lease_until = NULL, retry_at = ?,
            abandonment_count = ?, last_error = ?
          WHERE job_key = ? AND status = 'running'
            AND ownership_token = ? AND lease_until <= ?
        `).run(
          now,
          now + this.config.worker.retryDelayMilliseconds,
          abandonmentCount,
          `Consolidation lease expired ${abandonmentCount} consecutive times`,
          JOB_KEY,
          String(row.ownership_token),
          now,
        ));
        if (parked) {
          this.database.connection.prepare(
            "DELETE FROM consolidation_inputs WHERE ownership_token = ?",
          ).run(String(row.ownership_token));
          return { status: "skipped", reason: "retry" };
        }
        return { status: "skipped", reason: "running" };
      }

      const ownershipToken = randomUUID();
      const leaseUntil = now + this.config.worker.leaseMilliseconds;
      const claimed = changed(this.database.connection.prepare(`
        UPDATE consolidation_jobs SET
          status = 'running', worker_id = ?, ownership_token = ?,
          started_at = ?, lease_until = ?, retry_at = NULL,
          abandonment_count = ?, last_error = NULL
        WHERE job_key = ? AND (
          status IN ('pending', 'done') OR
          (status = 'error' AND retry_remaining > 0 AND
            (retry_at IS NULL OR retry_at <= ?)) OR
          (status = 'running' AND lease_until <= ?)
        )
      `).run(
        workerId,
        ownershipToken,
        now,
        leaseUntil,
        abandonmentCount,
        JOB_KEY,
        now,
        now,
      ));
      if (!claimed) return { status: "skipped", reason: "running" };
      this.database.connection.prepare("DELETE FROM consolidation_inputs").run();
      const rows = this.database.connection.prepare(`
        SELECT o.job_key, j.source_kind, j.source_id,
               o.source_generation, o.source_updated_at, o.source_summary,
               o.raw_memory, o.scope_json, o.generated_at
        FROM activity_summaries o
        JOIN activity_jobs j ON j.job_key = o.job_key
        WHERE o.source_updated_at <= ?
        ORDER BY o.job_key
      `).all(integer(row.input_watermark, "Consolidation input watermark")) as Row[];
      const sourceIds = this.database.connection.prepare(`
        SELECT source_id FROM activity_summary_sources
        WHERE job_key = ? ORDER BY source_id
      `);
      const insertSnapshot = this.database.connection.prepare(`
        INSERT INTO consolidation_inputs (
          ownership_token, job_key, source_kind, source_id,
          source_generation, source_updated_at, source_summary, raw_memory,
          scope_json, source_ids_json, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const input of rows) {
        const ids = (sourceIds.all(String(input.job_key)) as Row[])
          .map(({ source_id }) => String(source_id));
        insertSnapshot.run(
          ownershipToken,
          String(input.job_key),
          String(input.source_kind),
          String(input.source_id),
          integer(input.source_generation, "Activity source generation"),
          integer(input.source_updated_at, "Activity source watermark"),
          String(input.source_summary),
          input.raw_memory === null ? null : String(input.raw_memory),
          String(input.scope_json),
          JSON.stringify(ids),
          integer(input.generated_at, "Activity generated time"),
        );
      }
      return {
        status: "claimed",
        claim: {
          workerId,
          ownershipToken,
          inputWatermark: integer(row.input_watermark, "Consolidation input watermark"),
          leaseUntil,
        },
      };
    });
  }

  heartbeat(claim: ConsolidationClaim, now = Date.now()) {
    return changed(this.database.connection.prepare(`
      UPDATE consolidation_jobs SET lease_until = ?
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ? AND lease_until > ?
    `).run(
      now + this.config.worker.leaseMilliseconds,
      JOB_KEY,
      claim.ownershipToken,
      now,
    ));
  }

  owns(claim: ConsolidationClaim, now = Date.now()) {
    const row = this.database.connection.prepare(`
      SELECT 1 AS owned FROM consolidation_jobs
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ? AND lease_until > ?
    `).get(JOB_KEY, claim.ownershipToken, now);
    return row !== undefined;
  }

  loadInputs(claim: ConsolidationClaim): ConsolidationInput[] {
    const owned = this.database.connection.prepare(`
      SELECT 1 AS owned FROM consolidation_jobs
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ?
    `).get(JOB_KEY, claim.ownershipToken);
    if (!owned) throw new Error("Consolidation ownership lost");
    const rows = this.database.connection.prepare(`
      SELECT job_key, source_kind, source_id, source_generation,
             source_updated_at, source_summary, raw_memory, scope_json,
             generated_at
      FROM consolidation_inputs
      WHERE ownership_token = ?
      ORDER BY job_key
    `).all(claim.ownershipToken) as Row[];
    return rows.map((row) => ({
      jobKey: String(row.job_key),
      sourceKind: String(row.source_kind) as ConsolidationInput["sourceKind"],
      sourceId: String(row.source_id),
      sourceGeneration: integer(row.source_generation, "Activity source generation"),
      sourceUpdatedAt: integer(row.source_updated_at, "Activity source watermark"),
      sourceSummary: String(row.source_summary),
      rawMemory: row.raw_memory === null ? null : String(row.raw_memory),
      scopeHints: JSON.parse(String(row.scope_json)) as MemoryScopeHint[],
      generatedAt: integer(row.generated_at, "Activity generated time"),
    }));
  }

  startModelAttempt({
    id,
    model,
    requestHash,
    attemptedAt,
    inputTokens,
  }: {
    id: string;
    model: string;
    requestHash: string;
    attemptedAt: number;
    inputTokens: number;
  }) {
    recordModelAttempt(this.database.connection, "consolidation", {
      id,
      jobKey: JOB_KEY,
      model,
      requestHash,
      attemptedAt,
      inputTokens,
    });
  }

  finishModelAttempt(attempt: FinishModelAttempt) {
    finishRecordedModelAttempt(this.database.connection, attempt);
  }

  publication() {
    return this.publications.publication();
  }

  preparePublication(...args: Parameters<ConsolidationPublications["prepare"]>) {
    return this.publications.prepare(...args);
  }

  beginPublication(...args: Parameters<ConsolidationPublications["begin"]>) {
    return this.publications.begin(...args);
  }

  clearPublication(...args: Parameters<ConsolidationPublications["clear"]>) {
    return this.publications.clear(...args);
  }

  succeed(...args: Parameters<ConsolidationPublications["succeed"]>) {
    return this.publications.succeed(...args);
  }

  finalizePublication(...args: Parameters<ConsolidationPublications["finalize"]>) {
    return this.publications.finalize(...args);
  }

  fail(claim: ConsolidationClaim, error: string, failedAt = Date.now()) {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT retry_remaining FROM consolidation_jobs
        WHERE job_key = ? AND status = 'running'
          AND ownership_token = ? AND lease_until > ?
      `).get(JOB_KEY, claim.ownershipToken, failedAt) as Row | undefined;
      if (!row) return false;
      const retryRemaining = Math.max(
        0,
        integer(row.retry_remaining, "Consolidation retries") - 1,
      );
      const failed = changed(this.database.connection.prepare(`
        UPDATE consolidation_jobs SET
          status = 'error', worker_id = NULL, ownership_token = NULL,
          finished_at = ?, lease_until = NULL, retry_at = ?,
          retry_remaining = ?, abandonment_count = 0, last_error = ?
        WHERE job_key = ? AND status = 'running'
          AND ownership_token = ?
      `).run(
        failedAt,
        retryRemaining > 0
          ? failedAt + this.config.worker.retryDelayMilliseconds
          : null,
        retryRemaining,
        error,
        JOB_KEY,
        claim.ownershipToken,
      ));
      if (failed) {
        this.database.connection.prepare(`
          DELETE FROM consolidation_inputs WHERE ownership_token = ?
        `).run(claim.ownershipToken);
      }
      return failed;
    });
  }
}
