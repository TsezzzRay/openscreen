export const MEMORY_SCOPE_TYPES = [
  "global",
  "application",
  "web_domain",
  "document",
  "project",
  "workflow",
  "person",
  "organization",
  "topic",
] as const;

export type MemoryScopeType = typeof MEMORY_SCOPE_TYPES[number];

export type MemoryScopeHint = {
  type: MemoryScopeType;
  key?: string;
  label?: string;
};
