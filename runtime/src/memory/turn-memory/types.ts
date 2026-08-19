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
