import type OpenAI from "openai";

import type { AgentRunEvent, RegisteredAgentTool } from "../types.js";
import { ToolExecutionError } from "./errors.js";

type FunctionCall = OpenAI.Responses.ResponseFunctionToolCall;

type ToolCallExecution = {
  resultItem: OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonString(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

function normalizedResult(value: unknown) {
  if (isRecord(value) && typeof value.content === "string") {
    const details = value.details === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value.details)) as unknown;
    return {
      output: value.content,
      ...(details === undefined ? {} : { details }),
    };
  }
  return { output: jsonString(value) };
}

function errorOutput(error: unknown) {
  return JSON.stringify({
    error: error instanceof Error ? error.message : "Tool failed",
  });
}

async function executeOne(
  call: FunctionCall,
  tools: readonly RegisteredAgentTool[],
  step: number,
  signal: AbortSignal,
  record: (event: AgentRunEvent) => Promise<void>,
): Promise<ToolCallExecution> {
  signal.throwIfAborted();
  await record({
    type: "tool_call_started",
    step,
    callId: call.call_id,
    name: call.name,
    arguments: call.arguments,
    startedAt: new Date().toISOString(),
  });
  signal.throwIfAborted();

  let output: string;
  let details: unknown;
  let status: "completed" | "failed" = "completed";
  try {
    const tool = tools.find(({ definition }) => definition.name === call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    const argumentsValue: unknown = JSON.parse(call.arguments);
    if (!isRecord(argumentsValue)) throw new Error("Tool arguments must be an object");
    const result = normalizedResult(await tool.execute(argumentsValue, signal));
    output = result.output;
    details = result.details;
  } catch (error) {
    signal.throwIfAborted();
    status = "failed";
    if (error instanceof ToolExecutionError) {
      output = error.content;
      details = error.details === undefined
        ? undefined
        : JSON.parse(JSON.stringify(error.details)) as unknown;
    } else {
      output = errorOutput(error);
    }
  }

  await record({
    type: "tool_call_finished",
    step,
    callId: call.call_id,
    name: call.name,
    output,
    status,
    finishedAt: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  });
  return {
    resultItem: {
      type: "function_call_output",
      call_id: call.call_id,
      output,
    },
  };
}

export async function executeToolCalls(
  calls: readonly FunctionCall[],
  tools: readonly RegisteredAgentTool[],
  step: number,
  signal: AbortSignal,
  record: (event: AgentRunEvent) => Promise<void>,
) {
  signal.throwIfAborted();
  const settled = await Promise.allSettled(
    calls.map((call) => executeOne(call, tools, step, signal, record)),
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ToolCallExecution>).value);
}
