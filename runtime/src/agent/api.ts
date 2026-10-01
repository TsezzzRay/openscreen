import type { DesktopApprovalTarget } from "../desktop/api.js";

export type AgentApprovalTarget = string | DesktopApprovalTarget;
export type AgentImageMimeType = "image/png" | "image/jpeg";

export type AgentImage =
  | {
      path: string;
      mimeType: AgentImageMimeType;
    }
  | {
      data: Uint8Array;
      mimeType: AgentImageMimeType;
    };

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

export interface AgentApprovalRequest {
  id: string;
  sessionId: string;
  callId: string;
  tool: "bash" | "write" | "edit" | "desktop_click" | "desktop_scroll" | "desktop_type";
  target: AgentApprovalTarget;
  previewImage?: { mimeType: AgentImageMimeType; dataBase64: string };
  proposedContent?: string;
  expectedContent?: string;
  expectedAbsent?: boolean;
}

export type AgentRunEvent =
  | { type: "run-start" }
  | { type: "approval-requested"; request: AgentApprovalRequest }
  | { type: "approval-decided"; id: string; approved: boolean }
  | { type: "approval-committed"; id: string; callId: string; tool: "bash" | "write" | "edit" | "desktop_click" | "desktop_scroll" | "desktop_type"; target: AgentApprovalTarget }
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

/** Operational metadata only. Never include model payloads, headers, or text. */
export type AgentExecutionDiagnostic =
  | { type: "model-start"; invocationId: string; provider: string; model: string }
  | { type: "model-first-token"; invocationId: string }
  | { type: "model-response"; invocationId: string; status: number; upstreamRequestId?: string }
  | { type: "model-end"; invocationId: string; stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "tool-call-origin"; callId: string; invocationId: string }
  | { type: "tool-cancelled"; callId: string }
  | { type: "approval-outcome"; approvalId: string; reason: "approved" | "denied" | "cancelled" }
  | { type: "command-start"; callId: string; attemptId: string; host: boolean; approvalId?: string }
  | { type: "command-end"; callId: string; attemptId: string; host: boolean;
      status: "completed" | "failed" | "cancelled"; durationMs: number; exitCode?: number; errorCode?: string }
  | { type: "memory-context-unavailable" }
  | { type: "execution-uncertain"; approvalId: string; callId: string; name: string };

export type AgentDiagnosticListener = (event: AgentExecutionDiagnostic) => void | Promise<void>;

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
    onDiagnostic?: AgentDiagnosticListener,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
  abort(sessionId: string): Promise<void>;
  compact(
    sessionId: string,
    instructions?: string,
    signal?: AbortSignal,
    onDiagnostic?: AgentDiagnosticListener,
  ): Promise<AgentCompactionResult>;
  compactIfNeeded(
    sessionId: string,
    signal?: AbortSignal,
    onDiagnostic?: AgentDiagnosticListener,
  ): Promise<AgentCompactionResult | undefined>;
  setThinking(
    sessionId: string,
    thinking: AgentThinkingLevel,
  ): Promise<AgentSessionState>;
}
