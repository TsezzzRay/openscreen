export type MemoryItem = {
  id: string;
  topic: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  evidenceTimelineIds: string[];
};

export type MemoryChange = {
  action: "create";
  memory: MemoryItem;
} | {
  action: "supersede";
  memoryId: string;
  replacement: MemoryItem;
};

export type MemoryEvent = {
  schemaVersion: 1;
  type: "memory_run";
  id: string;
  attemptedAt: string;
  status: "processed" | "no_pending" | "failed";
  timelineEntryIds: string[];
  changes: MemoryChange[];
  error?: string;
};

const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[a-z0-9_-]{20,}\b/i,
  /\bgh[pousr]_[a-z0-9]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',}]{8,}/i,
];

export function containsSensitiveData(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
