import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";

const START = "<oai-mem-citation>";
const END = "</oai-mem-citation>";
export const MEMORY_CITATION_ENTRY_TYPE = "openscreen.memory-citation";

export interface MemoryCitation {
  entries: Array<{
    path: string;
    lineStart: number;
    lineEnd: number;
    note: string;
  }>;
  rolloutIds: string[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Memory citation ${name}`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], name: string): void {
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) ||
      fields.some((field) => !(field in value))) {
    throw new Error(`Invalid Memory citation ${name}`);
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Memory citation ${name}`);
  }
  return value;
}

function requiredText(value: unknown, name: string, maxCharacters: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Memory citation ${name}`);
  }
  const result = value.trim();
  if (Array.from(result).length > maxCharacters) {
    throw new Error(`Invalid Memory citation ${name}: too long`);
  }
  return result;
}

export function stripMemoryCitationBlock(text: string): {
  text: string;
  citationJson?: string;
} {
  const start = text.lastIndexOf(START);
  if (start < 0) return { text };
  const end = text.indexOf(END, start + START.length);
  if (end < 0) return { text: text.slice(0, start).trimEnd() };
  const trailing = text.slice(end + END.length);
  if (trailing.trim()) {
    return {
      text: `${text.slice(0, start)}${trailing}`.trimEnd(),
    };
  }
  return {
    text: text.slice(0, start).trimEnd(),
    citationJson: text.slice(start + START.length, end).trim(),
  };
}

export class MemoryCitationStreamFilter {
  private pending = "";
  private citation = "";
  private inCitation = false;

  push(delta: string): string {
    if (!delta) return "";
    if (this.inCitation) {
      this.citation += delta;
      const end = this.citation.indexOf(END);
      if (end < 0) return "";
      const remainder = this.citation.slice(end + END.length);
      this.citation = "";
      this.inCitation = false;
      return this.push(remainder);
    }
    this.pending += delta;
    const start = this.pending.indexOf(START);
    if (start >= 0) {
      const visible = this.pending.slice(0, start);
      this.citation = this.pending.slice(start);
      this.pending = "";
      this.inCitation = true;
      const end = this.citation.indexOf(END);
      if (end >= 0) {
        const remainder = this.citation.slice(end + END.length);
        this.citation = "";
        this.inCitation = false;
        return visible + this.push(remainder);
      }
      return visible;
    }
    let retained = Math.min(this.pending.length, START.length - 1);
    while (
      retained > 0 &&
      !START.startsWith(this.pending.slice(this.pending.length - retained))
    ) {
      retained -= 1;
    }
    const visible = this.pending.slice(0, this.pending.length - retained);
    this.pending = this.pending.slice(this.pending.length - retained);
    return visible;
  }

  finish(): string {
    const remainder = this.inCitation || START.startsWith(this.pending)
      ? ""
      : this.pending;
    this.pending = "";
    this.citation = "";
    this.inCitation = false;
    return remainder;
  }
}

type FileRange = { start: number; end: number };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class MemoryFileAccessTracker {
  private readonly calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  private readonly ranges = new Map<string, FileRange[]>();

  constructor(
    private readonly memoryRoot: string,
    private readonly cwd: string,
  ) {}

  private relativeMemoryPath(path: string): string | undefined {
    const absolute = resolve(isAbsolute(path) ? path : resolve(this.cwd, path));
    const fromRoot = relative(resolve(this.memoryRoot), absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      return undefined;
    }
    return fromRoot.split("\\").join("/");
  }

  recordFileRange(path: string, start: number, end: number): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
      return;
    }
    const relativePath = this.relativeMemoryPath(path);
    if (relativePath === undefined) return;
    const ranges = this.ranges.get(relativePath) ?? [];
    ranges.push({ start, end });
    this.ranges.set(relativePath, ranges);
  }

  observe(event: AgentHarnessEvent): void {
    if (event.type === "tool_execution_start") {
      this.calls.set(event.toolCallId, {
        name: event.toolName,
        args: asRecord(event.args),
      });
      return;
    }
    if (event.type !== "tool_execution_end") return;
    const call = this.calls.get(event.toolCallId);
    this.calls.delete(event.toolCallId);
    if (call === undefined || event.isError) return;
    const details = asRecord(asRecord(event.result).details);
    if (call.name === "read") {
      const path = typeof details.path === "string" ? details.path : call.args.path;
      const offset = details.offset;
      const lines = details.linesReturned;
      if (typeof path === "string" && typeof offset === "number" && typeof lines === "number") {
        this.recordFileRange(path, offset, offset + Math.max(0, lines - 1));
      }
      return;
    }
    if (call.name === "grep" && Array.isArray(details.matchedLines)) {
      const context = typeof call.args.context === "number" ? call.args.context : 0;
      for (const value of details.matchedLines) {
        const match = asRecord(value);
        if (typeof match.path === "string" && typeof match.line === "number") {
          this.recordFileRange(
            match.path,
            Math.max(1, match.line - context),
            match.line + context,
          );
        }
      }
    }
  }

  accessed(path: string, lineStart: number, lineEnd: number): boolean {
    return (this.ranges.get(path) ?? []).some(
      (range) => range.start <= lineStart && range.end >= lineEnd,
    );
  }
}

export async function validateMemoryCitation(
  citationJson: string,
  memoryRoot: string,
  tracker: MemoryFileAccessTracker,
): Promise<MemoryCitation> {
  let value: unknown;
  try {
    value = JSON.parse(citationJson);
  } catch {
    throw new Error("Invalid Memory citation JSON");
  }
  const input = record(value, "root");
  exact(input, ["entries", "rolloutIds"], "root");
  if (!Array.isArray(input.entries) || input.entries.length > 16 ||
      !Array.isArray(input.rolloutIds) || input.rolloutIds.length > 16) {
    throw new Error("Invalid Memory citation shape");
  }
  const entries: MemoryCitation["entries"] = [];
  const rolloutContents: string[] = [];
  for (const [index, value] of input.entries.entries()) {
    const entry = record(value, `entries[${index}]`);
    exact(entry, ["path", "lineStart", "lineEnd", "note"], `entries[${index}]`);
    const path = requiredText(entry.path, `entries[${index}].path`, 512);
    if (!/^(?:MEMORY\.md|ACTIVITY\.md|rollout_summaries\/[^/]+\.md)$/.test(path)) {
      throw new Error(`Invalid Memory citation path ${path}`);
    }
    const lineStart = positiveInteger(entry.lineStart, `entries[${index}].lineStart`);
    const lineEnd = positiveInteger(entry.lineEnd, `entries[${index}].lineEnd`);
    if (lineEnd < lineStart || !tracker.accessed(path, lineStart, lineEnd)) {
      throw new Error(`Memory citation was not read: ${path}:${lineStart}-${lineEnd}`);
    }
    const absolute = resolve(memoryRoot, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Invalid Memory citation file ${path}`);
    }
    const content = await readFile(absolute, "utf8");
    const lines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");
    if (lineEnd > lines.length) {
      throw new Error(`Memory citation exceeds file lines: ${path}`);
    }
    if (path.startsWith("rollout_summaries/")) rolloutContents.push(content);
    entries.push({
      path,
      lineStart,
      lineEnd,
      note: requiredText(entry.note, `entries[${index}].note`, 500),
    });
  }
  const rolloutIds = [...new Set(input.rolloutIds.map((value, index) =>
    requiredText(value, `rolloutIds[${index}]`, 256)
  ))];
  for (const rolloutId of rolloutIds) {
    if (!rolloutContents.some((content) =>
      content.split(/\r?\n/).some((line) => line === `rollout_id: ${rolloutId}`)
    )) {
      throw new Error(`Memory citation returned unknown rollout ID ${rolloutId}`);
    }
  }
  return { entries, rolloutIds };
}
