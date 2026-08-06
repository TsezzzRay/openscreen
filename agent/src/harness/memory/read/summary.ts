import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_MEMORY_SUMMARY_TOKENS = 2_500;
const BYTES_PER_ESTIMATED_TOKEN = 4;
const TRUNCATION_MARKER = "\n[Memory summary truncated]";

function truncateUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function limitMemorySummary(summary: string) {
  const maxBytes = MAX_MEMORY_SUMMARY_TOKENS * BYTES_PER_ESTIMATED_TOKEN;
  if (Buffer.byteLength(summary, "utf8") <= maxBytes) return summary;
  const contentBytes = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  return `${truncateUtf8(summary, contentBytes).trimEnd()}${TRUNCATION_MARKER}`;
}

export async function loadMemorySummary(root: string) {
  try {
    const summary = (await readFile(join(root, "memory_summary.md"), "utf8")).trim();
    return summary ? limitMemorySummary(summary) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
