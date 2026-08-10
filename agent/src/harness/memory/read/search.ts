import type { MemoryScopeHint } from "../shared/memory-scope.js";
import {
  integer,
  type DatabaseRow,
  type MemoryDatabase,
} from "../db/database.js";
import { synchronizeLongTermMemoryIndex } from "./long-term-index.js";

export const CONTEXT_DOCUMENT_KINDS = [
  "screen_observation",
  "chronicle_activity",
  "chronicle_summary",
  "turn_summary",
  "long_term_memory",
] as const;

export type ContextDocumentKind = typeof CONTEXT_DOCUMENT_KINDS[number];

export type ContextRetrievalItem = {
  kind: ContextDocumentKind;
  id: string;
  occurredAt: string;
  endedAt?: string;
  generatedAt: string;
  application?: string;
  windowTitle?: string;
  title?: string;
  content: string;
  detail?: string;
  url?: string;
  scope?: MemoryScopeHint;
  memorySourceIds?: string[];
  sourceIds: string[];
  excerpt: string;
};

export type ContextSearchArguments = {
  query: string;
  kinds?: ContextDocumentKind[];
  since?: number;
  until?: number;
  application?: string;
  limit?: number;
};

export type RecentContextArguments = Omit<ContextSearchArguments, "query">;

export type ContextRetrievalResult = {
  items: ContextRetrievalItem[];
};

type RetrievalRow = DatabaseRow & {
  kind: ContextDocumentKind;
  document_id: string;
  occurred_at: number;
  ended_at: number | null;
  generated_at: number;
  application: string | null;
  window_title: string | null;
  title: string | null;
  content: string;
  details: string | null;
  excerpt?: string;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARACTERS = 1_024;
const KIND_SET = new Set<string>(CONTEXT_DOCUMENT_KINDS);

function searchableQuery(query: string) {
  const normalized = query.trim();
  if (!normalized) throw new Error("Context search query is required");
  if (Array.from(normalized).length > MAX_QUERY_CHARACTERS) {
    throw new Error("Context search query is too long");
  }
  const terms = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) {
    throw new Error("Context search query has no searchable terms");
  }
  return terms.map((term) => `"${term}"`).join(" ");
}

function boundedLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Context retrieval limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function kinds(value: ContextDocumentKind[] | undefined) {
  if (value === undefined) return [...CONTEXT_DOCUMENT_KINDS];
  if (value.length === 0 || value.some((kind) => !KIND_SET.has(kind))) {
    throw new Error("Invalid context retrieval kinds");
  }
  return [...new Set(value)];
}

