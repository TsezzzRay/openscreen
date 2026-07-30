import type OpenAI from "openai";

export type ChatImage = {
  id: string;
  source: "system_capture" | "user_upload";
  path: string;
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
