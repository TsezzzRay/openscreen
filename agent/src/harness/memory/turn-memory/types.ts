import type { AgentRun, Turn } from "../../session/types.js";

export type TerminalTurnStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TurnMemorySource = {
  sourceId: string;
  occurredAt: string;
  turn: Omit<Turn, "status"> & { status: TerminalTurnStatus };
  agentRuns: AgentRun[];
};

export type TurnMemoryBatchProjection = {
  type: "turn_memory_batch";
  sessionId: string;
  turns: Array<{
    sourceId: string;
    turnId: string;
    occurredAt: string;
    startedAt: string;
    finishedAt: string;
    status: TerminalTurnStatus;
    user: string;
    assistant: string;
    agentRuns: Array<{
      runId: string;
      status: AgentRun["status"];
      startedAt: string;
      finishedAt?: string;
      tools: Array<{
        name: string;
        status: "completed" | "failed";
        result: string;
      }>;
    }>;
  }>;
};

export type TurnMemoryExtraction = {
  rawMemory: string;
  turnSummary: string;
  turnSlug: string;
};
