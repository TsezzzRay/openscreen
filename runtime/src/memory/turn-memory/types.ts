export type TerminalTurnStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TurnMemoryToolResult {
  name: string;
  status: "completed" | "failed";
  result: string;
}

export interface TurnMemorySource {
  sourceId: string;
  threadId: string;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  rolloutPath: string;
  userEntryIds: string[];
  terminalEntryId: string;
  startedAt: string;
  finishedAt: string;
  occurredAt: string;
  status: TerminalTurnStatus;
  user: string;
  assistant: string;
  sourceFrameIds: string[];
  compactionSummary?: string;
  terminalError?: string;
  tools: TurnMemoryToolResult[];
}

export interface TerminalTurnProjection {
  sources: TurnMemorySource[];
  nextEntryId?: string;
  cursorRewound: boolean;
}

export interface TurnMemoryBatchProjection {
  type: "turn_memory_batch";
  threadId: string;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  rolloutPath: string;
  sourceIds: string[];
  startedAt: string;
  finishedAt: string;
  turns: Array<{
    sourceId: string;
    status: TerminalTurnStatus;
    startedAt: string;
    finishedAt: string;
    user: string;
    assistant: string;
    sourceFrameIds: string[];
    compactionSummary?: string;
    terminalError?: string;
    tools: TurnMemoryToolResult[];
  }>;
}

export type TurnMemoryOutcome =
  | "success"
  | "partial"
  | "failed"
  | "cancelled"
  | "unknown";

export interface TurnMemoryTask {
  title: string;
  outcome: TurnMemoryOutcome;
  preferenceSignals: string[];
  reusableKnowledge: string[];
  failureLessons: string[];
  references: string[];
  keywords: string[];
}

export interface TurnMemoryExtraction {
  rawMemory: string;
  turnSummary: string;
  turnSlug: string;
  tasks: TurnMemoryTask[];
}
