import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { MemoryConfig } from "./config.js";
import {
  deactivateMemorySourceKeysInTransaction,
} from "./consolidate/source-repository.js";
import type { DatabaseRow, MemoryDatabase } from "./database.js";
import { withMemoryWorkspaceWriter } from "./workspace-coordinator.js";

function artifactPath(root: string, path: string): string {
  if (isAbsolute(path) || !/^rollout_summaries\/[^/]+\.md$/.test(path)) {
    throw new Error(`Invalid retained Memory artifact path ${path}`);
  }
  const target = resolve(root, path);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Memory retention path escapes root: ${path}`);
  }
  return target;
}

export async function collectMemoryGarbage({
  root,
  database,
  config,
  now = Date.now(),
}: {
  root: string;
  database: MemoryDatabase;
  config: MemoryConfig;
  now?: number;
}): Promise<string[]> {
  return withMemoryWorkspaceWriter(root, async () => {
    const cutoff = now - config.retention.chronicleUnreferencedMilliseconds;
    const rows = database.connection.prepare(`
      SELECT s.source_key, s.kind, s.active, s.artifact_path
      FROM memory_sources s
      LEFT JOIN memory_evidence e ON e.source_key = s.source_key
      WHERE e.source_key IS NULL AND s.garbage_collected_at IS NULL AND (
        (s.kind = 'chronicle' AND s.ended_at <= ?) OR
        (s.kind = 'turn_memory' AND s.active = 0)
      )
      ORDER BY s.source_key
    `).all(cutoff) as DatabaseRow[];
    const chronicle = rows
      .filter((row) => row.kind === "chronicle" && Number(row.active) === 1)
      .map((row) => String(row.source_key));
    if (chronicle.length > 0) {
      database.transaction(() => {
        deactivateMemorySourceKeysInTransaction(
          database,
          chronicle,
          config.worker.maxAttempts,
        );
      });
    }
    const collected: string[] = [];
    for (const row of rows) {
      const sourceKey = String(row.source_key);
      const path = String(row.artifact_path);
      const stillReferenced = database.connection.prepare(`
        SELECT 1 AS referenced FROM memory_evidence WHERE source_key = ? LIMIT 1
      `).get(sourceKey);
      if (stillReferenced !== undefined) continue;
      await rm(artifactPath(root, path), { force: true });
      database.transaction(() => {
        const reference = database.connection.prepare(`
          SELECT 1 AS referenced FROM memory_evidence WHERE source_key = ? LIMIT 1
        `).get(sourceKey);
        if (reference !== undefined) {
          throw new Error(`Memory source ${sourceKey} became referenced during retention`);
        }
        database.connection.prepare(`
          UPDATE memory_sources SET garbage_collected_at = ?
          WHERE source_key = ? AND garbage_collected_at IS NULL
        `).run(now, sourceKey);
        database.connection.prepare(`
          DELETE FROM memory_artifacts WHERE relative_path = ?
        `).run(path);
      });
      collected.push(sourceKey);
    }
    return collected;
  });
}
