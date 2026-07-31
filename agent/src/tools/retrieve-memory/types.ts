export type RetrieveMemoryArguments = {
  query: string;
  limit?: number;
};

export type RetrievedActivityEvidence = {
  activityId: string;
  occurredAt: string;
  summary: string;
};

export type RetrievedMemory = {
  memoryId: string;
  topic: string;
  content: string;
  evidence: RetrievedActivityEvidence[];
};

export type RetrieveMemoryResult = {
  memories: RetrievedMemory[];
};
