import { readFile } from "node:fs/promises";

import OpenAI from "openai";

import type { SessionState, Turn } from "./session.js";

const instructions = `You are OpenScreen, a screen-aware assistant.

Answer the user's question using the attached screenshot.
Reply in the same language as the user.
Be direct and concise.
If the answer cannot be determined from the screenshot, say so.
Do not claim that you clicked, typed, changed, or executed anything.`;

type LoadScreenshot = (path: string) => Promise<string>;

type ConversationOutputItem =
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseOutputMessage;

const loadScreenshot: LoadScreenshot = async (path) => (
  await readFile(path)
).toString("base64");

export type ModelEvent = {
  type: string;
  delta?: string;
  message?: string;
  response?: {
    error?: { message?: string } | null;
    output?: OpenAI.Responses.ResponseOutputItem[];
    usage?: { total_tokens?: number } | null;
  };
};

export type OutputEnvelope = {
  requestId: string;
  type: "started" | "reasoning_delta" | "answer_delta" | "completed" | "failed" | "cancelled";
  delta?: string;
  message?: string;
};

function imagePart(
  model: string,
  imageBase64: string,
): OpenAI.Responses.ResponseInputImage {
  const imageURL = `data:image/png;base64,${imageBase64}`;
  return (model.toLowerCase() === "minimax-m3"
    ? {
        type: "input_image",
        image_url: { url: imageURL, detail: "default" },
      }
    : {
        type: "input_image",
        detail: "auto",
        image_url: imageURL,
      }) as unknown as OpenAI.Responses.ResponseInputImage;
}

async function userInput(
  model: string,
  text: string,
  screenshotPath: string | undefined,
  readScreenshot: LoadScreenshot,
): Promise<OpenAI.Responses.ResponseInputItem> {
  return {
    role: "user",
    content: [
      { type: "input_text", text },
      ...(screenshotPath
        ? [imagePart(model, await readScreenshot(screenshotPath))]
        : []),
    ],
  };
}

async function turnsInput(
  model: string,
  turns: Turn[],
  readScreenshot: LoadScreenshot,
  preserveOutputItems = true,
): Promise<OpenAI.Responses.ResponseInput> {
  return (await Promise.all(turns.map(async (turn) => [
    await userInput(model, turn.user, turn.screenshotPath, readScreenshot),
    ...(preserveOutputItems && (turn.status ?? "completed") === "completed" &&
        turn.outputItems?.length
      ? turn.outputItems
      : [{ role: "assistant" as const, content: turnOutput(turn) }]),
  ]))).flat();
}

function turnOutput(turn: Turn) {
  if (turn.status === "failed" || turn.status === "cancelled") {
    return [
      turn.status === "failed"
        ? "[Request failed; response may be incomplete]"
        : "[Request cancelled by user; response is incomplete]",
      turn.reasoning ? `Partial reasoning:\n${turn.reasoning}` : "",
      turn.assistant ? `Partial answer:\n${turn.assistant}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return turn.assistant;
}

export async function makeRequest(
  model: string,
  text: string,
  screenshotPath: string,
  maxOutputTokens: number,
  session: SessionState = { turns: [], firstKeptTurnIndex: 0 },
  readScreenshot: LoadScreenshot = loadScreenshot,
): Promise<OpenAI.Responses.ResponseCreateParamsStreaming> {
  const isMiniMaxM3 = model.toLowerCase() === "minimax-m3";
  const retainedInput = await turnsInput(
    model,
    session.turns.slice(session.firstKeptTurnIndex),
    readScreenshot,
  );

  return {
    model,
    instructions,
    input: [
      ...(session.summary
        ? [{ role: "developer" as const, content: `Conversation summary:\n${session.summary}` }]
        : []),
      ...retainedInput,
      await userInput(model, text, screenshotPath, readScreenshot),
    ],
    reasoning: isMiniMaxM3 ? { effort: "minimal" } : { summary: "auto" },
    max_output_tokens: maxOutputTokens,
    stream: true,
  };
}

export function mapEvent(
  requestId: string,
  event: ModelEvent,
): OutputEnvelope | undefined {
  switch (event.type) {
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return { requestId, type: "reasoning_delta", delta: event.delta ?? "" };
    case "response.output_text.delta":
    case "response.refusal.delta":
      return { requestId, type: "answer_delta", delta: event.delta ?? "" };
    case "response.completed":
      return { requestId, type: "completed" };
    case "response.failed":
    case "response.incomplete":
      return {
        requestId,
        type: "failed",
        message: event.response?.error?.message ?? "Model response failed",
      };
    case "error":
      return { requestId, type: "failed", message: event.message ?? "Model request failed" };
  }
}

export async function relayStream(
  requestId: string,
  stream: AsyncIterable<ModelEvent>,
  send: (event: OutputEnvelope) => void,
): Promise<{
  output: string;
  reasoning: string;
  outputItems?: ConversationOutputItem[];
  totalTokens?: number;
} | null> {
  let output = "";
  let reasoning = "";
  let outputItems: ConversationOutputItem[] | undefined;
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
      outputItems = modelEvent.response?.output?.filter(
        (item): item is ConversationOutputItem =>
          item.type === "reasoning" || item.type === "message",
      );
      totalTokens = modelEvent.response?.usage?.total_tokens;
      continue;
    }
    const event = mapEvent(requestId, modelEvent);
    if (!event) continue;
    send(event);
    if (event.type === "failed") return null;
  }

  if (!completed) {
    send({
      requestId,
      type: "failed",
      message: "Model stream ended before completion",
    });
    return null;
  }

  return { output, reasoning, outputItems, totalTokens };
}

export async function countTurns(
  client: OpenAI,
  model: string,
  turns: Turn[],
  readScreenshot: LoadScreenshot = loadScreenshot,
  signal?: AbortSignal,
) {
  return (
    await client.responses.inputTokens.count({
      model,
      input: await turnsInput(model, turns, readScreenshot),
    }, { signal })
  ).input_tokens;
}

export async function countRequestTokens(
  client: OpenAI,
  request: OpenAI.Responses.ResponseCreateParamsStreaming,
  signal?: AbortSignal,
) {
  return (
    await client.responses.inputTokens.count({
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      reasoning: request.reasoning,
    }, { signal })
  ).input_tokens;
}

export async function summarizeTurns(
  client: OpenAI,
  model: string,
  previousSummary: string | undefined,
  turns: Turn[],
  maxOutputTokens: number,
  readScreenshot: LoadScreenshot = loadScreenshot,
  signal?: AbortSignal,
): Promise<string> {
  const response = await client.responses.create({
    model,
    instructions: `Summarize the earlier conversation concisely. Preserve user intent, confirmed facts, decisions, failed or cancelled request status, unfinished requests, and important visual information such as errors, interface state, visible data, and the user's current work. Integrate visual information as plain facts. Do not output screenshot paths, filenames, turn IDs, internal reference markers such as screen:*, or phrases that refer to a screenshot or image. Do not describe the summarization process.`,
    input: [
      ...(previousSummary
        ? [{ role: "developer" as const, content: `Previous summary:\n${previousSummary}` }]
        : []),
      ...await turnsInput(model, turns, readScreenshot, false),
    ],
    max_output_tokens: maxOutputTokens,
  }, { signal });
  const summary = response.output_text.trim();
  if (!summary) throw new Error("Model returned an empty conversation summary");
  return summary;
}
