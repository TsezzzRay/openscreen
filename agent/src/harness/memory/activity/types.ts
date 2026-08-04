import type { AgentRun, Turn } from "../../session/types.js";

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

export type TerminalTurnStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ActivitySource = {
  sourceId: string;
  occurredAt: string;
  turn: Omit<Turn, "status"> & { status: TerminalTurnStatus };
  agentRuns: AgentRun[];
};

export type ObservationProjection = {
  type: "observation";
  sourceId: string;
  occurredAt: string;
  capturedAt: string;
  application: {
    name: string;
    bundleIdentifier?: string;
  };
  windowTitle?: string;
  url?: string;
  focusedElement?: {
    role: string;
    subrole?: string;
    title?: string;
    value?: string;
    identifier?: string;
    description?: string;
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
  };
  visibleText: string;
};

export type TurnBatchProjection = {
  type: "turn_batch";
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

export type ActivityRecordOutput = {
  summary: string;
  sourceIds: string[];
  application?: string;
  windowTitle?: string;
  entities: string[];
  verbatimEvidence: string[];
  scopeHints: MemoryScopeHint[];
};

export type ActivityOutput = {
  activities: ActivityRecordOutput[];
  sourceSummary: string;
  rawMemory: string | null;
  scopeHints: MemoryScopeHint[];
};
