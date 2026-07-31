import type { AgentRun, Turn } from "../../session/types.js";
import type { ScreenObservation } from "../../../plugins/screen-observation/types.js";

export type TerminalActivityStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ScreenActivitySource = {
  type: "screen_observation";
  observation: ScreenObservation;
};

export type TurnActivitySource = {
  type: "turn";
  sessionId: string;
  occurredAt: string;
  turn: Turn;
  agentRuns: AgentRun[];
};

export type ActivitySource = ScreenActivitySource | TurnActivitySource;

export type ActivitySourceReference = {
  type: "screen_observation";
  observationId: string;
} | {
  type: "turn";
  sessionId: string;
  turnId: string;
  agentRunIds: string[];
};

export type ActivityRecord = {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  createdAt: string;
  sources: [ActivitySourceReference, ...ActivitySourceReference[]];
  status: "observed" | TerminalActivityStatus;
  summary: string;
  application?: string;
  windowTitle?: string;
  entities: string[];
  verbatimEvidence: string[];
};
