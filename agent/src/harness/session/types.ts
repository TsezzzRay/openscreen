import type {
  AgentStreamEvent,
  ChatImage,
  ConversationOutputItem,
  ModelOutputItem,
} from "../../types.js";

export type { ChatImage } from "../../types.js";

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  reasoning?: string;
  images?: ChatImage[];
  outputItems?: ConversationOutputItem[];
};

export type ConversationSummary = {
  content: string;
  createdAt: string;
  firstKeptTurnIndex: number;
};

export type SessionState = {
  turns: Turn[];
  conversationSummary?: ConversationSummary;
};

export type AgentToolResult = {
  callId: string;
  name: string;
  output: string;
  status: "completed" | "failed";
};

export type AgentRunStep = {
  step: number;
  responseId?: string;
  outputItems: ModelOutputItem[];
  totalTokens?: number;
  toolResults: AgentToolResult[];
};

export type AgentRun = {
  id: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  steps: AgentRunStep[];
};

export type VisibleTurn = Pick<Turn, "id" | "user" | "assistant" | "reasoning"> & {
  id: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  images?: ChatImage[];
  error?: string;
};

export type StoredSession = SessionState & {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  visibleTurns: VisibleTurn[];
  agentRuns: AgentRun[];
};

export type SessionSummary = Pick<
  StoredSession,
  "id" | "title" | "createdAt" | "updatedAt"
>;

export type ChatCommand = {
  requestId: string;
  sessionId: string;
  input: {
    text: string;
    images: ChatImage[];
  };
};

export type SessionRunEvent = AgentStreamEvent | {
  type: "started" | "cancelled";
};
