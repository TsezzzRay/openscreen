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