function timestamp(value: number | undefined, name: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid context retrieval ${name}`);
  }
  return value;
}

function options(value: RecentContextArguments) {
  const since = timestamp(value.since, "since");
  const until = timestamp(value.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Invalid context retrieval time range");
  }
  const application = value.application?.trim();
  if (value.application !== undefined && !application) {
    throw new Error("Invalid context retrieval application");
  }
  return {
    kinds: kinds(value.kinds),
    since,
    until,
    application,
    limit: boundedLimit(value.limit),
  };
}

function addFilters(
  clauses: string[],
  parameters: Array<string | number>,
  value: ReturnType<typeof options>,
) {
  clauses.push(
    `d.kind IN (${value.kinds.map(() => "?").join(", ")})`,
  );
  parameters.push(...value.kinds);
  if (value.since !== undefined) {
    clauses.push("d.occurred_at >= ?");
    parameters.push(value.since);
  }
  if (value.until !== undefined) {
    clauses.push("d.occurred_at <= ?");
    parameters.push(value.until);
  }
  if (value.application !== undefined) {
    clauses.push("instr(lower(coalesce(d.application, '')), lower(?)) > 0");
    parameters.push(value.application);
  }
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function iso(value: unknown, name: string) {
  return new Date(integer(value, name)).toISOString();
}

function compactExcerpt(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return Array.from(compact).length <= 240
    ? compact
    : `${Array.from(compact).slice(0, 239).join("")}…`;
}

export class ContextRetrieval {
  constructor(
    private readonly root: string,
    private readonly database: MemoryDatabase,
  ) {}

  async search(argumentsValue: ContextSearchArguments): Promise<ContextRetrievalResult> {
    const query = searchableQuery(argumentsValue.query);
    const settings = options(argumentsValue);
    if (settings.kinds.includes("long_term_memory")) {
      await synchronizeLongTermMemoryIndex(this.root, this.database);
    }

    const clauses = ["retrieval_documents_fts MATCH ?"];
    const parameters: Array<string | number> = [query];
    addFilters(clauses, parameters, settings);
    parameters.push(settings.limit);
    const rows = this.database.connection.prepare(`
      SELECT
        d.kind, d.document_id, d.occurred_at, d.ended_at, d.generated_at,
        d.application, d.window_title, d.title, d.content, d.details,
        snippet(
          retrieval_documents_fts, -1, '[', ']', ' … ', 24
        ) AS excerpt,
        bm25(retrieval_documents_fts, 2.0, 2.0, 3.0, 1.0, 0.8) AS rank
      FROM retrieval_documents_fts
      JOIN retrieval_documents d ON d.id = retrieval_documents_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank, d.occurred_at DESC, d.kind, d.document_id
      LIMIT ?
    `).all(...parameters) as RetrievalRow[];
    return { items: rows.map((row) => this.hydrate(row)) };
  }

  async recent(
    argumentsValue: RecentContextArguments = {},
  ): Promise<ContextRetrievalResult> {
    const settings = options(argumentsValue);
    if (settings.kinds.includes("long_term_memory")) {
      await synchronizeLongTermMemoryIndex(this.root, this.database);
    }

    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    addFilters(clauses, parameters, settings);
    parameters.push(settings.limit);
    const rows = this.database.connection.prepare(`
      SELECT
        d.kind, d.document_id, d.occurred_at, d.ended_at, d.generated_at,
        d.application, d.window_title, d.title, d.content, d.details
      FROM retrieval_documents d
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.occurred_at DESC, d.kind, d.document_id
      LIMIT ?
    `).all(...parameters) as RetrievalRow[];
    return { items: rows.map((row) => this.hydrate(row)) };
  }

  private sourceIds(kind: ContextDocumentKind, id: string) {
    if (kind === "screen_observation") return [id];
    const table = kind === "chronicle_activity"
      ? "chronicle_activity_sources"
      : kind === "chronicle_summary"
        ? "chronicle_summary_sources"
        : kind === "turn_summary"
          ? "turn_memory_extraction_sources"
          : "memory_evidence";
    const key = kind === "chronicle_activity"
      ? "activity_id"
      : kind === "long_term_memory"
        ? "memory_key"
        : "job_key";
    return (this.database.connection.prepare(`
      SELECT DISTINCT source_id FROM ${table}
      WHERE ${key} = ? ORDER BY source_id
    `).all(id) as Array<{ source_id: string }>).map(({ source_id }) => source_id);
  }

  private hydrate(row: RetrievalRow): ContextRetrievalItem {
    const kind = String(row.kind) as ContextDocumentKind;
    const id = String(row.document_id);
    const application = optionalString(row.application);
    const windowTitle = optionalString(row.window_title);
    const title = optionalString(row.title);
    const detail = optionalString(row.details);
    const item: ContextRetrievalItem = {
      kind,
      id,
      occurredAt: iso(row.occurred_at, "retrieval occurrence time"),
      ...(row.ended_at === null
        ? {}
        : { endedAt: iso(row.ended_at, "retrieval end time") }),
      generatedAt: iso(row.generated_at, "retrieval generation time"),
      ...(application ? { application } : {}),
      ...(windowTitle ? { windowTitle } : {}),
      ...(title ? { title } : {}),
      content: String(row.content),
      ...(detail ? { detail } : {}),
      sourceIds: this.sourceIds(kind, id),
      excerpt: optionalString(row.excerpt) ?? compactExcerpt(
        [title, row.content, detail].filter(Boolean).join("\n"),
      ),
    };

    if (kind === "screen_observation") {
      const source = this.database.connection.prepare(`
        SELECT projection_json FROM chronicle_sources WHERE id = ?
      `).get(id) as { projection_json: string } | undefined;
      if (source) {
        const projection = JSON.parse(source.projection_json) as {
          url?: string;
          focusedElement?: {
            value?: string;
            title?: string;
            identifier?: string;
            description?: string;
          };
        };
        const focused = projection.focusedElement;
        const focusedDetail = focused && [
          focused.value,
          focused.title,
          focused.identifier,
          focused.description,
        ].filter(Boolean).join("\n");
        if (focusedDetail) item.detail = focusedDetail;
        else delete item.detail;
        if (projection.url) item.url = projection.url;
      }
    }

    if (kind === "long_term_memory") {
      const memory = this.database.connection.prepare(`
        SELECT scope_type, scope_key, memory_source_ids_json
        FROM retrieval_long_term_memories WHERE memory_key = ?
      `).get(id) as {
        scope_type: MemoryScopeHint["type"];
        scope_key: string | null;
        memory_source_ids_json: string;
      } | undefined;
      if (memory) {
        item.scope = {
          type: memory.scope_type,
          ...(memory.scope_key === null ? {} : { key: memory.scope_key }),
        };
        item.memorySourceIds = JSON.parse(memory.memory_source_ids_json) as string[];
      }
    }
    return item;
  }
}
