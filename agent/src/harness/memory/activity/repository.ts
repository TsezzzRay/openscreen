import type {
  FinishModelAttempt,
  StartModelAttempt,
} from "../db/attempts.js";
import {
  changeCount as changes,
  integer as number,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import type { ObservationEvidence } from "../evidence.js";
import type { MemoryPipelineConfig } from "../types.js";
import type { ScreenObservation } from "../../../plugins/screen-observation/types.js";
import { ActivityJobs, type ClaimedActivityJob } from "./jobs.js";
import { ActivityOutputs } from "./outputs.js";
import { projectObservation, projectTurnBatch } from "./projection.js";
import { observationWindowFor, turnBatchEligibility } from "./scheduler.js";
import type { ActivitySource } from "./types.js";

export type { ClaimedActivityJob } from "./jobs.js";

function milliseconds(value: string, name: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function observationJobKey(windowId: string) {
  return `activity:${windowId}`;
}

function turnJobKey(batchId: string) {
  return `activity:${batchId}`;
}

export class ActivityRepository {
  private readonly jobs: ActivityJobs;
  private readonly outputs: ActivityOutputs;

  constructor(
    private readonly database: MemoryDatabase,
    readonly config: MemoryPipelineConfig,
  ) {
    this.jobs = new ActivityJobs(database, config);
    this.outputs = new ActivityOutputs(database, config);
  }

  private queueActivityJob(
    sourceKind: "observation_window" | "turn_batch",
    sourceId: string,
    sourceGeneration: number,
    eligibleAt: number,
  ) {
    const jobKey = sourceKind === "observation_window"
      ? observationJobKey(sourceId)
      : turnJobKey(sourceId);
    this.database.connection.prepare(`
      INSERT INTO activity_jobs (
        job_key, source_kind, source_id, source_generation, status,
        eligible_at, retry_remaining
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
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
        abandonment_count = 0,
        last_error = NULL
    `).run(
      jobKey,
      sourceKind,
      sourceId,
      sourceGeneration,
      eligibleAt,
      this.config.worker.maxAttempts,
    );
    return jobKey;
  }

  ingestObservation(
    observation: ScreenObservation,
    ingestedAt = Date.now(),
    evidence?: ObservationEvidence,
  ) {
    const projection = projectObservation(observation);
    const occurredAt = milliseconds(observation.occurredAt, "Observation timestamp");
    const capturedAt = milliseconds(observation.capturedAt, "Observation capture timestamp");
    const window = observationWindowFor(occurredAt, {
      windowMilliseconds: this.config.activity.observationWindowMilliseconds,
      graceMilliseconds: this.config.activity.observationGraceMilliseconds,
    });
    return this.database.transaction(() => {
      const inserted = changes(this.database.connection.prepare(`
        INSERT INTO source_items (
          id, source_type, source_key, occurred_at, captured_at,
          projection_json, sidecar_path, sidecar_sha256, sidecar_delete_after,
          ingested_at
        ) VALUES (?, 'observation', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_key) DO NOTHING
      `).run(
        projection.sourceId,
        projection.sourceId,
        occurredAt,
        capturedAt,
        JSON.stringify(projection),
        evidence?.path ?? null,
        evidence?.sha256 ?? null,
        evidence
          ? ingestedAt + this.config.evidence.failedRetentionMilliseconds
          : null,
        ingestedAt,
      ));
      if (inserted === 0) {
        const existing = this.database.connection.prepare(`
          SELECT w.id, w.eligible_at, w.source_generation
          FROM observation_windows w
          JOIN observation_window_sources ws ON ws.window_id = w.id
          WHERE ws.source_id = ?
        `).get(projection.sourceId) as DatabaseRow | undefined;
        if (!existing) throw new Error("Observation source is missing its window");
        return {
          duplicate: true,
          sourceId: projection.sourceId,
          windowId: String(existing.id),
          eligibleAt: number(existing.eligible_at, "Observation eligibility"),
          sourceGeneration: number(existing.source_generation, "Observation generation"),
        };
      }

      this.database.connection.prepare(`
        INSERT INTO observation_windows (
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
      const storedWindow = this.database.connection.prepare(`
        SELECT id FROM observation_windows WHERE start_at = ? AND end_at = ?
      `).get(window.startAt, window.endAt) as DatabaseRow;
      const windowId = String(storedWindow.id);
      const ordinal = number(this.database.connection.prepare(`
        SELECT count(*) AS count FROM observation_window_sources WHERE window_id = ?
      `).get(windowId)?.count, "Observation ordinal");
      this.database.connection.prepare(`
        INSERT INTO observation_window_sources (window_id, source_id, ordinal)
        VALUES (?, ?, ?)
      `).run(windowId, projection.sourceId, ordinal);
      this.database.connection.prepare(`
        UPDATE observation_windows
        SET source_generation = source_generation + 1, updated_at = ?
        WHERE id = ?
      `).run(ingestedAt, windowId);
      const updated = this.database.connection.prepare(`
        SELECT source_generation, eligible_at FROM observation_windows WHERE id = ?
      `).get(windowId) as DatabaseRow;
      const sourceGeneration = number(
        updated.source_generation,
        "Observation generation",
      );
      const eligibleAt = number(updated.eligible_at, "Observation eligibility");
      this.queueActivityJob(
        "observation_window",
        windowId,
        sourceGeneration,
        eligibleAt,
      );
      return {
        duplicate: false,
        sourceId: projection.sourceId,
        windowId,
        eligibleAt,
        sourceGeneration,
      };
    });
  }

  private sealDueTurnBatchesInTransaction(now: number, sessionId?: string) {
    const rows = this.database.connection.prepare(`
      SELECT id, first_pending_at, last_terminal_at, eligible_at, source_generation
      FROM turn_batches
      WHERE status = 'open' AND eligible_at <= ?
        AND (? IS NULL OR session_id = ?)
      ORDER BY eligible_at, id
    `).all(now, sessionId ?? null, sessionId ?? null) as DatabaseRow[];
    for (const row of rows) {
      const firstPendingAt = number(row.first_pending_at, "Turn batch start");
      const lastTerminalAt = number(row.last_terminal_at, "Turn batch terminal time");
      const reason = lastTerminalAt + this.config.activity.turnIdleMilliseconds <=
          firstPendingAt + this.config.activity.turnHardCapMilliseconds
        ? "idle"
        : "hard_cap";
      this.database.connection.prepare(`
        UPDATE turn_batches
        SET status = 'sealed', close_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'open'
      `).run(reason, now, String(row.id));
      this.queueActivityJob(
        "turn_batch",
        String(row.id),
        number(row.source_generation, "Turn batch generation"),
        number(row.eligible_at, "Turn batch eligibility"),
      );
    }
    return rows.map((row) => String(row.id));
  }

  sealDueTurnBatches(now = Date.now()) {
    return this.database.transaction(() =>
      this.sealDueTurnBatchesInTransaction(now));
  }

  previewTurnBatch(
    sessionId: string,
    source: ActivitySource,
    maxInputTokens: number,
  ) {
    if (!sessionId) throw new Error("Turn source requires a Session ID");
    if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
      throw new Error("Invalid Turn batch token budget");
    }
    const occurredAt = milliseconds(source.occurredAt, "Turn timestamp");
    const turn = projectTurnBatch(sessionId, [source]).turns[0]!;
    return this.database.transaction(() => {
      this.sealDueTurnBatchesInTransaction(occurredAt, sessionId);
      const duplicate = this.database.connection.prepare(`
        SELECT 1 AS duplicate FROM turn_batch_sources WHERE source_id = ?
      `).get(source.sourceId);
      if (duplicate) return null;
      const openBatch = this.database.connection.prepare(`
        SELECT id, first_pending_at, last_terminal_at, projected_input_tokens,
               max_input_tokens, source_generation
        FROM turn_batches WHERE session_id = ? AND status = 'open'
      `).get(sessionId) as DatabaseRow | undefined;
      if (openBatch &&
          number(openBatch.max_input_tokens, "Turn batch token limit") !==
            maxInputTokens) {
        const recalculated = turnBatchEligibility({
          firstPendingAt: number(openBatch.first_pending_at, "Turn batch start"),
          lastTerminalAt: number(openBatch.last_terminal_at, "Turn batch terminal time"),
          projectedInputTokens: number(
            openBatch.projected_input_tokens,
            "Turn batch projected tokens",
          ),
          maxInputTokens,
          idleMilliseconds: this.config.activity.turnIdleMilliseconds,
          hardCapMilliseconds: this.config.activity.turnHardCapMilliseconds,
        });
        if (recalculated.reason === "budget") {
          this.database.connection.prepare(`
            UPDATE turn_batches SET
              status = 'sealed', close_reason = 'recovery', updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(occurredAt, String(openBatch.id));
          this.queueActivityJob(
            "turn_batch",
            String(openBatch.id),
            number(openBatch.source_generation, "Turn batch generation"),
            occurredAt,
          );
        } else {
          this.database.connection.prepare(`
            UPDATE turn_batches SET
              max_input_tokens = ?, eligible_at = ?, updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(
            maxInputTokens,
            recalculated.eligibleAt,
            occurredAt,
            String(openBatch.id),
          );
        }
      }
      const rows = this.database.connection.prepare(`
        SELECT s.projection_json
        FROM turn_batches b
        JOIN turn_batch_sources bs ON bs.batch_id = b.id
        JOIN source_items s ON s.id = bs.source_id
        WHERE b.session_id = ? AND b.status = 'open'
        ORDER BY bs.ordinal
      `).all(sessionId) as DatabaseRow[];
      return {
        type: "turn_batch" as const,
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
    source: ActivitySource;
    projectedInputTokens: number;
    maxInputTokens: number;
    ingestedAt?: number;
  }) {
    if (!sessionId) throw new Error("Turn source requires a Session ID");
    if (projectedInputTokens < 0 || !Number.isSafeInteger(projectedInputTokens)) {
      throw new Error("Invalid projected Turn tokens");
    }
    const occurredAt = milliseconds(source.occurredAt, "Turn timestamp");
    const turnProjection = projectTurnBatch(sessionId, [source]).turns[0]!;
    return this.database.transaction(() => {
      const duplicate = this.database.connection.prepare(`
        SELECT b.id, b.status, b.close_reason, b.eligible_at, b.source_generation
        FROM turn_batches b
        JOIN turn_batch_sources bs ON bs.batch_id = b.id
        WHERE bs.source_id = ?
      `).get(source.sourceId) as DatabaseRow | undefined;
      if (duplicate) {
        return {
          duplicate: true,
          accepted: true,
          batchId: String(duplicate.id),
          status: String(duplicate.status) as "open" | "sealed",
          closeReason: duplicate.close_reason === null
            ? undefined
            : String(duplicate.close_reason) as "idle" | "hard_cap" | "budget" | "recovery",
          eligibleAt: number(duplicate.eligible_at, "Turn batch eligibility"),
          sourceGeneration: number(duplicate.source_generation, "Turn batch generation"),
        };
      }

      // Batch boundaries follow the Turn timeline, not replay/ingestion time. This
      // lets startup replay reconstruct the same batches without sealing every
      // historical Turn merely because it is being ingested late.
      this.sealDueTurnBatchesInTransaction(occurredAt, sessionId);
      let batch = this.database.connection.prepare(`
        SELECT * FROM turn_batches WHERE session_id = ? AND status = 'open'
      `).get(sessionId) as DatabaseRow | undefined;
      if (batch &&
          number(batch.max_input_tokens, "Turn batch token limit") !== maxInputTokens) {
        const recalculated = turnBatchEligibility({
          firstPendingAt: number(batch.first_pending_at, "Turn batch start"),
          lastTerminalAt: number(batch.last_terminal_at, "Turn batch terminal time"),
          projectedInputTokens: number(
            batch.projected_input_tokens,
            "Turn batch projected tokens",
          ),
          maxInputTokens,
          idleMilliseconds: this.config.activity.turnIdleMilliseconds,
          hardCapMilliseconds: this.config.activity.turnHardCapMilliseconds,
        });
        if (recalculated.reason === "budget") {
          this.database.connection.prepare(`
            UPDATE turn_batches SET
              status = 'sealed', close_reason = 'recovery', updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(ingestedAt, String(batch.id));
          this.queueActivityJob(
            "turn_batch",
            String(batch.id),
            number(batch.source_generation, "Turn batch generation"),
            ingestedAt,
          );
          batch = undefined;
        } else {
          this.database.connection.prepare(`
            UPDATE turn_batches SET
              max_input_tokens = ?, eligible_at = ?, updated_at = ?
            WHERE id = ? AND status = 'open'
          `).run(
            maxInputTokens,
            recalculated.eligibleAt,
            ingestedAt,
            String(batch.id),
          );
          batch = this.database.connection.prepare(
            "SELECT * FROM turn_batches WHERE id = ?",
          ).get(String(batch.id)) as DatabaseRow;
        }
      }
      if (batch && projectedInputTokens > maxInputTokens) {
        const batchId = String(batch.id);
        const sourceGeneration = number(
          batch.source_generation,
          "Turn batch generation",
        );
        this.database.connection.prepare(`
          UPDATE turn_batches SET
            status = 'sealed', close_reason = 'budget', eligible_at = ?,
            updated_at = ?
          WHERE id = ? AND status = 'open'
        `).run(occurredAt, ingestedAt, batchId);
        this.queueActivityJob(
          "turn_batch",
          batchId,
          sourceGeneration,
          occurredAt,
        );
        return {
          duplicate: false,
          accepted: false,
          batchId,
          status: "sealed" as const,
          closeReason: "budget" as const,
          eligibleAt: occurredAt,
          sourceGeneration,
        };
      }

      this.database.connection.prepare(`
        INSERT INTO source_items (
          id, source_type, source_key, session_id, turn_id, occurred_at,
          projection_json, ingested_at
        ) VALUES (?, 'turn', ?, ?, ?, ?, ?, ?)
      `).run(
        source.sourceId,
        source.sourceId,
        sessionId,
        source.turn.id,
        occurredAt,
        JSON.stringify(turnProjection),
        ingestedAt,
      );

      if (!batch) {
        const batchId = `turn-batch:${sessionId}:${source.turn.id}`;
        this.database.connection.prepare(`
          INSERT INTO turn_batches (
            id, session_id, first_pending_at, last_terminal_at, eligible_at,
            status, projected_input_tokens, max_input_tokens,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)
        `).run(
          batchId,
          sessionId,
          occurredAt,
          occurredAt,
          occurredAt + this.config.activity.turnIdleMilliseconds,
          maxInputTokens,
          ingestedAt,
          ingestedAt,
        );
        batch = this.database.connection.prepare(
          "SELECT * FROM turn_batches WHERE id = ?",
        ).get(batchId) as DatabaseRow;
      }

      const batchId = String(batch.id);
      const ordinal = number(this.database.connection.prepare(`
        SELECT count(*) AS count FROM turn_batch_sources WHERE batch_id = ?
      `).get(batchId)?.count, "Turn ordinal");
      this.database.connection.prepare(`
        INSERT INTO turn_batch_sources (batch_id, source_id, ordinal)
        VALUES (?, ?, ?)
      `).run(batchId, source.sourceId, ordinal);
      const firstPendingAt = number(batch.first_pending_at, "Turn batch start");
      const totalTokens = number(
        projectedInputTokens,
        "Turn batch projected tokens",
      );
      const eligibility = turnBatchEligibility({
        firstPendingAt,
        lastTerminalAt: occurredAt,
        projectedInputTokens: totalTokens,
        maxInputTokens,
        idleMilliseconds: this.config.activity.turnIdleMilliseconds,
        hardCapMilliseconds: this.config.activity.turnHardCapMilliseconds,
      });
      const sealed = eligibility.reason === "budget";
      this.database.connection.prepare(`
        UPDATE turn_batches SET
          last_terminal_at = ?, eligible_at = ?,
          status = ?, close_reason = ?,
          projected_input_tokens = ?,
          source_generation = source_generation + 1,
          updated_at = ?
        WHERE id = ?
      `).run(
        occurredAt,
        eligibility.eligibleAt,
        sealed ? "sealed" : "open",
        sealed ? eligibility.reason : null,
        totalTokens,
        ingestedAt,
        batchId,
      );
      const updated = this.database.connection.prepare(`
        SELECT status, close_reason, eligible_at, source_generation
        FROM turn_batches WHERE id = ?
      `).get(batchId) as DatabaseRow;
      const sourceGeneration = number(
        updated.source_generation,
        "Turn batch generation",
      );
      if (sealed) {
        this.queueActivityJob(
          "turn_batch",
          batchId,
          sourceGeneration,
          eligibility.eligibleAt,
        );
      }
      return {
        duplicate: false,
        accepted: true,
        batchId,
        status: String(updated.status) as "open" | "sealed",
        closeReason: updated.close_reason === null
          ? undefined
          : String(updated.close_reason) as "idle" | "hard_cap" | "budget" | "recovery",
        eligibleAt: number(updated.eligible_at, "Turn batch eligibility"),
        sourceGeneration,
      };
    });
  }

  claimNext(options: Parameters<ActivityJobs["claimNext"]>[0]) {
    return this.jobs.claimNext(options);
  }

  heartbeat(...args: Parameters<ActivityJobs["heartbeat"]>) {
    return this.jobs.heartbeat(...args);
  }

  loadClaimSources(claim: ClaimedActivityJob) {
    return this.jobs.loadClaimSources(claim);
  }

  fail(...args: Parameters<ActivityJobs["fail"]>) {
    return this.jobs.fail(...args);
  }

  startModelAttempt(attempt: StartModelAttempt) {
    this.jobs.startModelAttempt(attempt);
  }

  finishModelAttempt(attempt: FinishModelAttempt) {
    this.jobs.finishModelAttempt(attempt);
  }

  complete(...args: Parameters<ActivityOutputs["complete"]>) {
    return this.outputs.complete(...args);
  }
}
