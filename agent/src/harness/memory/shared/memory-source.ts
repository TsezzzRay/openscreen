import { createHash } from "node:crypto";

export const MEMORY_SOURCE_KINDS = ["chronicle", "turn_memory"] as const;
export const MEMORY_SOURCE_STATES = ["added", "retained", "removed"] as const;
export const MEMORY_SOURCE_PROVENANCE = ["passive_screen", "user_turn"] as const;

export type MemorySourceSnapshot = {
  id: string;
  kind: typeof MEMORY_SOURCE_KINDS[number];
  artifactPath: string;
  contentHash: string;
  startedAt: number;
  endedAt: number;
  provenance: typeof MEMORY_SOURCE_PROVENANCE[number];
  sourceIds: string[];
  state: typeof MEMORY_SOURCE_STATES[number];
};

function slug(value: string) {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return normalized || "memory-source";
}

export function memorySourceArtifactPath({
  id,
  kind,
  label,
}: {
  id: string;
  kind: MemorySourceSnapshot["kind"];
  label?: string;
}) {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  const prefix = kind === "chronicle" ? "chronicle" : "turn";
  return `rollout_summaries/${prefix}-${slug(label ?? id)}-${hash}.md`;
}

export function memorySourceContentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid memory source snapshot");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid memory source ${name}`);
  }
  return value.trim();
}

function safeInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid memory source ${name}`);
  }
  return value;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  choices: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`Invalid memory source ${name}`);
  }
  return value as T[number];
}

function artifactPath(value: unknown) {
  const path = requiredString(value, "artifact path");
  const segments = path.split("/");
  if (path.startsWith("/") || path.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid memory source artifact path");
  }
  return path;
}

function sourceIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Invalid memory source ids");
  }
  const ids = value.map((item) => requiredString(item, "source ids"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Invalid memory source ids: duplicate source id");
  }
  return ids;
}

export function parseMemorySourceSnapshot(value: unknown): MemorySourceSnapshot {
  const input = record(value);
  const allowed = new Set([
    "id",
    "kind",
    "artifactPath",
    "contentHash",
    "startedAt",
    "endedAt",
    "provenance",
    "sourceIds",
    "state",
  ]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Invalid memory source field ${unexpected}`);

  const startedAt = safeInteger(input.startedAt, "time bounds");
  const endedAt = safeInteger(input.endedAt, "time bounds");
  if (endedAt < startedAt) throw new Error("Invalid memory source time bounds");
  const contentHash = requiredString(input.contentHash, "content hash").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("Invalid memory source content hash");
  }
  return {
    id: requiredString(input.id, "id"),
    kind: oneOf(input.kind, MEMORY_SOURCE_KINDS, "kind"),
    artifactPath: artifactPath(input.artifactPath),
    contentHash,
    startedAt,
    endedAt,
    provenance: oneOf(input.provenance, MEMORY_SOURCE_PROVENANCE, "provenance"),
    sourceIds: sourceIds(input.sourceIds),
    state: oneOf(input.state, MEMORY_SOURCE_STATES, "state"),
  };
}
