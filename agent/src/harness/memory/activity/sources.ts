import type { DatabaseSync } from "node:sqlite";

import type { DatabaseRow } from "../db/database.js";

export function activitySourceRows(
  connection: DatabaseSync,
  source: DatabaseRow,
) {
  const query = source.source_kind === "observation_window"
    ? `
        SELECT s.id, s.source_type, s.session_id, s.occurred_at, s.projection_json
        FROM source_items s
        JOIN observation_window_sources ws ON ws.source_id = s.id
        WHERE ws.window_id = ?
        ORDER BY s.occurred_at, s.id
      `
    : `
        SELECT s.id, s.source_type, s.session_id, s.occurred_at, s.projection_json
        FROM source_items s
        JOIN turn_batch_sources bs ON bs.source_id = s.id
        WHERE bs.batch_id = ?
        ORDER BY s.occurred_at, s.id
      `;
  return connection.prepare(query).all(String(source.source_id)) as DatabaseRow[];
}
