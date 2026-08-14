export type AgentImageMimeType = "image/png" | "image/jpeg";

export interface AgentImage {
  path: string;
  mimeType: AgentImageMimeType;
}

export interface AgentInjectedContext {
  text?: string;
  images?: AgentImage[];
}

export interface AgentPrompt {
  text: string;
  images?: AgentImage[];
  context?: AgentInjectedContext;
}

export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface AgentSessionState {
  thinking: AgentThinkingLevel;
}

export interface AgentSessionSummary {
  id: string;
  createdAt: string;
  name?: string;
}

export interface AgentTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "context";
  timestamp: string;
  text: string;
  reasoning?: string;
  toolName?: string;
  isError?: boolean;
  imageCount?: number;
}

export interface AgentSessionView {
  session: AgentSessionSummary;
  messages: AgentTranscriptMessage[];
  state: AgentSessionState;
}

export type AgentErrorCode =
  | "aborted"
  | "busy"
  | "invalid-argument"
  | "not-found"
  | "provider"
  | "session"
  | "unknown";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export type AgentRunEvent =
  | { type: "run-start" }
  | { type: "answer-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-start";
      callId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-update";
      callId: string;
      name: string;
      text: string;
    }
  | {
      type: "tool-end";
      callId: string;
      name: string;
      text: string;
      isError: boolean;
    }
  | { type: "complete"; answer: string }
  | { type: "failure"; error: AgentError };

export type AgentEventListener = (
  event: AgentRunEvent,
) => void | Promise<void>;

export interface AgentContextUsage {
  contextTokens: number;
  contextWindow: number;
}

export interface AgentRunResult {
  sessionId: string;
  answer: string;
  contextUsage: AgentContextUsage;
}

export interface AgentCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export class AgentServiceError extends Error implements AgentError {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentServiceError";
    this.code = code;
  }
}

export interface AgentService {
  createSession(): Promise<AgentSessionView>;
  listSessions(): Promise<AgentSessionSummary[]>;
  getSession(sessionId: string): Promise<AgentSessionView>;
  renameSession(sessionId: string, name: string): Promise<AgentSessionSummary>;
  prompt(
    sessionId: string,
    prompt: AgentPrompt,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult>;
  abort(sessionId: string): Promise<void>;
  compact(
    sessionId: string,
    instructions?: string,
  ): Promise<AgentCompactionResult>;
  compactIfNeeded(
    sessionId: string,
  ): Promise<AgentCompactionResult | undefined>;
  setThinking(
    sessionId: string,
    thinking: AgentThinkingLevel,
  ): Promise<AgentSessionState>;
}
