import { randomUUID } from "node:crypto";

import type { MemoryConfig } from "../config.js";
import { integer, type DatabaseRow, type MemoryDatabase } from "../database.js";
import type {
  MemorySourceKind,
  MemorySourceProvenance,
} from "./source-repository.js";

const JOB_KEY = "global";

export interface ConsolidationClaim {
  workerId: string;
  ownershipToken: string;
  frozenWatermark: number;
  processedWatermark: number;
  leaseUntil: number;
}

export interface ConsolidationInput {
  sourceKey: string;
  kind: MemorySourceKind;
  sourceId: string;
  sourceGeneration: number;
  sourceUpdatedAt: number;
  sourceSummary: string;
  rawMemory: string | null;
  artifactPath: string;
  contentHash: string;
  startedAt: number;
  endedAt: number;
  provenance: MemorySourceProvenance;
  supportsSuccess: boolean;
  sourceIds: string[];
  generatedAt: number;
  state: "added" | "retained" | "removed";
}

export interface ActiveEvidenceManifestItem {
  memoryKey: string;
  sourceKey: string;
  artifactPath: string;
  contentHash: string;
  provenance: MemorySourceProvenance;
}

export interface ConsolidationPublication {
  ownershipToken: string;
  state: "prepared" | "publishing";
  stagingName: string;
  expectedHead: string;
  memorySha256: string;
  summarySha256: string;
  evidence: Record<string, string[]>;
  frozenWatermark: number;
  processedWatermark: number;
  createdAt: number;
}

export type ConsolidationClaimResult =
  | { status: "claimed"; claim: ConsolidationClaim }
  | {
      status: "skipped";
      reason:
        | "up_to_date"
        | "running"
        | "retry"
        | "retry_exhausted"
        | "cooldown"
        | "recovery_required";
    };

