import { createHash, randomUUID } from "node:crypto";

import {
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../database.js";
import {
  deactivateMemorySourcesByEvidenceInTransaction,
  recordMemorySourceInTransaction,
} from "../consolidate/source-repository.js";
import { turnMemoryBatchEligibility } from "./batch-scheduler.js";
import { estimateTurnMemoryInputTokens } from "./extractor.js";
import { projectTurnMemoryBatch } from "./model-projection.js";
import {
  renderRawMemories,
  renderTurnMemoryRollout,
  type RenderedMemoryArtifact,
} from "./rollout.js";
import { TurnMemoryScanCursorRepository } from "./scan-cursor.js";
import type {
  TerminalTurnProjection,
  TurnMemoryBatchProjection,
  TurnMemoryExtraction,
  TurnMemorySource,
} from "./types.js";

const JOB_KIND = "turn_memory_extraction";

export interface TurnMemoryPolicy {
  maxInputTokens: number;
  maxOutputTokens: number;
  idleMilliseconds: number;
  hardCapMilliseconds: number;
  worker: {
    leaseMilliseconds: number;
    retryDelayMilliseconds: number;
    maxAttempts: number;
  };
}

export interface TurnMemoryClaim {
  jobKey: string;
  sourceId: string;
  sourceGeneration: number;
  workerId: string;
  ownershipToken: string;
}

export interface PendingMemoryArtifact {
  artifactKey: string;
  relativePath: string;
  content: string;
  contentHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function occurredAt(source: TurnMemorySource): number {
  const result = Date.parse(source.occurredAt);
  if (!Number.isFinite(result)) throw new Error("Invalid Turn occurrence");
  return result;
}

function provenanceHash(source: TurnMemorySource): string {
  return sha256(JSON.stringify({
    threadId: source.threadId,
    sessionId: source.sessionId,
    cwd: source.cwd,
    gitBranch: source.gitBranch,
    rolloutPath: source.rolloutPath,
  }));
}

function batchId(source: TurnMemorySource): string {
  return `turn-memory-batch:${source.sessionId}:${sha256(source.sourceId).slice(0, 16)}`;
}

function jobKey(id: string): string {
  return `turn-memory:${id}`;
}

export class TurnMemoryRepository {
  private readonly cursors: TurnMemoryScanCursorRepository;

  constructor(
    private readonly database: MemoryDatabase,
    readonly policy: TurnMemoryPolicy,
  ) {
    this.cursors = new TurnMemoryScanCursorRepository(database);
  }

  private queueBatch(
    id: string,
    sourceGeneration: number,
    eligibleAt: number,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO memory_jobs (
        job_key, kind, source_id, source_generation, status, eligible_at,
        retry_remaining
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (kind, source_id) DO UPDATE SET
        source_generation = excluded.source_generation,
        status = 'pending',
        eligible_at = excluded.eligible_at,
        worker_id = NULL,
        ownership_token = NULL,
        started_at = NULL,
        finished_at = NULL,
        lease_until = NULL,
        retry_at = NULL,
        retry_remaining = excluded.retry_remaining,
        last_error = NULL
      WHERE memory_jobs.source_generation < excluded.source_generation
    `).run(
      jobKey(id),
      JOB_KIND,
      id,
      sourceGeneration,
      eligibleAt,
      this.policy.worker.maxAttempts,
    );
  }

  private owned(claim: TurnMemoryClaim): void {
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
    if (row === undefined) throw new Error("Turn Memory ownership lost");
  }

  private batchSources(id: string): TurnMemorySource[] {
    return (this.database.connection.prepare(`
      SELECT s.projection_json
      FROM turn_memory_batch_sources bs
      JOIN turn_memory_sources s ON s.id = bs.source_id
      WHERE bs.batch_id = ? AND s.active = 1
      ORDER BY bs.ordinal
    `).all(id) as DatabaseRow[]).map((row) =>
      JSON.parse(String(row.projection_json)) as TurnMemorySource
    );
  }

  private estimateSources(sources: TurnMemorySource[]): number {
    return estimateTurnMemoryInputTokens(projectTurnMemoryBatch(sources));
  }

  private sealBatch(
    row: DatabaseRow,
    reason: "idle" | "hard_cap" | "budget" | "recovery",
    eligibleAt: number,
    updatedAt: number,
  ): void {
    const id = String(row.id);
    this.database.connection.prepare(`
      UPDATE turn_memory_batches SET
        status = 'sealed', close_reason = ?, eligible_at = ?,
        source_generation = source_generation + 1, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(reason, eligibleAt, updatedAt, id);
    const updated = this.database.connection.prepare(`
      SELECT source_generation FROM turn_memory_batches WHERE id = ?
    `).get(id) as DatabaseRow;
    this.queueBatch(
      id,
      integer(updated.source_generation, "Turn Memory batch generation"),
      eligibleAt,
    );
  }

  private openBatch(sessionId: string): DatabaseRow | undefined {
    return this.database.connection.prepare(`
      SELECT * FROM turn_memory_batches
      WHERE session_id = ? AND status = 'open'
    `).get(sessionId) as DatabaseRow | undefined;
  }

  private createBatch(source: TurnMemorySource, ingestedAt: number): void {
    const sourceTime = occurredAt(source);
    const id = batchId(source);
    const projectedTokens = this.estimateSources([source]);
    const eligibility = turnMemoryBatchEligibility({
      firstPendingAt: sourceTime,
      lastTerminalAt: sourceTime,
      projectedInputTokens: projectedTokens,
      maxInputTokens: this.policy.maxInputTokens,
      idleMilliseconds: this.policy.idleMilliseconds,
      hardCapMilliseconds: this.policy.hardCapMilliseconds,
    });
    const sealed = eligibility.reason === "budget";
    this.database.connection.prepare(`
      INSERT INTO turn_memory_batches (
        id, session_id, provenance_hash, first_pending_at, last_terminal_at,
        eligible_at, status, close_reason, projected_input_tokens,
        max_input_tokens, source_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      source.sessionId,
      provenanceHash(source),
      sourceTime,
      sourceTime,
      eligibility.eligibleAt,
      sealed ? "sealed" : "open",
      sealed ? "budget" : null,
      projectedTokens,
      this.policy.maxInputTokens,
      ingestedAt,
      ingestedAt,
    );
    this.database.connection.prepare(`
      INSERT INTO turn_memory_batch_sources (batch_id, source_id, ordinal)
      VALUES (?, ?, 0)
    `).run(id, source.sourceId);
    if (sealed) this.queueBatch(id, 1, eligibility.eligibleAt);
  }

  private appendToOpenBatch(
    row: DatabaseRow,
    source: TurnMemorySource,
    ingestedAt: number,
  ): void {
    const id = String(row.id);
    const existingSources = this.batchSources(id);
    const sourceTime = occurredAt(source);
    const candidate = [...existingSources, source];
    const candidateTokens = this.estimateSources(candidate);
    if (candidateTokens > this.policy.maxInputTokens) {
      this.sealBatch(row, "budget", sourceTime, ingestedAt);
      this.createBatch(source, ingestedAt);
      return;
    }
    const ordinal = existingSources.length;
    this.database.connection.prepare(`
      INSERT INTO turn_memory_batch_sources (batch_id, source_id, ordinal)
      VALUES (?, ?, ?)
    `).run(id, source.sourceId, ordinal);
    const eligibility = turnMemoryBatchEligibility({
      firstPendingAt: integer(row.first_pending_at, "Turn Memory batch start"),
      lastTerminalAt: sourceTime,
      projectedInputTokens: candidateTokens,
      maxInputTokens: this.policy.maxInputTokens,
      idleMilliseconds: this.policy.idleMilliseconds,
      hardCapMilliseconds: this.policy.hardCapMilliseconds,
    });
    const sealed = eligibility.reason === "budget";
    this.database.connection.prepare(`
      UPDATE turn_memory_batches SET
        last_terminal_at = ?, eligible_at = ?, status = ?, close_reason = ?,
        projected_input_tokens = ?, source_generation = source_generation + 1,
        updated_at = ?
      WHERE id = ?
    `).run(
      sourceTime,
      eligibility.eligibleAt,
      sealed ? "sealed" : "open",
      sealed ? "budget" : null,
      candidateTokens,
      ingestedAt,
      id,
    );
    if (sealed) {
      const updated = this.database.connection.prepare(`
        SELECT source_generation FROM turn_memory_batches WHERE id = ?
      `).get(id) as DatabaseRow;
      this.queueBatch(
        id,
        integer(updated.source_generation, "Turn Memory batch generation"),
        eligibility.eligibleAt,
      );
    }
  }

  private addSourceToBatch(source: TurnMemorySource, ingestedAt: number): void {
    let open = this.openBatch(source.sessionId);
    if (open !== undefined) {
      const sourceTime = occurredAt(source);
      const provenanceChanged = String(open.provenance_hash) !==
        provenanceHash(source);
      const becameDue = sourceTime >= integer(
        open.eligible_at,
        "Turn Memory batch eligibility",
      );
      if (provenanceChanged || becameDue) {
        let reason: "idle" | "hard_cap" | "recovery" = "recovery";
        if (!provenanceChanged) {
          const hardCapAt = integer(open.first_pending_at, "Turn Memory batch start") +
            this.policy.hardCapMilliseconds;
          reason = integer(open.eligible_at, "Turn Memory batch eligibility") === hardCapAt
            ? "hard_cap"
            : "idle";
        }
        this.sealBatch(
          open,
          reason,
          integer(open.eligible_at, "Turn Memory batch eligibility"),
          ingestedAt,
        );
        open = undefined;
      }
    }
    if (open === undefined) this.createBatch(source, ingestedAt);
    else this.appendToOpenBatch(open, source, ingestedAt);
  }

  private updateExistingBatch(source: TurnMemorySource, ingestedAt: number): void {
    const row = this.database.connection.prepare(`
      SELECT b.*
      FROM turn_memory_batch_sources bs
      JOIN turn_memory_batches b ON b.id = bs.batch_id
      WHERE bs.source_id = ?
      ORDER BY b.created_at DESC LIMIT 1
    `).get(source.sourceId) as DatabaseRow | undefined;
    if (row === undefined) {
      this.addSourceToBatch(source, ingestedAt);
      return;
    }
    const id = String(row.id);
    const sources = this.batchSources(id);
    if (sources.length === 0) return;
    const projectedTokens = this.estimateSources(sources);
    this.database.connection.prepare(`
      UPDATE turn_memory_batches SET
        projected_input_tokens = ?, source_generation = source_generation + 1,
        updated_at = ?
      WHERE id = ?
    `).run(projectedTokens, ingestedAt, id);
    if (String(row.status) === "sealed") {
      const updated = this.database.connection.prepare(`
        SELECT source_generation, eligible_at
        FROM turn_memory_batches WHERE id = ?
      `).get(id) as DatabaseRow;
      this.queueBatch(
        id,
        integer(updated.source_generation, "Turn Memory batch generation"),
        integer(updated.eligible_at, "Turn Memory batch eligibility"),
      );
    }
  }

  private upsertSource(
    source: TurnMemorySource,
    ingestedAt: number,
  ): "ingested" | "updated" | "unchanged" {
    const sourceTime = occurredAt(source);
    const projectionJson = JSON.stringify(source);
    const projectionHash = sha256(projectionJson);
    const existing = this.database.connection.prepare(`
      SELECT projection_hash, active FROM turn_memory_sources WHERE id = ?
    `).get(source.sourceId) as DatabaseRow | undefined;
    if (
      existing !== undefined &&
      String(existing.projection_hash) === projectionHash &&
      Number(existing.active) === 1
    ) {
      return "unchanged";
    }
    if (existing === undefined) {
      this.database.connection.prepare(`
        INSERT INTO turn_memory_sources (
          id, session_id, occurred_at, projection_json, projection_hash,
          source_generation, active, ingested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(
        source.sourceId,
        source.sessionId,
        sourceTime,
        projectionJson,
        projectionHash,
        ingestedAt,
        ingestedAt,
      );
      this.addSourceToBatch(source, ingestedAt);
      return "ingested";
    }
    this.database.connection.prepare(`
      UPDATE turn_memory_sources SET
        session_id = ?, occurred_at = ?, projection_json = ?,
        projection_hash = ?, source_generation = source_generation + 1,
        active = 1, updated_at = ?
      WHERE id = ?
    `).run(
      source.sessionId,
      sourceTime,
      projectionJson,
      projectionHash,
      ingestedAt,
      source.sourceId,
    );
    this.updateExistingBatch(source, ingestedAt);
    return "updated";
  }

  private reconcileBranch(
    sessionId: string,
    activeSourceIds: readonly string[],
    updatedAt: number,
  ): number {
    const active = new Set(activeSourceIds);
    const rows = this.database.connection.prepare(`
      SELECT id FROM turn_memory_sources
      WHERE session_id = ? AND active = 1
    `).all(sessionId) as DatabaseRow[];
    const abandoned = rows
      .map((row) => String(row.id))
      .filter((id) => !active.has(id));
    if (abandoned.length === 0) return 0;
    const openBatchIds = new Set<string>();
    const findOpenBatch = this.database.connection.prepare(`
      SELECT b.id
      FROM turn_memory_batch_sources bs
      JOIN turn_memory_batches b ON b.id = bs.batch_id
      WHERE bs.source_id = ? AND b.status = 'open'
    `);
    for (const id of abandoned) {
      const batch = findOpenBatch.get(id) as DatabaseRow | undefined;
      if (batch !== undefined) openBatchIds.add(String(batch.id));
      this.database.connection.prepare(`
        UPDATE turn_memory_sources SET
          active = 0, source_generation = source_generation + 1, updated_at = ?
        WHERE id = ? AND active = 1
      `).run(updatedAt, id);
    }
    const deactivatedMemorySources = deactivateMemorySourcesByEvidenceInTransaction(
      this.database,
      abandoned,
      this.policy.worker.maxAttempts,
    );
    if (deactivatedMemorySources > 0) {
      this.refreshRawMemories(updatedAt, updatedAt);
    }
    for (const id of openBatchIds) {
      this.database.connection.prepare(`
        DELETE FROM turn_memory_batch_sources
        WHERE batch_id = ? AND source_id IN (
          SELECT id FROM turn_memory_sources WHERE active = 0
        )
      `).run(id);
      const sources = this.batchSources(id);
      if (sources.length === 0) {
        this.database.connection.prepare(
          "DELETE FROM turn_memory_batches WHERE id = ? AND status = 'open'",
        ).run(id);
        continue;
      }
      const row = this.database.connection.prepare(`
        SELECT * FROM turn_memory_batches WHERE id = ?
      `).get(id) as DatabaseRow;
      const lastTerminalAt = Math.max(...sources.map(occurredAt));
      this.database.connection.prepare(`
        UPDATE turn_memory_batches SET
          last_terminal_at = ?, projected_input_tokens = ?, updated_at = ?
        WHERE id = ?
      `).run(lastTerminalAt, this.estimateSources(sources), updatedAt, id);
      this.sealBatch(row, "recovery", updatedAt, updatedAt);
    }
    return abandoned.length;
  }

  commitScan({
    sessionId,
    fileVersion,
    projection,
    scannedAt = Date.now(),
  }: {
    sessionId: string;
    fileVersion: string;
    projection: TerminalTurnProjection;
    scannedAt?: number;
  }): { ingested: number; updated: number; deactivated: number } {
    if (!sessionId || !fileVersion) throw new Error("Invalid Turn Memory scan");
    return this.database.transaction(() => {
      for (const source of projection.sources) {
        if (source.sessionId !== sessionId || source.threadId !== sessionId) {
          throw new Error("Turn Memory source does not match scanned Session");
        }
      }
      const deactivated = projection.cursorRewound
        ? this.reconcileBranch(
            sessionId,
            projection.sources.map(({ sourceId }) => sourceId),
            scannedAt,
          )
        : 0;
      let ingested = 0;
      let updated = 0;
      for (const source of projection.sources) {
        const result = this.upsertSource(source, scannedAt);
        if (result === "ingested") ingested += 1;
        if (result === "updated") updated += 1;
      }
      this.cursors.recordSuccess({
        sessionId,
        fileVersion,
        lastTerminalEntryId: projection.nextEntryId,
        scannedAt,
      });
      return { ingested, updated, deactivated };
    });
  }

  sealDueBatches(now = Date.now()): string[] {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(`
        SELECT * FROM turn_memory_batches
        WHERE status = 'open' AND eligible_at <= ?
        ORDER BY eligible_at, id
      `).all(now) as DatabaseRow[];
      for (const row of rows) {
        const hardCapAt = integer(row.first_pending_at, "Turn Memory batch start") +
          this.policy.hardCapMilliseconds;
        const reason = integer(row.eligible_at, "Turn Memory batch eligibility") ===
            hardCapAt
          ? "hard_cap"
          : "idle";
        this.sealBatch(
          row,
          reason,
          integer(row.eligible_at, "Turn Memory batch eligibility"),
          now,
        );
      }
      return rows.map((row) => String(row.id));
    });
  }

  recordScanFailure({
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
    this.cursors.recordFailure({ sessionId, fileVersion, error, scannedAt });
  }

  loadScanCursor(sessionId: string) {
    return this.cursors.load(sessionId);
  }

  shouldScan(sessionId: string, fileVersion: string): boolean {
    return this.cursors.shouldScan(sessionId, fileVersion);
  }

  reconcileSessions(
    activeSessionIds: readonly string[],
    reconciledAt = Date.now(),
  ): number {
    const active = new Set(activeSessionIds);
    return this.database.transaction(() => {
      const sessions = (this.database.connection.prepare(`
        SELECT session_id FROM turn_memory_session_scans
      `).all() as DatabaseRow[])
        .map((row) => String(row.session_id))
        .filter((sessionId) => !active.has(sessionId));
      let deactivated = 0;
      let rawMemoriesChanged = false;
      for (const sessionId of sessions) {
        const sourceIds = (this.database.connection.prepare(`
          SELECT id FROM turn_memory_sources
          WHERE session_id = ? AND active = 1
        `).all(sessionId) as DatabaseRow[]).map((row) => String(row.id));
        if (sourceIds.length > 0) {
          this.database.connection.prepare(`
            UPDATE turn_memory_sources SET
              active = 0, source_generation = source_generation + 1,
              updated_at = ?
            WHERE session_id = ? AND active = 1
          `).run(reconciledAt, sessionId);
          rawMemoriesChanged = deactivateMemorySourcesByEvidenceInTransaction(
            this.database,
            sourceIds,
            this.policy.worker.maxAttempts,
          ) > 0 || rawMemoriesChanged;
          deactivated += sourceIds.length;
        }
        this.database.connection.prepare(`
          UPDATE turn_memory_session_scans SET
            file_version = 'missing', status = 'invalid',
            last_error = 'Pi Session no longer exists', scanned_at = ?
          WHERE session_id = ?
        `).run(reconciledAt, sessionId);
      }
      if (rawMemoriesChanged) {
        this.refreshRawMemories(reconciledAt, reconciledAt);
      }
      return deactivated;
    });
  }

  claimNext({
    workerId,
    now = Date.now(),
  }: {
    workerId: string;
    now?: number;
  }): TurnMemoryClaim | null {
    if (!workerId) throw new Error("Turn Memory worker ID is required");
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE memory_jobs SET
          status = CASE WHEN retry_remaining > 1 THEN 'pending' ELSE 'error' END,
          worker_id = NULL,
          ownership_token = NULL,
          lease_until = NULL,
          retry_at = ?,
          retry_remaining = max(retry_remaining - 1, 0),
          last_error = 'worker lease expired',
          abandonment_count = abandonment_count + 1
        WHERE kind = ? AND status = 'running' AND lease_until <= ?
      `).run(now, JOB_KIND, now);
      const row = this.database.connection.prepare(`
        SELECT job_key, source_id, source_generation
        FROM memory_jobs
        WHERE kind = ? AND eligible_at <= ? AND retry_remaining > 0
          AND (
            status = 'pending' OR
            (status = 'error' AND retry_at IS NOT NULL AND retry_at <= ?)
          )
        ORDER BY eligible_at, job_key
        LIMIT 1
      `).get(JOB_KIND, now, now) as DatabaseRow | undefined;
      if (row === undefined) return null;
      const ownershipToken = randomUUID();
      const result = this.database.connection.prepare(`
        UPDATE memory_jobs SET
          status = 'running', worker_id = ?, ownership_token = ?,
          started_at = ?, finished_at = NULL, lease_until = ?, retry_at = NULL,
          attempt_count = attempt_count + 1, last_error = NULL
        WHERE job_key = ? AND source_generation = ?
          AND status IN ('pending', 'error')
      `).run(
        workerId,
        ownershipToken,
        now,
        now + this.policy.worker.leaseMilliseconds,
        String(row.job_key),
        integer(row.source_generation, "Turn Memory job generation"),
      );
      if (Number(result.changes) !== 1) return null;
      return {
        jobKey: String(row.job_key),
        sourceId: String(row.source_id),
        sourceGeneration: integer(
          row.source_generation,
          "Turn Memory job generation",
        ),
        workerId,
        ownershipToken,
      };
    });
  }

  heartbeat(claim: TurnMemoryClaim, now = Date.now()): boolean {
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

  fail(
    claim: TurnMemoryClaim,
    error: string,
    failedAt = Date.now(),
  ): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_jobs SET
        status = 'error', finished_at = ?, lease_until = NULL,
        retry_at = ?, retry_remaining = max(retry_remaining - 1, 0),
        last_error = ?, worker_id = NULL, ownership_token = NULL
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

  loadClaimProjection(claim: TurnMemoryClaim): TurnMemoryBatchProjection {
    this.owned(claim);
    const sources = this.batchSources(claim.sourceId);
    if (sources.length === 0) throw new Error("Turn Memory batch has no active sources");
    return projectTurnMemoryBatch(sources);
  }

  private upsertArtifact(
    artifact: RenderedMemoryArtifact,
    sourceUpdatedAt: number,
    generatedAt: number,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO memory_artifacts (
        artifact_key, kind, relative_path, content, content_hash,
        source_updated_at, generated_at, projected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (artifact_key) DO UPDATE SET
        kind = excluded.kind,
        relative_path = excluded.relative_path,
        content = excluded.content,
        content_hash = excluded.content_hash,
        source_updated_at = excluded.source_updated_at,
        generated_at = excluded.generated_at,
        projected_at = CASE
          WHEN memory_artifacts.content_hash = excluded.content_hash
          THEN memory_artifacts.projected_at
          ELSE NULL
        END
    `).run(
      artifact.artifactKey,
      artifact.kind,
      artifact.relativePath,
      artifact.content,
      artifact.contentHash,
      sourceUpdatedAt,
      generatedAt,
    );
  }

  private refreshRawMemories(
    sourceUpdatedAt: number,
    generatedAt: number,
  ): void {
    const rawRows = this.database.connection.prepare(`
      SELECT e.job_key, e.raw_memory, e.turn_summary, e.tasks_json,
             a.relative_path
      FROM turn_memory_extractions e
      JOIN memory_sources s
        ON s.source_key = e.job_key AND s.kind = 'turn_memory' AND s.active = 1
      JOIN memory_artifacts a
        ON a.artifact_key = 'turn-rollout:' || e.job_key
      ORDER BY e.generated_at, e.job_key
    `).all() as DatabaseRow[];
    const raw = renderRawMemories(rawRows.map((row) => ({
      jobKey: String(row.job_key),
      rolloutSummaryFile: String(row.relative_path),
      rawMemory: String(row.raw_memory),
      turnSummary: String(row.turn_summary),
      tasks: JSON.parse(String(row.tasks_json)) as TurnMemoryExtraction["tasks"],
    })));
    this.upsertArtifact(raw, sourceUpdatedAt, generatedAt);
  }

  complete(
    claim: TurnMemoryClaim,
    input: TurnMemoryBatchProjection,
    extraction: TurnMemoryExtraction,
    completedAt = Date.now(),
  ): { sourceUpdatedAt: number } {
    return this.database.transaction(() => {
      this.owned(claim);
      const loaded = this.loadClaimProjection(claim);
      if (JSON.stringify(loaded.sourceIds) !== JSON.stringify(input.sourceIds)) {
        throw new Error("Turn Memory source set changed during extraction");
      }
      const sourceUpdatedAt = integer(this.database.connection.prepare(`
        SELECT coalesce(max(source_updated_at), 0) + 1 AS watermark
        FROM turn_memory_extractions
      `).get()?.watermark, "Turn Memory source watermark");
      this.database.connection.prepare(`
        INSERT INTO turn_memory_extractions (
          job_key, source_generation, source_updated_at,
          raw_memory, turn_summary, turn_slug, tasks_json, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET
          source_generation = excluded.source_generation,
          source_updated_at = excluded.source_updated_at,
          raw_memory = excluded.raw_memory,
          turn_summary = excluded.turn_summary,
          turn_slug = excluded.turn_slug,
          tasks_json = excluded.tasks_json,
          generated_at = excluded.generated_at
      `).run(
        claim.jobKey,
        claim.sourceGeneration,
        sourceUpdatedAt,
        extraction.rawMemory,
        extraction.turnSummary,
        extraction.turnSlug,
        JSON.stringify(extraction.tasks),
        completedAt,
      );
      this.database.connection.prepare(`
        DELETE FROM turn_memory_extraction_sources WHERE job_key = ?
      `).run(claim.jobKey);
      const insertSource = this.database.connection.prepare(`
        INSERT INTO turn_memory_extraction_sources (job_key, source_id)
        VALUES (?, ?)
      `);
      for (const sourceId of input.sourceIds) {
        insertSource.run(claim.jobKey, sourceId);
      }
      const rollout = renderTurnMemoryRollout({
        jobKey: claim.jobKey,
        input,
        extraction,
        generatedAt: completedAt,
      });
      this.upsertArtifact(rollout, sourceUpdatedAt, completedAt);
      recordMemorySourceInTransaction(this.database, {
        sourceKey: claim.jobKey,
        kind: "turn_memory",
        sourceId: claim.sourceId,
        sourceGeneration: claim.sourceGeneration,
        sourceSummary: extraction.turnSummary,
        rawMemory: extraction.rawMemory || null,
        artifactPath: rollout.relativePath,
        contentHash: rollout.contentHash,
        startedAt: Date.parse(input.startedAt),
        endedAt: Date.parse(input.finishedAt),
        provenance: "user_turn",
        supportsSuccess: extraction.tasks.some(({ outcome }) => outcome === "success"),
        sourceIds: input.sourceIds,
        generatedAt: completedAt,
      }, this.policy.worker.maxAttempts);
      this.refreshRawMemories(sourceUpdatedAt, completedAt);
      const completed = this.database.connection.prepare(`
        UPDATE memory_jobs SET
          status = 'succeeded', finished_at = ?, lease_until = NULL,
          retry_at = NULL, last_error = NULL,
          worker_id = NULL, ownership_token = NULL
        WHERE job_key = ? AND source_generation = ? AND status = 'running'
          AND worker_id = ? AND ownership_token = ?
      `).run(
        completedAt,
        claim.jobKey,
        claim.sourceGeneration,
        claim.workerId,
        claim.ownershipToken,
      );
      if (Number(completed.changes) !== 1) {
        throw new Error("Turn Memory ownership lost");
      }
      return { sourceUpdatedAt };
    });
  }

  pendingArtifacts(): PendingMemoryArtifact[] {
    return (this.database.connection.prepare(`
      SELECT artifact_key, relative_path, content, content_hash
      FROM memory_artifacts
      WHERE projected_at IS NULL
      ORDER BY CASE kind WHEN 'turn_rollout' THEN 0 ELSE 1 END,
               relative_path
    `).all() as DatabaseRow[]).map((row) => ({
      artifactKey: String(row.artifact_key),
      relativePath: String(row.relative_path),
      content: String(row.content),
      contentHash: String(row.content_hash),
    }));
  }

  markArtifactProjected(
    artifactKey: string,
    contentHash: string,
    projectedAt = Date.now(),
  ): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_artifacts SET projected_at = ?
      WHERE artifact_key = ? AND content_hash = ? AND projected_at IS NULL
    `).run(projectedAt, artifactKey, contentHash);
    return Number(result.changes) === 1;
  }
}
