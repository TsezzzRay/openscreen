import OpenAI from "openai";

import type {
  AgentRunEvent,
  AgentTool,
  AgentStreamEvent,
  ConversationOutputItem,
  ModelOutputItem,
} from "./types.js";

export type ModelEvent = {
  type: string;
  delta?: string;
  message?: string;
  response?: {
    id?: string;
    error?: { message?: string } | null;
    output?: OpenAI.Responses.ResponseOutputItem[];
    usage?: { total_tokens?: number } | null;
  };
};

export function mapEvent(
  event: ModelEvent,
): AgentStreamEvent | undefined {
  switch (event.type) {
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return { type: "reasoning_delta", delta: event.delta ?? "" };
    case "response.output_text.delta":
    case "response.refusal.delta":
      return { type: "answer_delta", delta: event.delta ?? "" };
    case "response.completed":
      return { type: "completed" };
    case "response.failed":
    case "response.incomplete":
      return {
        type: "failed",
        message: event.response?.error?.message ?? "Model response failed",
      };
    case "error":
      return { type: "failed", message: event.message ?? "Model request failed" };
  }
}

export async function relayStream(
  stream: AsyncIterable<ModelEvent>,
  send: (event: AgentStreamEvent) => void,
): Promise<{
  output: string;
  reasoning: string;
  responseId?: string;
  outputItems?: ModelOutputItem[];
  totalTokens?: number;
} | null> {
  let output = "";
  let reasoning = "";
  let responseId: string | undefined;
  let outputItems: ModelOutputItem[] | undefined;
  let completed = false;
  let totalTokens: number | undefined;

  for await (const modelEvent of stream) {
    if (
      modelEvent.type === "response.reasoning_summary_text.delta" ||
      modelEvent.type === "response.reasoning_text.delta"
    ) {
      reasoning += modelEvent.delta ?? "";
    }
    if (
      modelEvent.type === "response.output_text.delta" ||
      modelEvent.type === "response.refusal.delta"
    ) {
      output += modelEvent.delta ?? "";
    }
    if (modelEvent.type === "response.completed") {
      completed = true;
      responseId = modelEvent.response?.id;
      outputItems = modelEvent.response?.output?.filter(
        (item): item is ModelOutputItem =>
          item.type === "reasoning" || item.type === "message" ||
          item.type === "function_call",
      );
      totalTokens = modelEvent.response?.usage?.total_tokens;
      continue;
    }
    const event = mapEvent(modelEvent);
    if (!event) continue;
    send(event);
    if (event.type === "failed") return null;
  }

  if (!completed) {
    send({
      type: "failed",
      message: "Model stream ended before completion",
    });
    return null;
  }

  return {
    output,
    reasoning,
    ...(responseId ? { responseId } : {}),
    outputItems,
    totalTokens,
  };
}

type BuildAgentRequest = (
  items: ConversationOutputItem[],
  tools: OpenAI.Responses.FunctionTool[],
) => Promise<OpenAI.Responses.ResponseCreateParamsStreaming>;

function toolOutput(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

export async function runAgentLoop(
  client: OpenAI,
  buildRequest: BuildAgentRequest,
  tools: AgentTool[],
  send: (event: AgentStreamEvent) => void,
  record: (event: AgentRunEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<{
  type: "completed";
  output: string;
  reasoning: string;
  outputItems: ConversationOutputItem[];
  totalTokens?: number;
} | null> {
  const definitions = tools.map(({ definition }) => definition);
  const items: ConversationOutputItem[] = [];
  let output = "";
  let reasoning = "";
  let totalTokens: number | undefined;
  let step = 0;
  const callIds = new Set<string>();

  while (true) {
    signal.throwIfAborted();
    const request = await buildRequest(items, definitions);
    signal.throwIfAborted();
    const stream = await client.responses.create(request, { signal });
    const result = await relayStream(stream, send);
    if (!result) return null;

    step += 1;
    output += result.output;
    reasoning += result.reasoning;
    totalTokens = result.totalTokens;
    const modelItems = result.outputItems ?? [];
    const calls = modelItems.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
        item.type === "function_call",
    );
    for (const call of calls) {
      if (callIds.has(call.call_id)) {
        throw new Error(`Duplicate function call ID: ${call.call_id}`);
      }
      callIds.add(call.call_id);
    }
    items.push(...modelItems);
    await record({
      type: "agent_step_completed",
      step,
      responseId: result.responseId,
      outputItems: modelItems,
      totalTokens: result.totalTokens,
    });
    signal.throwIfAborted();

    if (calls.length === 0) {
      return { type: "completed", output, reasoning, outputItems: items, totalTokens };
    }

    for (const call of calls) {
      signal.throwIfAborted();
      let callOutput: string;
      let status: "completed" | "failed" = "completed";
      try {
        const tool = tools.find(({ definition }) => definition.name === call.name);
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        const argumentsValue: unknown = JSON.parse(call.arguments);
        if (typeof argumentsValue !== "object" || argumentsValue === null ||
            Array.isArray(argumentsValue)) {
          throw new Error("Tool arguments must be an object");
        }
        callOutput = toolOutput(await tool.execute(
          argumentsValue as Record<string, unknown>,
          signal,
        ));
      } catch (error) {
        signal.throwIfAborted();
        status = "failed";
        callOutput = JSON.stringify({
          error: error instanceof Error ? error.message : "Tool failed",
        });
      }
      const resultItem = {
        type: "function_call_output" as const,
        call_id: call.call_id,
        output: callOutput,
      };
      items.push(resultItem);
      await record({
        type: "tool_result_recorded",
        step,
        callId: call.call_id,
        name: call.name,
        output: callOutput,
        status,
      });
    }
  }
}
