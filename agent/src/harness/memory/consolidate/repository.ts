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
import type { MemoryScopeHint } from "../shared/memory-scope.js";
import {
  memorySourceArtifactPath,
  memorySourceContentHash,
  parseMemorySourceSnapshot,
  type MemorySourceSnapshot,
} from "../shared/memory-source.js";
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
  sourceKind: "chronicle" | "turn_memory";
  sourceId: string;
  sourceGeneration: number;
  sourceUpdatedAt: number;
  sourceSummary: string;
  rawMemory: string | null;
  scopeHints: MemoryScopeHint[];
  generatedAt: number;
} & Omit<MemorySourceSnapshot, "id" | "kind">;

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
        WITH current_sources AS (
          SELECT o.job_key, 'chronicle' AS source_kind, j.source_id,
                 o.source_generation, o.source_updated_at, o.source_summary,
                 NULL AS raw_memory, '[]' AS scope_json, o.generated_at,
                 w.start_at, w.end_at, NULL AS artifact_label,
                 'passive_screen' AS provenance
          FROM chronicle_summaries o
          JOIN memory_jobs j ON j.job_key = o.job_key
          JOIN chronicle_windows w ON w.id = j.source_id
          UNION ALL
          SELECT o.job_key, 'turn_memory' AS source_kind, j.source_id,
                 o.source_generation, o.source_updated_at,
                 o.turn_summary AS source_summary,
                 nullif(o.raw_memory, '') AS raw_memory,
                 '[]' AS scope_json, o.generated_at,
                 b.first_pending_at AS start_at, b.last_terminal_at AS end_at,
                 o.turn_slug AS artifact_label, 'user_turn' AS provenance
          FROM turn_memory_extractions o
          JOIN memory_jobs j ON j.job_key = o.job_key
          JOIN turn_memory_batches b ON b.id = j.source_id
          WHERE o.raw_memory != '' OR o.turn_summary != ''
        )
        SELECT * FROM current_sources
        WHERE source_updated_at <= ?
        ORDER BY CASE source_kind WHEN 'turn_memory' THEN 0 ELSE 1 END,
                 source_updated_at DESC, job_key DESC
        LIMIT ?
      `).all(
        integer(row.input_watermark, "Consolidation input watermark"),
        this.config.consolidation.maxSources,
      ) as Row[];
      const chronicleSourceIds = this.database.connection.prepare(`
        SELECT source_id FROM chronicle_summary_sources
        WHERE job_key = ? ORDER BY source_id
      `);
      const turnMemorySourceIds = this.database.connection.prepare(`
        SELECT source_id FROM turn_memory_extraction_sources
        WHERE job_key = ? ORDER BY source_id
      `);
      const insertSnapshot = this.database.connection.prepare(`
        INSERT INTO consolidation_inputs (
          ownership_token, job_key, source_kind, source_id,
          artifact_path, content_hash, started_at, ended_at,
          provenance, selection_state,
          source_generation, source_updated_at, source_summary, raw_memory,
          scope_json, source_ids_json, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const baselineRows = this.database.connection.prepare(`
        SELECT * FROM consolidation_source_baseline ORDER BY job_key
      `).all() as Row[];
      const baseline = new Map(baselineRows.map((input) => [String(input.job_key), input]));
      const snapshots: Row[] = [];
      for (const input of rows) {
        const sourceIds = input.source_kind === "chronicle"
          ? chronicleSourceIds
          : turnMemorySourceIds;
        const ids = (sourceIds.all(String(input.job_key)) as Row[])
          .map(({ source_id }) => String(source_id));
        const sourceKind = String(input.source_kind) as ConsolidationInput["sourceKind"];
        const artifactPath = memorySourceArtifactPath({
          id: String(input.job_key),
          kind: sourceKind,
          ...(input.artifact_label === null
            ? {}
            : { label: String(input.artifact_label) }),
        });
        const contentHash = memorySourceContentHash({
          sourceKind,
          sourceGeneration: input.source_generation,
          sourceSummary: input.source_summary,
          rawMemory: input.raw_memory,
          startedAt: input.start_at,
          endedAt: input.end_at,
          sourceIds: ids,
        });
        const previous = baseline.get(String(input.job_key));
        snapshots.push({
          ...input,
          artifact_path: artifactPath,
          content_hash: contentHash,
          source_ids_json: JSON.stringify(ids),
          selection_state: previous && String(previous.content_hash) === contentHash
            ? "retained"
            : "added",
        });
        baseline.delete(String(input.job_key));
      }
      for (const removed of baseline.values()) {
        snapshots.push({ ...removed, selection_state: "removed" });
      }
      snapshots.sort((left, right) => String(left.job_key).localeCompare(String(right.job_key)));
      for (const input of snapshots) {
        insertSnapshot.run(
          ownershipToken,
          String(input.job_key),
          String(input.source_kind),
          String(input.source_id),
          String(input.artifact_path),
          String(input.content_hash),
          integer(input.start_at ?? input.started_at, "Memory source start time"),
          integer(input.end_at ?? input.ended_at, "Memory source end time"),
          String(input.provenance),
          String(input.selection_state),
          integer(input.source_generation, "Memory source generation"),
          integer(input.source_updated_at, "Memory source watermark"),
          String(input.source_summary),
          input.raw_memory === null ? null : String(input.raw_memory),
          String(input.scope_json),
          String(input.source_ids_json),
          integer(input.generated_at, "Memory source generated time"),
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
      SELECT job_key, source_kind, source_id, artifact_path, content_hash,
             started_at, ended_at, provenance, selection_state, source_generation,
             source_updated_at, source_summary, raw_memory, scope_json,
             source_ids_json, generated_at
      FROM consolidation_inputs
      WHERE ownership_token = ?
      ORDER BY job_key
    `).all(claim.ownershipToken) as Row[];
    return rows.map((row) => {
      const sourceKind = String(row.source_kind) as ConsolidationInput["sourceKind"];
      const snapshot = parseMemorySourceSnapshot({
        id: String(row.job_key),
        kind: sourceKind,
        artifactPath: String(row.artifact_path),
        contentHash: String(row.content_hash),
        startedAt: integer(row.started_at, "Memory source start time"),
        endedAt: integer(row.ended_at, "Memory source end time"),
        provenance: String(row.provenance),
        sourceIds: JSON.parse(String(row.source_ids_json)),
        state: String(row.selection_state),
      });
      return {
        jobKey: String(row.job_key),
        sourceKind,
        sourceId: String(row.source_id),
        sourceGeneration: integer(row.source_generation, "Memory source generation"),
        sourceUpdatedAt: integer(row.source_updated_at, "Memory source watermark"),
        sourceSummary: String(row.source_summary),
        rawMemory: row.raw_memory === null ? null : String(row.raw_memory),
        scopeHints: JSON.parse(String(row.scope_json)) as MemoryScopeHint[],
        generatedAt: integer(row.generated_at, "Memory source generated time"),
        artifactPath: snapshot.artifactPath,
        contentHash: snapshot.contentHash,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
        provenance: snapshot.provenance,
        sourceIds: snapshot.sourceIds,
        state: snapshot.state,
      };
    });
  }

  startModelAttempt({
    id,
    model,
    requestHash,
    attemptedAt,
    inputTokens,
    requestCharacters,
  }: {
    id: string;
    model: string;
    requestHash: string;
    attemptedAt: number;
    inputTokens: number;
    requestCharacters: number;
  }) {
    recordModelAttempt(this.database.connection, {
      id,
      operation: "global_memory_consolidation",
      jobKey: JOB_KEY,
      model,
      requestHash,
      requestCharacters,
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
