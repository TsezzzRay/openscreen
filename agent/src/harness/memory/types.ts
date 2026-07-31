export type LongTermMemory = {
  id: string;
  topic: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  evidenceActivityIds: [string, ...string[]];
};

export type MemoryChange = {
  action: "create";
  memory: LongTermMemory;
} | {
  action: "supersede";
  memoryId: string;
  replacement: LongTermMemory;
};

export type MemoryEvent = {
  schemaVersion: 1;
  type: "memory_run";
  id: string;
  attemptedAt: string;
  status: "processed" | "no_pending" | "failed";
  activityIds: string[];
  changes: MemoryChange[];
  error?: string;
};
