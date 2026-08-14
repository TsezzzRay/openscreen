export type ProductImageMimeType = "image/png" | "image/jpeg";

export interface ProductImageAttachment {
  path: string;
  mimeType: ProductImageMimeType;
}

export type ProductThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ProductSessionState {
  thinking: ProductThinkingLevel;
}

export interface ProductSessionSummary {
  id: string;
  createdAt: string;
  name?: string;
}

export interface ProductTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "context";
  timestamp: string;
  text: string;
  reasoning?: string;
  toolName?: string;
  isError?: boolean;
  imageCount?: number;
}

export interface ProductSessionView {
  session: ProductSessionSummary;
  messages: ProductTranscriptMessage[];
  state: ProductSessionState;
}

export interface ProductCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type ProductErrorCode =
  | "aborted"
  | "busy"
  | "duplicate-request"
  | "invalid-argument"
  | "not-found"
  | "provider"
  | "session"
  | "unknown";

export interface ProductFailure {
  code: ProductErrorCode;
  message: string;
}

export type ApplicationCommand =
  | { requestId: string; type: "list_sessions" }
  | { requestId: string; type: "create_session" }
  | { requestId: string; type: "get_session"; sessionId: string }
  | {
      requestId: string;
      type: "rename_session";
      sessionId: string;
      name: string;
    }
  | {
      requestId: string;
      type: "prompt";
      sessionId: string;
      input: {
        text: string;
        images?: ProductImageAttachment[];
      };
    }
  | {
      requestId: string;
      type: "abort";
      sessionId: string;
      targetRequestId: string;
    }
  | {
      requestId: string;
      type: "compact";
      sessionId: string;
      instructions?: string;
    }
  | {
      requestId: string;
      type: "set_thinking";
      sessionId: string;
      thinking: ProductThinkingLevel;
    };

export type ApplicationEvent =
  | { type: "sessions"; sessions: ProductSessionSummary[] }
  | { type: "session_view"; view: ProductSessionView }
  | { type: "session_renamed"; session: ProductSessionSummary }
  | { type: "run_started"; sessionId: string }
  | { type: "answer_delta"; sessionId: string; delta: string }
  | { type: "reasoning_delta"; sessionId: string; delta: string }
  | {
      type: "tool_started";
      sessionId: string;
      callId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_updated";
      sessionId: string;
      callId: string;
      name: string;
      text: string;
    }
  | {
      type: "tool_finished";
      sessionId: string;
      callId: string;
      name: string;
      text: string;
      isError: boolean;
    }
  | {
      type: "answer_completed";
      sessionId: string;
      answer: string;
      contextUsage?: { contextTokens: number; contextWindow: number };
    }
  | {
      type: "compaction_completed";
      sessionId: string;
      automatic: boolean;
      result: ProductCompactionResult;
    }
  | { type: "state_updated"; sessionId: string; state: ProductSessionState }
  | { type: "abort_completed"; targetRequestId: string }
  | { type: "completed" }
  | { type: "failed"; error: ProductFailure };

export type ApplicationEventSink = (
  event: ApplicationEvent,
) => void | Promise<void>;

export interface ApplicationHandler {
  execute(command: ApplicationCommand, emit: ApplicationEventSink): Promise<void>;
}