function sourceFromRow(
  row: DatabaseRow,
  state: ConsolidationInput["state"],
  sourceUpdatedAt?: number,
): ConsolidationInput {
  const sourceIds: unknown = JSON.parse(String(row.source_ids_json));
  if (!Array.isArray(sourceIds) || !sourceIds.every((value) => typeof value === "string")) {
    throw new Error("Invalid consolidation source IDs");
  }
  return {
    sourceKey: String(row.source_key),
    kind: String(row.kind) as MemorySourceKind,
    sourceId: String(row.source_id),
    sourceGeneration: integer(row.source_generation, "Memory source generation"),
    sourceUpdatedAt: sourceUpdatedAt ?? integer(
      row.source_updated_at,
      "Memory source watermark",
    ),
    sourceSummary: String(row.source_summary),
    rawMemory: row.raw_memory === null ? null : String(row.raw_memory),
    artifactPath: String(row.artifact_path),
    contentHash: String(row.content_hash),
    startedAt: integer(row.started_at, "Memory source start"),
    endedAt: integer(row.ended_at, "Memory source end"),
    provenance: String(row.provenance) as MemorySourceProvenance,
    supportsSuccess: Number(row.supports_success) === 1,
    sourceIds,
    generatedAt: integer(row.generated_at, "Memory source generation time"),
    state,
  };
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

export class ConsolidationRepository {
  constructor(
    private readonly database: MemoryDatabase,
    readonly config: MemoryConfig,
  ) {}

  private snapshot(
    ownershipToken: string,
    frozenWatermark: number,
  ): { inputs: ConsolidationInput[]; processedWatermark: number } {
    const baselineRows = this.database.connection.prepare(`
      SELECT * FROM consolidation_source_baseline ORDER BY source_key
    `).all() as DatabaseRow[];
    const liveRows = this.database.connection.prepare(`
      SELECT * FROM memory_sources
      WHERE source_updated_at <= ?
      ORDER BY source_key
    `).all(frozenWatermark) as DatabaseRow[];
    const baseline = new Map(baselineRows.map((row) => [String(row.source_key), row]));
    const live = new Map(liveRows.map((row) => [String(row.source_key), row]));
    const referenced = new Set((this.database.connection.prepare(`
      SELECT DISTINCT source_key FROM memory_evidence
    `).all() as DatabaseRow[]).map((row) => String(row.source_key)));
    const changes: Array<{
      sourceKey: string;
      kind: "added" | "changed" | "removed";
      row: DatabaseRow;
      eventWatermark: number;
      referenced: boolean;
    }> = [];
    for (const [sourceKey, previous] of baseline) {
      const current = live.get(sourceKey);
      if (current === undefined || Number(current.active) === 0) {
        changes.push({
          sourceKey,
          kind: "removed",
          row: previous,
          eventWatermark: current === undefined
            ? integer(previous.source_updated_at, "Memory source watermark")
            : integer(current.source_updated_at, "Memory source watermark"),
          referenced: referenced.has(sourceKey),
        });
      } else if (String(current.content_hash) !== String(previous.content_hash)) {
        changes.push({
          sourceKey,
          kind: "changed",
          row: current,
          eventWatermark: integer(current.source_updated_at, "Memory source watermark"),
          referenced: referenced.has(sourceKey),
        });
      }
    }
    for (const [sourceKey, current] of live) {
      if (Number(current.active) === 1 && !baseline.has(sourceKey)) {
        changes.push({
          sourceKey,
          kind: "added",
          row: current,
          eventWatermark: integer(current.source_updated_at, "Memory source watermark"),
          referenced: referenced.has(sourceKey),
        });
      }
    }
    changes.sort((left, right) =>
      Number(right.referenced) - Number(left.referenced) ||
      Number(right.kind === "removed") - Number(left.kind === "removed") ||
      left.eventWatermark - right.eventWatermark ||
      left.sourceKey.localeCompare(right.sourceKey)
    );
    const selectedChanges = changes.slice(
      0,
      this.config.consolidation.maxChangedSourcesPerRun,
    );
    const selected = new Map(selectedChanges.map((change) => [change.sourceKey, change]));
    const inputs: ConsolidationInput[] = [];
    for (const [sourceKey, previous] of baseline) {
      const change = selected.get(sourceKey);
      if (change?.kind === "removed") {
        inputs.push(sourceFromRow(previous, "removed", change.eventWatermark));
      } else if (change?.kind === "changed") {
        inputs.push(sourceFromRow(change.row, "added"));
      } else {
        inputs.push(sourceFromRow(previous, "retained"));
      }
    }
    for (const change of selectedChanges) {
      if (change.kind === "added") inputs.push(sourceFromRow(change.row, "added"));
    }
    inputs.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    const selectedKeys = new Set(selectedChanges.map(({ sourceKey }) => sourceKey));
    const unselected = changes.filter(({ sourceKey }) => !selectedKeys.has(sourceKey));
    const processedWatermark = unselected.length === 0
      ? frozenWatermark
      : Math.max(0, Math.min(...unselected.map(({ eventWatermark }) => eventWatermark)) - 1);
    const insert = this.database.connection.prepare(`
      INSERT INTO consolidation_inputs (
        ownership_token, source_key, kind, source_id, source_generation,
        source_updated_at, source_summary, raw_memory, artifact_path,
        content_hash, started_at, ended_at, provenance, supports_success,
        source_ids_json, generated_at, selection_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const input of inputs) {
      insert.run(
        ownershipToken,
        input.sourceKey,
        input.kind,
        input.sourceId,
        input.sourceGeneration,
        input.sourceUpdatedAt,
        input.sourceSummary,
        input.rawMemory,
        input.artifactPath,
        input.contentHash,
        input.startedAt,
        input.endedAt,
        input.provenance,
        Number(input.supportsSuccess),
        JSON.stringify(input.sourceIds),
        input.generatedAt,
        input.state,
      );
    }
    return { inputs, processedWatermark };
  }

  claim(workerId: string, now = Date.now()): ConsolidationClaimResult {
    if (!workerId) throw new Error("Consolidation worker ID is required");
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT * FROM consolidation_jobs WHERE job_key = ?
      `).get(JOB_KEY) as DatabaseRow;
      const inputWatermark = integer(row.input_watermark, "Consolidation input watermark");
      const successWatermark = integer(
        row.last_success_watermark,
        "Consolidation success watermark",
      );
      if (row.status === "done" && inputWatermark <= successWatermark) {
        return { status: "skipped", reason: "up_to_date" };
      }
      if (
        row.status === "running" &&
        row.lease_until !== null &&
        integer(row.lease_until, "Consolidation lease") > now
      ) {
        return { status: "skipped", reason: "running" };
      }
      const publication = this.database.connection.prepare(`
        SELECT 1 AS present FROM consolidation_publications WHERE job_key = ?
      `).get(JOB_KEY);
      if (publication !== undefined) {
        return { status: "skipped", reason: "recovery_required" };
      }
      if (row.status === "error") {
        const retries = integer(row.retry_remaining, "Consolidation retries");
        if (retries === 0) return { status: "skipped", reason: "retry_exhausted" };
        if (
          row.retry_at !== null &&
          integer(row.retry_at, "Consolidation retry") > now
        ) {
          return { status: "skipped", reason: "retry" };
        }
      }
      if (
        row.status !== "error" &&
        row.finished_at !== null &&
        integer(row.finished_at, "Consolidation finish") +
          this.config.consolidation.cooldownMilliseconds > now
      ) {
        return { status: "skipped", reason: "cooldown" };
      }
      const expired = row.status === "running" &&
        row.lease_until !== null &&
        integer(row.lease_until, "Consolidation lease") <= now;
      const abandonmentCount = integer(
        row.abandonment_count,
        "Consolidation abandonment count",
      ) + (expired ? 1 : 0);
      if (expired && abandonmentCount >= this.config.worker.maxAttempts) {
        this.database.connection.prepare(`
          UPDATE consolidation_jobs SET
            status = 'error', worker_id = NULL, ownership_token = NULL,
            finished_at = ?, lease_until = NULL, retry_at = ?,
            abandonment_count = ?, last_error = ?
          WHERE job_key = ?
        `).run(
          now,
          now + this.config.worker.retryDelayMilliseconds,
          abandonmentCount,
          `Consolidation lease expired ${abandonmentCount} consecutive times`,
          JOB_KEY,
        );
        if (row.ownership_token !== null) {
          this.database.connection.prepare(`
            DELETE FROM consolidation_inputs WHERE ownership_token = ?
          `).run(String(row.ownership_token));
        }
        return { status: "skipped", reason: "retry" };
      }
      if (row.ownership_token !== null) {
        this.database.connection.prepare(`
          DELETE FROM consolidation_inputs WHERE ownership_token = ?
        `).run(String(row.ownership_token));
      }
      const ownershipToken = randomUUID();
      const frozenWatermark = inputWatermark;
      const snapshot = this.snapshot(ownershipToken, frozenWatermark);
      const leaseUntil = now + this.config.worker.leaseMilliseconds;
      this.database.connection.prepare(`
        UPDATE consolidation_jobs SET
          status = 'running', worker_id = ?, ownership_token = ?,
          started_at = ?, lease_until = ?, retry_at = NULL,
          abandonment_count = ?, last_error = NULL,
          claimed_watermark = ?, processed_watermark = ?
        WHERE job_key = ?
      `).run(
        workerId,
        ownershipToken,
        now,
        leaseUntil,
        abandonmentCount,
        frozenWatermark,
        snapshot.processedWatermark,
        JOB_KEY,
      );
      return {
        status: "claimed",
        claim: {
          workerId,
          ownershipToken,
          frozenWatermark,
          processedWatermark: snapshot.processedWatermark,
          leaseUntil,
        },
      };
    });
  }

  owns(claim: ConsolidationClaim, now = Date.now()): boolean {
    return this.database.connection.prepare(`
      SELECT 1 AS owned FROM consolidation_jobs
      WHERE job_key = ? AND status = 'running' AND worker_id = ?
        AND ownership_token = ? AND lease_until > ?
        AND claimed_watermark = ? AND processed_watermark = ?
    `).get(
      JOB_KEY,
      claim.workerId,
      claim.ownershipToken,
      now,
      claim.frozenWatermark,
      claim.processedWatermark,
    ) !== undefined;
  }

  heartbeat(claim: ConsolidationClaim, now = Date.now()): boolean {
    return changed(this.database.connection.prepare(`
      UPDATE consolidation_jobs SET lease_until = ?
      WHERE job_key = ? AND status = 'running' AND worker_id = ?
        AND ownership_token = ? AND lease_until > ?
        AND claimed_watermark = ? AND processed_watermark = ?
    `).run(
      now + this.config.worker.leaseMilliseconds,
      JOB_KEY,
      claim.workerId,
      claim.ownershipToken,
      now,
      claim.frozenWatermark,
      claim.processedWatermark,
    ));
  }

  loadInputs(claim: ConsolidationClaim): ConsolidationInput[] {
    const rows = this.database.connection.prepare(`
      SELECT * FROM consolidation_inputs
      WHERE ownership_token = ? ORDER BY source_key
    `).all(claim.ownershipToken) as DatabaseRow[];
    if (rows.length === 0 && !this.owns(claim, 0)) {
      throw new Error("Consolidation ownership lost");
    }
    return rows.map((row) => sourceFromRow(
      row,
      String(row.selection_state) as ConsolidationInput["state"],
    ));
  }

  activeEvidenceManifest(claim: ConsolidationClaim): ActiveEvidenceManifestItem[] {
    const inputs = new Map(this.loadInputs(claim).map((input) => [input.sourceKey, input]));
    const rows = this.database.connection.prepare(`
      SELECT memory_key, source_key FROM memory_evidence
      ORDER BY memory_key, source_key
    `).all() as DatabaseRow[];
    return rows.flatMap((row) => {
      const source = inputs.get(String(row.source_key));
      if (source === undefined || source.state === "removed") return [];
      return [{
        memoryKey: String(row.memory_key),
        sourceKey: source.sourceKey,
        artifactPath: source.artifactPath,
        contentHash: source.contentHash,
        provenance: source.provenance,
      }];
    });
  }

  private succeedInTransaction(
    claim: ConsolidationClaim,
    evidence?: ReadonlyMap<string, readonly string[]>,
    finishedAt = Date.now(),
  ): boolean {
    const inputs = this.loadInputs(claim);
    const active = new Map(inputs
      .filter(({ state }) => state !== "removed")
      .map((input) => [input.sourceKey, input]));
    if (evidence !== undefined) {
      for (const [memoryKey, sourceKeys] of evidence) {
        if (!memoryKey || sourceKeys.length === 0) {
          throw new Error("Invalid consolidated Memory evidence");
        }
        for (const sourceKey of sourceKeys) {
          if (!active.has(sourceKey)) {
            throw new Error(`Unknown consolidated Memory evidence ${sourceKey}`);
          }
        }
      }
    }
    this.database.connection.prepare(
      "DELETE FROM consolidation_source_baseline",
    ).run();
    const insertBaseline = this.database.connection.prepare(`
      INSERT INTO consolidation_source_baseline (
        source_key, kind, source_id, source_generation, source_updated_at,
        source_summary, raw_memory, artifact_path, content_hash,
        started_at, ended_at, provenance, supports_success, source_ids_json,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const input of active.values()) {
      insertBaseline.run(
        input.sourceKey,
        input.kind,
        input.sourceId,
        input.sourceGeneration,
        input.sourceUpdatedAt,
        input.sourceSummary,
        input.rawMemory,
        input.artifactPath,
        input.contentHash,
        input.startedAt,
        input.endedAt,
        input.provenance,
        Number(input.supportsSuccess),
        JSON.stringify(input.sourceIds),
        input.generatedAt,
      );
    }
    if (evidence !== undefined) {
      this.database.connection.prepare("DELETE FROM memory_evidence").run();
      const insertEvidence = this.database.connection.prepare(`
        INSERT INTO memory_evidence (memory_key, source_key, artifact_path)
        VALUES (?, ?, ?)
      `);
      for (const [memoryKey, sourceKeys] of evidence) {
        for (const sourceKey of [...new Set(sourceKeys)]) {
          insertEvidence.run(memoryKey, sourceKey, active.get(sourceKey)!.artifactPath);
        }
      }
    }
    const row = this.database.connection.prepare(`
      SELECT input_watermark FROM consolidation_jobs WHERE job_key = ?
    `).get(JOB_KEY) as DatabaseRow;
    const inputWatermark = integer(row.input_watermark, "Consolidation input watermark");
    this.database.connection.prepare(`
      UPDATE consolidation_jobs SET
        status = ?, worker_id = NULL, ownership_token = NULL,
        finished_at = ?, lease_until = NULL, retry_at = NULL,
        retry_remaining = ?, abandonment_count = 0, last_error = NULL,
        last_success_watermark = ?, claimed_watermark = NULL,
        processed_watermark = NULL
      WHERE job_key = ?
    `).run(
      inputWatermark > claim.processedWatermark ? "pending" : "done",
      finishedAt,
      this.config.worker.maxAttempts,
      claim.processedWatermark,
      JOB_KEY,
    );
    this.database.connection.prepare(`
      DELETE FROM consolidation_inputs WHERE ownership_token = ?
    `).run(claim.ownershipToken);
    return true;
  }

  succeed(
    claim: ConsolidationClaim,
    evidence?: ReadonlyMap<string, readonly string[]>,
    finishedAt = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      if (!this.owns(claim, finishedAt)) return false;
      return this.succeedInTransaction(claim, evidence, finishedAt);
    });
  }

  publication(): ConsolidationPublication | null {
    const row = this.database.connection.prepare(`
      SELECT * FROM consolidation_publications WHERE job_key = ?
    `).get(JOB_KEY) as DatabaseRow | undefined;
    if (row === undefined) return null;
    const evidence: unknown = JSON.parse(String(row.evidence_json));
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
      throw new Error("Invalid consolidation publication evidence");
    }
    return {
      ownershipToken: String(row.ownership_token),
      state: String(row.state) as ConsolidationPublication["state"],
      stagingName: String(row.staging_name),
      expectedHead: String(row.expected_head),
      memorySha256: String(row.memory_sha256),
      summarySha256: String(row.summary_sha256),
      evidence: evidence as Record<string, string[]>,
      frozenWatermark: integer(row.frozen_watermark, "Publication frozen watermark"),
      processedWatermark: integer(
        row.processed_watermark,
        "Publication processed watermark",
      ),
      createdAt: integer(row.created_at, "Publication creation time"),
    };
  }

  preparePublication(
    claim: ConsolidationClaim,
    input: Omit<ConsolidationPublication, "ownershipToken" | "state" | "frozenWatermark" | "processedWatermark">,
    now = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      if (!this.owns(claim, now)) return false;
      this.database.connection.prepare(`
        INSERT INTO consolidation_publications (
          job_key, ownership_token, state, staging_name, expected_head,
          memory_sha256, summary_sha256, evidence_json, frozen_watermark,
          processed_watermark, created_at
        ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_key) DO UPDATE SET
          ownership_token = excluded.ownership_token,
          state = excluded.state,
          staging_name = excluded.staging_name,
          expected_head = excluded.expected_head,
          memory_sha256 = excluded.memory_sha256,
          summary_sha256 = excluded.summary_sha256,
          evidence_json = excluded.evidence_json,
          frozen_watermark = excluded.frozen_watermark,
          processed_watermark = excluded.processed_watermark,
          created_at = excluded.created_at
      `).run(
        JOB_KEY,
        claim.ownershipToken,
        input.stagingName,
        input.expectedHead,
        input.memorySha256,
        input.summarySha256,
        JSON.stringify(input.evidence),
        claim.frozenWatermark,
        claim.processedWatermark,
        input.createdAt,
      );
      return true;
    });
  }

  beginPublication(claim: ConsolidationClaim, now = Date.now()): boolean {
    return this.database.transaction(() => {
      if (!this.owns(claim, now)) return false;
      return changed(this.database.connection.prepare(`
        UPDATE consolidation_publications SET state = 'publishing'
        WHERE job_key = ? AND ownership_token = ? AND state = 'prepared'
      `).run(JOB_KEY, claim.ownershipToken));
    });
  }

  finishPublication(
    claim: ConsolidationClaim,
    evidence: ReadonlyMap<string, readonly string[]>,
    finishedAt = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      if (!this.owns(claim, finishedAt)) return false;
      const journal = this.database.connection.prepare(`
        SELECT 1 AS valid FROM consolidation_publications
        WHERE job_key = ? AND ownership_token = ? AND state = 'publishing'
      `).get(JOB_KEY, claim.ownershipToken);
      if (journal === undefined) return false;
      this.database.connection.prepare(`
        DELETE FROM consolidation_publications
        WHERE job_key = ? AND ownership_token = ?
      `).run(JOB_KEY, claim.ownershipToken);
      return this.succeedInTransaction(claim, evidence, finishedAt);
    });
  }

  recoverPublished(publication: ConsolidationPublication, finishedAt = Date.now()): boolean {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`
        SELECT worker_id, ownership_token, claimed_watermark, processed_watermark
        FROM consolidation_jobs
        WHERE job_key = ? AND status = 'running' AND ownership_token = ?
      `).get(JOB_KEY, publication.ownershipToken) as DatabaseRow | undefined;
      if (
        row === undefined ||
        integer(row.claimed_watermark, "Consolidation claimed watermark") !==
          publication.frozenWatermark ||
        integer(row.processed_watermark, "Consolidation processed watermark") !==
          publication.processedWatermark
      ) {
        return false;
      }
      const claim: ConsolidationClaim = {
        workerId: String(row.worker_id),
        ownershipToken: publication.ownershipToken,
        frozenWatermark: publication.frozenWatermark,
        processedWatermark: publication.processedWatermark,
        leaseUntil: 0,
      };
      this.database.connection.prepare(`
        DELETE FROM consolidation_publications
        WHERE job_key = ? AND ownership_token = ?
      `).run(JOB_KEY, publication.ownershipToken);
      return this.succeedInTransaction(
        claim,
        new Map(Object.entries(publication.evidence)),
        finishedAt,
      );
    });
  }

  abandonPublication(
    ownershipToken: string,
    error: string,
  ): boolean {
    return this.database.transaction(() => {
      this.database.connection.prepare(`
        DELETE FROM consolidation_publications
        WHERE job_key = ? AND ownership_token = ?
      `).run(JOB_KEY, ownershipToken);
      this.database.connection.prepare(`
        DELETE FROM consolidation_inputs WHERE ownership_token = ?
      `).run(ownershipToken);
      return changed(this.database.connection.prepare(`
        UPDATE consolidation_jobs SET
          status = 'pending', worker_id = NULL, ownership_token = NULL,
          started_at = NULL, lease_until = NULL, retry_at = NULL,
          claimed_watermark = NULL, processed_watermark = NULL,
          last_error = ?
        WHERE job_key = ? AND ownership_token = ?
      `).run(error, JOB_KEY, ownershipToken));
    });
  }

  fail(
    claim: ConsolidationClaim,
    error: string,
    failedAt = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      if (!this.owns(claim, failedAt)) return false;
      const row = this.database.connection.prepare(`
        SELECT retry_remaining FROM consolidation_jobs WHERE job_key = ?
      `).get(JOB_KEY) as DatabaseRow;
      const retries = Math.max(
        0,
        integer(row.retry_remaining, "Consolidation retries") - 1,
      );
      this.database.connection.prepare(`
        UPDATE consolidation_jobs SET
          status = 'error', worker_id = NULL, ownership_token = NULL,
          finished_at = ?, lease_until = NULL, retry_at = ?,
          retry_remaining = ?, abandonment_count = 0, last_error = ?,
          claimed_watermark = NULL, processed_watermark = NULL
        WHERE job_key = ?
      `).run(
        failedAt,
        retries > 0 ? failedAt + this.config.worker.retryDelayMilliseconds : null,
        retries,
        error,
        JOB_KEY,
      );
      this.database.connection.prepare(`
        DELETE FROM consolidation_inputs WHERE ownership_token = ?
      `).run(claim.ownershipToken);
      return true;
    });
  }
}
