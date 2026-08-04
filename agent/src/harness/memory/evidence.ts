import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ScreenObservation } from "../../plugins/screen-observation/types.js";
import type { MemoryDatabase } from "./db/database.js";
import type { MemoryPipelineConfig } from "./types.js";

export type ObservationEvidence = {
  path: string;
  sha256: string;
};

export async function persistObservationEvidence(
  root: string,
  observation: ScreenObservation,
): Promise<ObservationEvidence> {
  const contents = JSON.stringify(observation);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const idHash = createHash("sha256").update(observation.id).digest("hex");
  const directory = join(root, "evidence", "observations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${idHash.slice(0, 24)}-${sha256.slice(0, 16)}.json`;
  const path = join(directory, filename);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const parent = await open(directory, "r").catch(() => undefined);
    try {
      await parent?.sync();
    } finally {
      await parent?.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: relative(root, path), sha256 };
}

function safeEvidencePath(root: string, value: string) {
  if (!value || isAbsolute(value)) throw new Error("Invalid evidence path");
  const evidenceRoot = resolve(root, "evidence");
  const path = resolve(root, value);
  if (!path.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error("Evidence path escapes the memory root");
  }
  return path;
}

async function abandoned(path: string, now: number, graceMilliseconds: number) {
  try {
    return (await stat(path)).mtimeMs <=
      now - graceMilliseconds;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeTemporaryFiles(
  root: string,
  now: number,
  graceMilliseconds: number,
) {
  const directory = join(root, "evidence", "observations");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tmp") &&
        await abandoned(path, now, graceMilliseconds)) {
      await rm(path, { force: true });
    }
  }
}

async function removeUnreferencedEvidence(
  database: MemoryDatabase,
  root: string,
  now: number,
  graceMilliseconds: number,
) {
  const directory = join(root, "evidence", "observations");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const referenced = new Set((database.connection.prepare(`
    SELECT sidecar_path FROM source_items WHERE sidecar_path IS NOT NULL
  `).all() as Array<{ sidecar_path: string }>).map(({ sidecar_path }) =>
    resolve(root, sidecar_path)));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json") &&
        !referenced.has(resolve(path)) &&
        await abandoned(path, now, graceMilliseconds)) {
      await rm(path, { force: true });
    }
  }
}

export async function cleanupEvidence(
  database: MemoryDatabase,
  root: string,
  config: MemoryPipelineConfig["evidence"],
  now = Date.now(),
) {
  await removeTemporaryFiles(root, now, config.abandonedGraceMilliseconds);
  await removeUnreferencedEvidence(
    database,
    root,
    now,
    config.abandonedGraceMilliseconds,
  );
  const rows = database.connection.prepare(`
    SELECT id, sidecar_path FROM source_items
    WHERE sidecar_path IS NOT NULL AND sidecar_delete_after <= ?
    ORDER BY id
  `).all(now) as Array<{ id: string; sidecar_path: string }>;
  let deleted = 0;
  for (const row of rows) {
    const path = safeEvidencePath(root, row.sidecar_path);
    await rm(path, { force: true });
    database.transaction(() => {
      const result = database.connection.prepare(`
        UPDATE source_items SET
          sidecar_path = NULL, sidecar_sha256 = NULL, sidecar_delete_after = NULL
        WHERE id = ? AND sidecar_path = ? AND sidecar_delete_after <= ?
      `).run(row.id, row.sidecar_path, now);
      deleted += Number(result.changes);
    });
  }
  return deleted;
}
