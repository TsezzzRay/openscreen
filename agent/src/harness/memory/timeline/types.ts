export type ScreenObservationInput = {
  id: string;
  occurredAt: string;
  screenshot: {
    mimeType?: string;
    dataBase64?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ScreenActivitySource = {
  type: "screen";
  observation: ScreenObservationInput;
};

export type TerminalActivityStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TurnActivitySource = {
  type: "turn";
  sessionId: string;
  occurredAt: string;
  turn: {
    id: string;
    user: string;
    assistant: string;
    reasoning?: string;
    status: TerminalActivityStatus;
    outputItems?: unknown[];
  };
  agentRun?: {
    id: string;
    status: TerminalActivityStatus;
    startedAt: string;
    steps: unknown[];
  };
};

export type ActivitySource = ScreenActivitySource | TurnActivitySource;

export type TimelineEntry = {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  createdAt: string;
  source: {
    type: "screen" | "turn";
    id: string;
    sessionId?: string;
  };
  status: "observed" | TerminalActivityStatus;
  summary: string;
  application?: string;
  windowTitle?: string;
  entities: string[];
  verbatimEvidence: string[];
};
