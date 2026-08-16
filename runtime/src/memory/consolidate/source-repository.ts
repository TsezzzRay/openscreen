import type { DatabaseRow, MemoryDatabase } from "../database.js";

export type MemorySourceKind = "turn_memory" | "chronicle";
export type MemorySourceProvenance = "user_turn" | "passive_screen";

export interface MemorySourceInput {
  sourceKey: string;
  kind: MemorySourceKind;
  sourceId: string;
  sourceGeneration: number;
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
}

function validate(input: MemorySourceInput): void {
  if (
    !input.sourceKey ||
    !input.sourceId ||
    !Number.isSafeInteger(input.sourceGeneration) ||
    input.sourceGeneration <= 0 ||
    !input.artifactPath.match(/^rollout_summaries\/[^/]+\.md$/) ||
    !input.contentHash.match(/^[0-9a-f]{64}$/) ||
    !Number.isSafeInteger(input.startedAt) ||
    !Number.isSafeInteger(input.endedAt) ||
    input.startedAt > input.endedAt ||
    !Number.isSafeInteger(input.generatedAt) ||
    input.sourceIds.length === 0 ||
    input.sourceIds.some((sourceId) => !sourceId)
  ) {
    throw new Error("Invalid Memory consolidation source");
  }
}

function nextWatermark(database: MemoryDatabase): number {
  const row = database.connection.prepare(`
    UPDATE memory_source_clock SET watermark = watermark + 1
    WHERE singleton = 1
    RETURNING watermark
  `).get() as DatabaseRow | undefined;
  if (typeof row?.watermark !== "number" || !Number.isSafeInteger(row.watermark)) {
    throw new Error("Invalid Memory source watermark");
  }
  return row.watermark;
}

function queueConsolidation(
  database: MemoryDatabase,
  watermark: number,
  maxAttempts: number,
): void {
  database.connection.prepare(`
    UPDATE consolidation_jobs SET
      status = CASE WHEN status = 'running' THEN status ELSE 'pending' END,
      input_watermark = max(input_watermark, ?),
      retry_at = CASE WHEN status = 'running' THEN retry_at ELSE NULL END,
      retry_remaining = max(retry_remaining, ?),
      last_error = CASE WHEN status = 'running' THEN last_error ELSE NULL END
    WHERE job_key = 'global'
  `).run(watermark, maxAttempts);
}

export function recordMemorySourceInTransaction(
  database: MemoryDatabase,
  input: MemorySourceInput,
  maxAttempts: number,
): number {
  validate(input);
  const existing = database.connection.prepare(`
    SELECT content_hash, active FROM memory_sources WHERE source_key = ?
  `).get(input.sourceKey) as DatabaseRow | undefined;
  if (
    existing !== undefined &&
    String(existing.content_hash) === input.contentHash &&
    Number(existing.active) === 1
  ) {
    database.connection.prepare(`
      UPDATE memory_sources SET
        source_id = ?, source_generation = ?, source_summary = ?, raw_memory = ?,
        started_at = ?, ended_at = ?, supports_success = ?, source_ids_json = ?,
        generated_at = ?
      WHERE source_key = ?
    `).run(
      input.sourceId,
      input.sourceGeneration,
      input.sourceSummary,
      input.rawMemory,
      input.startedAt,
      input.endedAt,
      Number(input.supportsSuccess),
      JSON.stringify([...new Set(input.sourceIds)]),
      input.generatedAt,
      input.sourceKey,
    );
    return Number(database.connection.prepare(`
      SELECT source_updated_at FROM memory_sources WHERE source_key = ?
    `).get(input.sourceKey)?.source_updated_at);
  }
  const watermark = nextWatermark(database);
  database.connection.prepare(`
    INSERT INTO memory_sources (
      source_key, kind, source_id, source_generation, source_updated_at,
      source_summary, raw_memory, artifact_path, content_hash,
      started_at, ended_at, provenance, supports_success, source_ids_json,
      active, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (source_key) DO UPDATE SET
      kind = excluded.kind,
      source_id = excluded.source_id,
      source_generation = excluded.source_generation,
      source_updated_at = excluded.source_updated_at,
      source_summary = excluded.source_summary,
      raw_memory = excluded.raw_memory,
      artifact_path = excluded.artifact_path,
      content_hash = excluded.content_hash,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      provenance = excluded.provenance,
      supports_success = excluded.supports_success,
      source_ids_json = excluded.source_ids_json,
      active = 1,
      garbage_collected_at = NULL,
      generated_at = excluded.generated_at
  `).run(
    input.sourceKey,
    input.kind,
    input.sourceId,
    input.sourceGeneration,
    watermark,
    input.sourceSummary,
    input.rawMemory,
    input.artifactPath,
    input.contentHash,
    input.startedAt,
    input.endedAt,
    input.provenance,
    Number(input.supportsSuccess),
    JSON.stringify([...new Set(input.sourceIds)]),
    input.generatedAt,
  );
  queueConsolidation(database, watermark, maxAttempts);
  return watermark;
}

export function deactivateMemorySourcesByEvidenceInTransaction(
  database: MemoryDatabase,
  sourceIds: readonly string[],
  maxAttempts: number,
): number {
  const unique = [...new Set(sourceIds.filter(Boolean))];
  if (unique.length === 0) return 0;
  const matching = database.connection.prepare(`
    SELECT DISTINCT s.source_key
    FROM memory_sources s, json_each(s.source_ids_json) evidence
    WHERE s.active = 1 AND evidence.value = ?
  `);
  const keys = new Set<string>();
  for (const sourceId of unique) {
    for (const row of matching.all(sourceId) as DatabaseRow[]) {
      keys.add(String(row.source_key));
    }
  }
  return deactivateMemorySourceKeysInTransaction(
    database,
    [...keys],
    maxAttempts,
  );
}

export function deactivateMemorySourceKeysInTransaction(
  database: MemoryDatabase,
  sourceKeys: readonly string[],
  maxAttempts: number,
): number {
  let deactivated = 0;
  for (const key of [...new Set(sourceKeys.filter(Boolean))]) {
    const active = database.connection.prepare(`
      SELECT 1 AS active FROM memory_sources
      WHERE source_key = ? AND active = 1
    `).get(key);
    if (active === undefined) continue;
    const watermark = nextWatermark(database);
    database.connection.prepare(`
      UPDATE memory_sources SET active = 0, source_updated_at = ?
      WHERE source_key = ? AND active = 1
    `).run(watermark, key);
    queueConsolidation(database, watermark, maxAttempts);
    deactivated += 1;
  }
  return deactivated;
}
