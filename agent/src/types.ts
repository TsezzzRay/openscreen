import type OpenAI from "openai";

export type ChatImage = {
  id: string;
  source: "user_upload";
  path: string;
};

export type ModelScreenContext = {
  captureId: string;
  application: string;
  windowTitle?: string;
  url?: string;
  focusedElement?: {
    role: string;
    title?: string;
    value?: string;
  };
  elements?: Array<{
    role: string;
    name?: string;
    value?: string;
    enabled?: boolean;
    selected?: boolean;
  }>;
  visibleText?: string;
};

export type TurnScreenContext = {
  ref: {
    captureId: string;
    observationId?: string;
    intentRevision: number;
    artifactRevision: number;
    completedRevision: number;
    intentContentEpoch: number;
    artifactContentEpoch: number;
    completedContentEpoch: number;
    startedAt?: string;
    capturedAt: string;
    status: "complete" | "screenshot_only" | "ax_only" | "failed";
    target: {
      processIdentifier: number;
      windowIdentifier: number;
    };
    image?: {
      path: string;
      mimeType: "image/jpeg";
      width: number;
      height: number;
    };
  };
  accessibility?: ModelScreenContext;
};

export type ModelOutputItem =
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.ResponseFunctionToolCall;

export type ConversationOutputItem =
  | ModelOutputItem
  | OpenAI.Responses.ResponseInputItem.FunctionCallOutput;

export type AgentTool = {
  definition: OpenAI.Responses.FunctionTool;
  execute: (
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export type AgentRunEvent = {
  type: "agent_step_completed";
  step: number;
  responseId?: string;
  outputItems: ModelOutputItem[];
  totalTokens?: number;
} | {
  type: "tool_result_recorded";
  step: number;
  callId: string;
  name: string;
  output: string;
  status: "completed" | "failed";
};

export type AgentStreamEvent = {
  type: "reasoning_delta" | "answer_delta";
  delta: string;
} | {
  type: "completed";
} | {
  type: "failed";
  message: string;
};
