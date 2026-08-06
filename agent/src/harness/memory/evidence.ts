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

import type { ScreenObservation } from "../../extensions/screen-observation/types.js";
import type { MemoryDatabase } from "./db/database.js";
import type { MemoryPipelineConfig } from "./types.js";

export type EvidenceFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ObservationEvidence = {
  structured: EvidenceFile;
  screenshot?: EvidenceFile;
};

const EVIDENCE_DIRECTORIES = ["structured", "screenshots"] as const;

async function atomicEvidenceFile({
  root,
  directoryName,
  id,
  extension,
  contents,
}: {
  root: string;
  directoryName: typeof EVIDENCE_DIRECTORIES[number];
  id: string;
  extension: "json" | "jpg";
  contents: string | Buffer;
}): Promise<EvidenceFile> {
  const bytes = Buffer.byteLength(contents);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const idHash = createHash("sha256").update(id).digest("hex");
  const directory = join(root, "evidence", directoryName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${idHash.slice(0, 24)}-${sha256.slice(0, 16)}.${extension}`;
  const path = join(directory, filename);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
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
  return { path: relative(root, path), sha256, bytes };
}

export async function persistObservationEvidence(
  root: string,
  observation: ScreenObservation,
): Promise<ObservationEvidence> {
  const { dataBase64, ...screenshot } = observation.screenshot;
  const structured = await atomicEvidenceFile({
    root,
    directoryName: "structured",
    id: observation.id,
    extension: "json",
    contents: JSON.stringify({ ...observation, screenshot }),
  });
  if (dataBase64 === undefined || observation.screenshot.mimeType !== "image/jpeg") {
    return { structured };
  }
  const image = Buffer.from(dataBase64, "base64");
  const storedScreenshot = await atomicEvidenceFile({
    root,
    directoryName: "screenshots",
    id: observation.id,
    extension: "jpg",
    contents: image,
  });
  return { structured, screenshot: storedScreenshot };
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
    return (await stat(path)).mtimeMs <= now - graceMilliseconds;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function evidenceEntries(root: string) {
  const entries: Array<{ path: string; name: string }> = [];
  for (const directoryName of EVIDENCE_DIRECTORIES) {
    const directory = join(root, "evidence", directoryName);
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile()) entries.push({ path: join(directory, entry.name), name: entry.name });
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return entries;
}

async function removeTemporaryFiles(
  root: string,
  now: number,
  graceMilliseconds: number,
) {
  for (const entry of await evidenceEntries(root)) {
    if (entry.name.endsWith(".tmp") &&
        await abandoned(entry.path, now, graceMilliseconds)) {
      await rm(entry.path, { force: true });
    }
  }
}

async function removeUnreferencedEvidence(
  database: MemoryDatabase,
  root: string,
  now: number,
  graceMilliseconds: number,
) {
  const referenced = new Set((database.connection.prepare(`
    SELECT structured_path AS path FROM chronicle_sources
    WHERE structured_path IS NOT NULL
    UNION ALL
    SELECT screenshot_path AS path FROM chronicle_sources
    WHERE screenshot_path IS NOT NULL
  `).all() as Array<{ path: string }>).map(({ path }) => resolve(root, path)));
  for (const entry of await evidenceEntries(root)) {
    if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jpg")) continue;
    if (!referenced.has(resolve(entry.path)) &&
        await abandoned(entry.path, now, graceMilliseconds)) {
      await rm(entry.path, { force: true });
    }
  }
}

type ArtifactKind = "structured" | "screenshot";

async function removeArtifact(
  database: MemoryDatabase,
  root: string,
  row: { id: string; kind: ArtifactKind; path: string },
  dueAt?: number,
) {
  await rm(safeEvidencePath(root, row.path), { force: true });
  const parameters = dueAt === undefined
    ? [row.id, row.path]
    : [row.id, row.path, dueAt];
  const result = row.kind === "structured"
    ? database.connection.prepare(`
      UPDATE chronicle_sources SET
        structured_path = NULL,
        structured_sha256 = NULL,
        structured_delete_after = NULL
      WHERE id = ? AND structured_path = ?
        ${dueAt === undefined ? "" : "AND structured_delete_after <= ?"}
    `).run(...parameters)
    : database.connection.prepare(`
      UPDATE chronicle_sources SET
        screenshot_path = NULL,
        screenshot_sha256 = NULL,
        screenshot_delete_after = NULL
      WHERE id = ? AND screenshot_path = ?
        ${dueAt === undefined ? "" : "AND screenshot_delete_after <= ?"}
    `).run(...parameters);
  return Number(result.changes);
}

async function removeExpiredEvidence(
  database: MemoryDatabase,
  root: string,
  now: number,
) {
  const rows = database.connection.prepare(`
    SELECT id, 'structured' AS kind, structured_path AS path,
           structured_delete_after AS delete_after
    FROM chronicle_sources
    WHERE structured_path IS NOT NULL AND structured_delete_after <= ?
    UNION ALL
    SELECT id, 'screenshot' AS kind, screenshot_path AS path,
           screenshot_delete_after AS delete_after
    FROM chronicle_sources
    WHERE screenshot_path IS NOT NULL AND screenshot_delete_after <= ?
    ORDER BY delete_after, id, kind
  `).all(now, now) as Array<{
    id: string;
    kind: ArtifactKind;
    path: string;
  }>;
  let deleted = 0;
  for (const row of rows) deleted += await removeArtifact(database, root, row, now);
  return deleted;
}

async function evidenceBytes(root: string) {
  let bytes = 0;
  for (const entry of await evidenceEntries(root)) {
    if (entry.name.endsWith(".tmp")) continue;
    try {
      bytes += (await stat(entry.path)).size;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return bytes;
}

async function enforceCapacity(
  database: MemoryDatabase,
  root: string,
  maxBytes: number,
) {
  let totalBytes = await evidenceBytes(root);
  if (totalBytes <= maxBytes) return 0;
  const rows = database.connection.prepare(`
    SELECT id, structured_path, screenshot_path
    FROM chronicle_sources
    WHERE structured_path IS NOT NULL OR screenshot_path IS NOT NULL
    ORDER BY ingested_at, id
  `).all() as Array<{
    id: string;
    structured_path: string | null;
    screenshot_path: string | null;
  }>;
  let deleted = 0;
  for (const row of rows) {
    if (totalBytes <= maxBytes) break;
    for (const kind of ["screenshot", "structured"] as const) {
      const path = row[`${kind}_path`];
      if (path === null) continue;
      let size = 0;
      try {
        size = (await stat(safeEvidencePath(root, path))).size;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      deleted += await removeArtifact(database, root, { id: row.id, kind, path });
      totalBytes -= size;
    }
  }
  return deleted;
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
  const expired = await removeExpiredEvidence(database, root, now);
  return expired + await enforceCapacity(database, root, config.maxBytes);
}
