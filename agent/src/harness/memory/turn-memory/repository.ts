import {
  finishModelAttempt,
  startModelAttempt,
  type FinishModelAttempt,
  type StartModelAttempt,
} from "../db/attempts.js";
import {
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import { ProducerJobs, type ProducerJobClaim } from "../shared/producer-jobs.js";
import { wakeGlobalConsolidation } from "../shared/consolidation-job.js";
import type { MemoryPipelineConfig } from "../types.js";
import { turnMemoryBatchEligibility } from "./batch-scheduler.js";
import { projectTurnMemoryBatch } from "./model-projection.js";
import type { TurnMemoryExtraction, TurnMemorySource } from "./types.js";

const JOB_KIND = "turn_memory_extraction" as const;

function milliseconds(value: string, name: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function jobKey(batchId: string) {
  return `turn-memory:${batchId}`;
}

export type TurnMemoryClaim = ProducerJobClaim & { kind: typeof JOB_KIND };

export class TurnMemoryRepository {
  private readonly jobs: ProducerJobs;

  constructor(
    private readonly database: MemoryDatabase,
    readonly config: MemoryPipelineConfig,
  ) {
    this.jobs = new ProducerJobs(database, config);
  }

  private queue(batchId: string, sourceGeneration: number, eligibleAt: number) {
    this.jobs.queue({
      jobKey: jobKey(batchId),
      kind: JOB_KIND,
      sourceId: batchId,
      sourceGeneration,
      eligibleAt,
    });
  }

  private sealDueInTransaction(now: number, sessionId?: string) {
    const rows = this.database.connection.prepare(`
      SELECT id, first_pending_at, last_terminal_at, eligible_at, source_generation
      FROM turn_memory_batches
      WHERE status = 'open' AND eligible_at <= ?
        AND (? IS NULL OR session_id = ?)
      ORDER BY eligible_at, id
    `).all(now, sessionId ?? null, sessionId ?? null) as DatabaseRow[];
    for (const row of rows) {
      const firstPendingAt = integer(row.first_pending_at, "Turn Memory batch start");
      const lastTerminalAt = integer(
        row.last_terminal_at,
        "Turn Memory batch terminal time",
      );
      const reason = lastTerminalAt + this.config.turnMemory.turnIdleMilliseconds <=
          firstPendingAt + this.config.turnMemory.turnHardCapMilliseconds
        ? "idle"
        : "hard_cap";
      this.database.connection.prepare(`
        UPDATE turn_memory_batches
        SET status = 'sealed', close_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'open'
      `).run(reason, now, String(row.id));
      this.queue(
        String(row.id),
        integer(row.source_generation, "Turn Memory batch generation"),
        integer(row.eligible_at, "Turn Memory batch eligibility"),
      );
    }
    return rows.map((row) => String(row.id));
  }

  sealDueBatches(now = Date.now()) {
    return this.database.transaction(() => this.sealDueInTransaction(now));
  }

  previewBatch(sessionId: string, source: TurnMemorySource, maxInputTokens: number) {
    if (!sessionId) throw new Error("Turn Memory source requires a Session ID");
    if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
      throw new Error("Invalid Turn Memory batch token budget");
    }
    const occurredAt = milliseconds(source.occurredAt, "Turn timestamp");
    const turn = projectTurnMemoryBatch(sessionId, [source]).turns[0]!;
    return this.database.transaction(() => {
      this.sealDueInTransaction(occurredAt, sessionId);
      const duplicate = this.database.connection.prepare(`
        SELECT 1 AS duplicate FROM turn_memory_batch_sources WHERE source_id = ?
      `).get(source.sourceId);
      if (duplicate) return null;
      const open = this.database.connection.prepare(`
        SELECT id, first_pending_at, last_terminal_at, projected_input_tokens,
               max_input_tokens, source_generation
        FROM turn_memory_batches WHERE session_id = ? AND status = 'open'
      `).get(sessionId) as DatabaseRow | undefined;
      if (open && integer(open.max_input_tokens, "Turn Memory token limit") !==
          maxInputTokens) {
        const eligibility = turnMemoryBatchEligibility({
          firstPendingAt: integer(open.first_pending_at, "Turn Memory batch start"),
          lastTerminalAt: integer(open.last_terminal_at, "Turn Memory terminal time"),
          projectedInputTokens: integer(
            open.projected_input_tokens,
            "Turn Memory projected tokens",
          ),
          maxInputTokens,
          idleMilliseconds: this.config.turnMemory.turnIdleMilliseconds,
          hardCapMilliseconds: this.config.turnMemory.turnHardCapMilliseconds,
        });
        if (eligibility.reason === "budget") {
          this.database.connection.prepare(`
            UPDATE turn_memory_batches SET
              status = 'sealed', close_reason = 'recovery', updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(occurredAt, String(open.id));
          this.queue(
            String(open.id),
            integer(open.source_generation, "Turn Memory generation"),
            occurredAt,
          );
        } else {
          this.database.connection.prepare(`
            UPDATE turn_memory_batches SET
              max_input_tokens = ?, eligible_at = ?, updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(maxInputTokens, eligibility.eligibleAt, occurredAt, String(open.id));
        }
      }
      const rows = this.database.connection.prepare(`
        SELECT s.projection_json
        FROM turn_memory_batches b
        JOIN turn_memory_batch_sources bs ON bs.batch_id = b.id
        JOIN turn_memory_sources s ON s.id = bs.source_id
        WHERE b.session_id = ? AND b.status = 'open'
        ORDER BY bs.ordinal
      `).all(sessionId) as DatabaseRow[];
      return {
        type: "turn_memory_batch" as const,
        sessionId,
        turns: [
          ...rows.map((row) => JSON.parse(String(row.projection_json)) as typeof turn),
          turn,
        ],
      };
    });
  }

  ingestTurn({
    sessionId,
    source,
    projectedInputTokens,
    maxInputTokens,
    ingestedAt = Date.now(),
  }: {
    sessionId: string;
    source: TurnMemorySource;
    projectedInputTokens: number;
    maxInputTokens: number;
    ingestedAt?: number;
  }) {
    if (!sessionId) throw new Error("Turn Memory source requires a Session ID");
    if (!Number.isSafeInteger(projectedInputTokens) || projectedInputTokens < 0) {
      throw new Error("Invalid projected Turn Memory tokens");
    }
    const occurredAt = milliseconds(source.occurredAt, "Turn timestamp");
    const projection = projectTurnMemoryBatch(sessionId, [source]).turns[0]!;
    return this.database.transaction(() => {
      const duplicate = this.database.connection.prepare(`
        SELECT b.id, b.status, b.close_reason, b.eligible_at, b.source_generation
        FROM turn_memory_batches b
        JOIN turn_memory_batch_sources bs ON bs.batch_id = b.id
        WHERE bs.source_id = ?
      `).get(source.sourceId) as DatabaseRow | undefined;
      if (duplicate) return {
        duplicate: true,
        accepted: true,
        batchId: String(duplicate.id),
        status: String(duplicate.status) as "open" | "sealed",
        closeReason: duplicate.close_reason === null
          ? undefined
          : String(duplicate.close_reason) as "idle" | "hard_cap" | "budget" | "recovery",
        eligibleAt: integer(duplicate.eligible_at, "Turn Memory eligibility"),
        sourceGeneration: integer(duplicate.source_generation, "Turn Memory generation"),
      };

      this.sealDueInTransaction(occurredAt, sessionId);
      let batch = this.database.connection.prepare(`
        SELECT * FROM turn_memory_batches WHERE session_id = ? AND status = 'open'
      `).get(sessionId) as DatabaseRow | undefined;
      if (batch && projectedInputTokens > maxInputTokens) {
        const batchId = String(batch.id);
        const generation = integer(batch.source_generation, "Turn Memory generation");
        this.database.connection.prepare(`
          UPDATE turn_memory_batches SET
            status = 'sealed', close_reason = 'budget', eligible_at = ?, updated_at = ?
          WHERE id = ? AND status = 'open'
        `).run(occurredAt, ingestedAt, batchId);
        this.queue(batchId, generation, occurredAt);
        return {
          duplicate: false,
          accepted: false,
          batchId,
          status: "sealed" as const,
          closeReason: "budget" as const,
          eligibleAt: occurredAt,
          sourceGeneration: generation,
        };
      }

      this.database.connection.prepare(`
        INSERT INTO turn_memory_sources (
          id, source_key, session_id, turn_id, occurred_at,
          projection_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        source.sourceId,
        source.sourceId,
        sessionId,
        source.turn.id,
        occurredAt,
        JSON.stringify(projection),
        ingestedAt,
      );
      if (!batch) {
        const batchId = `turn-memory-batch:${sessionId}:${source.turn.id}`;
        this.database.connection.prepare(`
          INSERT INTO turn_memory_batches (
            id, session_id, first_pending_at, last_terminal_at, eligible_at,
            status, projected_input_tokens, max_input_tokens, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)
        `).run(
          batchId,
          sessionId,
          occurredAt,
          occurredAt,
          occurredAt + this.config.turnMemory.turnIdleMilliseconds,
          maxInputTokens,
          ingestedAt,
          ingestedAt,
        );
        batch = this.database.connection.prepare(
          "SELECT * FROM turn_memory_batches WHERE id = ?",
        ).get(batchId) as DatabaseRow;
      }
      const batchId = String(batch.id);
      const ordinal = integer(this.database.connection.prepare(`
        SELECT count(*) AS count FROM turn_memory_batch_sources WHERE batch_id = ?
      `).get(batchId)?.count, "Turn Memory source ordinal");
      this.database.connection.prepare(`
        INSERT INTO turn_memory_batch_sources (batch_id, source_id, ordinal)
        VALUES (?, ?, ?)
      `).run(batchId, source.sourceId, ordinal);
      const eligibility = turnMemoryBatchEligibility({
        firstPendingAt: integer(batch.first_pending_at, "Turn Memory batch start"),
        lastTerminalAt: occurredAt,
        projectedInputTokens,
        maxInputTokens,
        idleMilliseconds: this.config.turnMemory.turnIdleMilliseconds,
        hardCapMilliseconds: this.config.turnMemory.turnHardCapMilliseconds,
      });
      const sealed = eligibility.reason === "budget";
      this.database.connection.prepare(`
        UPDATE turn_memory_batches SET
          last_terminal_at = ?, eligible_at = ?, status = ?, close_reason = ?,
          projected_input_tokens = ?, source_generation = source_generation + 1,
          updated_at = ?
        WHERE id = ?
      `).run(
        occurredAt,
        eligibility.eligibleAt,
        sealed ? "sealed" : "open",
        sealed ? "budget" : null,
        projectedInputTokens,
        ingestedAt,
        batchId,
      );
      const updated = this.database.connection.prepare(`
        SELECT status, close_reason, eligible_at, source_generation
        FROM turn_memory_batches WHERE id = ?
      `).get(batchId) as DatabaseRow;
      const generation = integer(updated.source_generation, "Turn Memory generation");
      if (sealed) this.queue(batchId, generation, eligibility.eligibleAt);
      return {
        duplicate: false,
        accepted: true,
        batchId,
        status: String(updated.status) as "open" | "sealed",
        closeReason: updated.close_reason === null
          ? undefined
          : String(updated.close_reason) as "budget",
        eligibleAt: integer(updated.eligible_at, "Turn Memory eligibility"),
        sourceGeneration: generation,
      };
    });
  }

  claimNext(options: { workerId: string; now?: number }) {
    return this.jobs.claimNext(JOB_KIND, options) as TurnMemoryClaim | null;
  }

  heartbeat(claim: TurnMemoryClaim, now: number) {
    return this.jobs.heartbeat(claim, now);
  }

  fail(claim: TurnMemoryClaim, error: string, failedAt = Date.now()) {
    return this.jobs.fail(claim, error, failedAt);
  }

  loadClaimSources(claim: TurnMemoryClaim) {
    this.jobs.owned(claim, -1);
    const batch = this.database.connection.prepare(`
      SELECT session_id FROM turn_memory_batches WHERE id = ?
    `).get(claim.sourceId) as DatabaseRow | undefined;
    if (!batch) throw new Error("Turn Memory batch is missing");
    const turns = (this.database.connection.prepare(`
      SELECT s.projection_json
      FROM turn_memory_batch_sources bs
      JOIN turn_memory_sources s ON s.id = bs.source_id
      WHERE bs.batch_id = ?
      ORDER BY s.occurred_at, s.id
    `).all(claim.sourceId) as DatabaseRow[]).map((row) =>
      JSON.parse(String(row.projection_json)) as
        ReturnType<typeof projectTurnMemoryBatch>["turns"][number]);
    return {
      type: "turn_memory_batch" as const,
      sessionId: String(batch.session_id),
      turns,
    };
  }

  complete(
    claim: TurnMemoryClaim,
    output: TurnMemoryExtraction,
    completedAt = Date.now(),
  ) {
    return this.database.transaction(() => {
      this.jobs.owned(claim, completedAt);
      const rows = this.database.connection.prepare(`
        SELECT s.id
        FROM turn_memory_batch_sources bs
        JOIN turn_memory_sources s ON s.id = bs.source_id
        WHERE bs.batch_id = ? ORDER BY s.occurred_at, s.id
      `).all(claim.sourceId) as DatabaseRow[];
      if (rows.length === 0) throw new Error("Turn Memory batch has no sources");
      const watermark = integer(this.database.connection.prepare(`
        SELECT coalesce(max(source_updated_at), 0) + 1 AS watermark
        FROM (
          SELECT source_updated_at FROM chronicle_summaries
          UNION ALL
          SELECT source_updated_at FROM turn_memory_extractions
        )
      `).get()?.watermark, "memory source watermark");
      this.database.connection.prepare(`
        INSERT INTO turn_memory_extractions (
          job_key, source_generation, source_updated_at,
          raw_memory, turn_summary, turn_slug, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET
          source_generation = excluded.source_generation,
          source_updated_at = excluded.source_updated_at,
          raw_memory = excluded.raw_memory,
          turn_summary = excluded.turn_summary,
          turn_slug = excluded.turn_slug,
          generated_at = excluded.generated_at
      `).run(
        claim.jobKey,
        claim.sourceGeneration,
        watermark,
        output.rawMemory,
        output.turnSummary,
        output.turnSlug,
        completedAt,
      );
      this.database.connection.prepare(`
        DELETE FROM turn_memory_extraction_sources WHERE job_key = ?
      `).run(claim.jobKey);
      const insert = this.database.connection.prepare(`
        INSERT INTO turn_memory_extraction_sources (job_key, source_id)
        VALUES (?, ?)
      `);
      for (const row of rows) insert.run(claim.jobKey, String(row.id));
      wakeGlobalConsolidation(this.database.connection, this.config, watermark);
      if (!this.jobs.complete(claim, completedAt)) {
        throw new Error("Turn Memory extraction ownership lost");
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
