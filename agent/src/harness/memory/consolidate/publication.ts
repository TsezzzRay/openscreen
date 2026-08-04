import {
  changed,
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import type { MemoryPipelineConfig } from "../types.js";
import type { ConsolidationClaim } from "./repository.js";

const JOB_KEY = "global";

export type ConsolidationPublication = {
  ownershipToken: string;
  state: "prepared" | "publishing";
  stagingName: string;
  memorySha256: string;
  summarySha256: string;
  evidence: Record<string, string[]>;
  createdAt: number;
};

export class ConsolidationPublications {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly config: MemoryPipelineConfig,
  ) {}

  publication(): ConsolidationPublication | null {
    const row = this.database.connection.prepare(`
      SELECT ownership_token, state, staging_name, memory_sha256,
             summary_sha256, evidence_json, created_at
      FROM consolidation_publications WHERE job_key = ?
    `).get(JOB_KEY) as DatabaseRow | undefined;
    return row ? {
      ownershipToken: String(row.ownership_token),
      state: String(row.state) as ConsolidationPublication["state"],
      stagingName: String(row.staging_name),
      memorySha256: String(row.memory_sha256),
      summarySha256: String(row.summary_sha256),
      evidence: JSON.parse(String(row.evidence_json)) as Record<string, string[]>,
      createdAt: integer(row.created_at, "Consolidation publication time"),
    } : null;
  }

  private owns(claim: ConsolidationClaim, now: number) {
    return this.database.connection.prepare(`
      SELECT 1 AS owned FROM consolidation_jobs
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ? AND lease_until > ?
    `).get(JOB_KEY, claim.ownershipToken, now) !== undefined;
  }

  prepare(
    claim: ConsolidationClaim,
    publication: Omit<ConsolidationPublication, "ownershipToken" | "state">,
    now = Date.now(),
  ) {
    return this.database.transaction(() => {
      if (!this.owns(claim, now)) return false;
      this.database.connection.prepare(`
        INSERT INTO consolidation_publications (
          job_key, ownership_token, state, staging_name,
          memory_sha256, summary_sha256, evidence_json, created_at
        ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET
          ownership_token = excluded.ownership_token,
          state = excluded.state,
          staging_name = excluded.staging_name,
          memory_sha256 = excluded.memory_sha256,
          summary_sha256 = excluded.summary_sha256,
          evidence_json = excluded.evidence_json,
          created_at = excluded.created_at
      `).run(
        JOB_KEY,
        claim.ownershipToken,
        publication.stagingName,
        publication.memorySha256,
        publication.summarySha256,
        JSON.stringify(publication.evidence),
        publication.createdAt,
      );
      return true;
    });
  }

  begin(claim: ConsolidationClaim, now = Date.now()) {
    return this.database.transaction(() => {
      if (!this.owns(claim, now)) return false;
      return changed(this.database.connection.prepare(`
        UPDATE consolidation_publications SET state = 'publishing'
        WHERE job_key = ? AND ownership_token = ? AND state = 'prepared'
      `).run(JOB_KEY, claim.ownershipToken));
    });
  }

  clear(ownershipToken: string) {
    return changed(this.database.connection.prepare(`
      DELETE FROM consolidation_publications
      WHERE job_key = ? AND ownership_token = ?
    `).run(JOB_KEY, ownershipToken));
  }

  private ownsForTerminalWrite(claim: ConsolidationClaim, at: number) {
    return this.database.connection.prepare(`
      SELECT input_watermark FROM consolidation_jobs
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ? AND lease_until > ?
    `).get(JOB_KEY, claim.ownershipToken, at) as DatabaseRow | undefined;
  }

  private succeedInTransaction(
    claim: ConsolidationClaim,
    inputWatermark: number,
    finishedAt: number,
    evidence?: ReadonlyMap<string, readonly string[]>,
  ) {
    this.database.connection.prepare(`
      UPDATE activity_summaries SET
        selected_for_consolidation = 1,
        selected_for_consolidation_source_updated_at = source_updated_at
      WHERE EXISTS (
        SELECT 1 FROM consolidation_inputs snapshot
        WHERE snapshot.ownership_token = ?
          AND snapshot.job_key = activity_summaries.job_key
          AND snapshot.source_updated_at = activity_summaries.source_updated_at
      )
    `).run(claim.ownershipToken);
    if (evidence) {
      this.database.connection.prepare("DELETE FROM memory_evidence").run();
      const insert = this.database.connection.prepare(`
        INSERT INTO memory_evidence (memory_key, activity_job_key, source_id)
        VALUES (?, ?, ?)
      `);
      for (const [memoryKey, activityJobKeys] of evidence) {
        for (const activityJobKey of activityJobKeys) {
          const snapshot = this.database.connection.prepare(`
            SELECT source_ids_json FROM consolidation_inputs
            WHERE ownership_token = ? AND job_key = ?
          `).get(claim.ownershipToken, activityJobKey) as DatabaseRow | undefined;
          if (!snapshot) {
            throw new Error(`Missing Consolidation snapshot ${activityJobKey}`);
          }
          for (const sourceId of JSON.parse(
            String(snapshot.source_ids_json),
          ) as string[]) {
            insert.run(memoryKey, activityJobKey, sourceId);
          }
        }
      }
    }
    this.database.connection.prepare(`
      DELETE FROM consolidation_publications
      WHERE job_key = ? AND ownership_token = ?
    `).run(JOB_KEY, claim.ownershipToken);
    const succeeded = changed(this.database.connection.prepare(`
      UPDATE consolidation_jobs SET
        status = ?, worker_id = NULL, ownership_token = NULL,
        finished_at = ?, lease_until = NULL, retry_at = NULL,
        retry_remaining = ?, abandonment_count = 0, last_error = NULL,
        last_success_watermark = ?
      WHERE job_key = ? AND status = 'running'
        AND ownership_token = ?
    `).run(
      inputWatermark > claim.inputWatermark ? "pending" : "done",
      finishedAt,
      this.config.worker.maxAttempts,
      claim.inputWatermark,
      JOB_KEY,
      claim.ownershipToken,
    ));
    if (succeeded) {
      this.database.connection.prepare(`
        DELETE FROM consolidation_inputs WHERE ownership_token = ?
      `).run(claim.ownershipToken);
    }
    return succeeded;
  }

  succeed(
    claim: ConsolidationClaim,
    finishedAt = Date.now(),
    evidence?: ReadonlyMap<string, readonly string[]>,
  ) {
    return this.database.transaction(() => {
      const row = this.ownsForTerminalWrite(claim, finishedAt);
      if (!row) return false;
      return this.succeedInTransaction(
        claim,
        integer(row.input_watermark, "Consolidation input watermark"),
        finishedAt,
        evidence,
      );
    });
  }

  finalize(
    claim: ConsolidationClaim,
    finishedAt: number,
    evidence: ReadonlyMap<string, readonly string[]>,
    publish: () => void,
  ) {
    return this.database.transaction(() => {
      const row = this.ownsForTerminalWrite(claim, finishedAt);
      if (!row) return false;
      const publication = this.database.connection.prepare(`
        SELECT 1 AS valid FROM consolidation_publications
        WHERE job_key = ? AND ownership_token = ? AND state = 'publishing'
      `).get(JOB_KEY, claim.ownershipToken);
      if (!publication) return false;
      publish();
      return this.succeedInTransaction(
        claim,
        integer(row.input_watermark, "Consolidation input watermark"),
        finishedAt,
        evidence,
      );
    });
  }
}
