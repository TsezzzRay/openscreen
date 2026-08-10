import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MemoryDatabase } from "../db/database.js";
import {
  MEMORY_SCOPE_TYPES,
  type MemoryScopeHint,
} from "../shared/memory-scope.js";

const MEMORY_FILENAME = "MEMORY.md";
const EMPTY_MEMORY_ARTIFACT = "# OpenScreen Memory\n\n_No durable memories._";
const MEMORY_BLOCK = /^## ([^\r\n]+)\r?\n\r?\n- key: ([a-z0-9][a-z0-9-]{0,127})\r?\n- scope: ([^\r\n]+)\r?\n- evidence: ([^\r\n]+)\r?\n\r?\n/gm;
const SCOPE_TYPES = new Set<string>(MEMORY_SCOPE_TYPES);

export type IndexedLongTermMemory = {
  key: string;
  title: string;
  scope: MemoryScopeHint;
  content: string;
  memorySourceIds: string[];
};

function parseScope(value: string): MemoryScopeHint {
  if (value === "global") return { type: "global" };
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid long-term memory scope ${value}`);
  }
  const type = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (!SCOPE_TYPES.has(type) || type === "global") {
    throw new Error(`Invalid long-term memory scope ${value}`);
  }
  return { type: type as MemoryScopeHint["type"], key };
}

function evidenceIds(value: string) {
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Invalid long-term memory evidence");
  }
  return ids;
}

export function parseLongTermMemoryIndex(contents: string): IndexedLongTermMemory[] {
  if (!contents.trim()) return [];
  if (!contents.startsWith("# OpenScreen Memory\n")) {
    throw new Error("Invalid OpenScreen long-term memory artifact");
  }
  if (contents.trim() === EMPTY_MEMORY_ARTIFACT) return [];

  const matches = [...contents.matchAll(MEMORY_BLOCK)];
  if (matches.length === 0) {
    throw new Error("Invalid OpenScreen long-term memory artifact");
  }
  const keys = new Set<string>();
  return matches.map((match, index) => {
    const key = match[2]!;
    if (keys.has(key)) throw new Error(`Duplicate long-term memory key ${key}`);
    keys.add(key);
    const contentStart = match.index! + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? contents.length;
    const content = contents.slice(contentStart, contentEnd).trim();
    if (!content) throw new Error(`Long-term memory ${key} has empty content`);
    return {
      key,
      title: match[1]!.trim(),
      scope: parseScope(match[3]!.trim()),
      content,
      memorySourceIds: evidenceIds(match[4]!),
    };
  });
}

async function readMemoryArtifact(root: string) {
  try {
    return await readFile(join(root, MEMORY_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function synchronizeLongTermMemoryIndex(
  root: string,
  database: MemoryDatabase,
  indexedAt = Date.now(),
) {
  const contents = await readMemoryArtifact(root);
  const contentSha256 = createHash("sha256").update(contents).digest("hex");
  const current = database.connection.prepare(`
    SELECT content_sha256 FROM retrieval_index_state
    WHERE name = 'long_term_memory'
  `).get() as { content_sha256: string } | undefined;
  if (current?.content_sha256 === contentSha256) return false;

  const memories = parseLongTermMemoryIndex(contents);
  database.transaction(() => {
    database.connection.prepare("DELETE FROM retrieval_long_term_memories").run();
    const insert = database.connection.prepare(`
      INSERT INTO retrieval_long_term_memories (
        memory_key, title, scope_type, scope_key, content,
        memory_source_ids_json, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const memory of memories) {
      insert.run(
        memory.key,
        memory.title,
        memory.scope.type,
        memory.scope.key ?? null,
        memory.content,
        JSON.stringify(memory.memorySourceIds),
        indexedAt,
      );
    }
    database.connection.prepare(`
      INSERT INTO retrieval_index_state (name, content_sha256, indexed_at)
      VALUES ('long_term_memory', ?, ?)
      ON CONFLICT (name) DO UPDATE SET
        content_sha256 = excluded.content_sha256,
        indexed_at = excluded.indexed_at
    `).run(contentSha256, indexedAt);
  });
  return true;
}
