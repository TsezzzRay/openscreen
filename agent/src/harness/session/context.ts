import { readFile } from "node:fs/promises";

import OpenAI from "openai";

import {
  type ChatImage,
  type SessionState,
  type Turn,
} from "./types.js";

const instructions = `You are OpenScreen, a screen-aware assistant.

Answer the user's question using the attached screenshots.
The first image is the current window captured by OpenScreen. Any remaining images were uploaded by the user.
Reply in the same language as the user.
Be direct and concise.
If the answer cannot be determined from the screenshot, say so.
Do not claim that you clicked, typed, changed, or executed anything.`;

export type LoadScreenshot = (path: string) => Promise<string>;

export const loadScreenshot: LoadScreenshot = async (path) => (
  await readFile(path)
).toString("base64");

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
  images: ChatImage[],
  readScreenshot: LoadScreenshot,
): Promise<OpenAI.Responses.ResponseInputItem> {
  return {
    role: "user",
    content: [
      { type: "input_text", text },
      ...await Promise.all(images.map(async (image) => (
        imagePart(model, await readScreenshot(image.path))
      ))),
    ],
  };
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

export async function buildTurnsInput(
  model: string,
  turns: Turn[],
  readScreenshot: LoadScreenshot,
  preserveOutputItems = true,
): Promise<OpenAI.Responses.ResponseInput> {
  return (await Promise.all(turns.map(async (turn) => [
    await userInput(model, turn.user, turn.images ?? [], readScreenshot),
    ...(preserveOutputItems && (turn.status ?? "completed") === "completed" &&
        turn.outputItems?.length
      ? turn.outputItems
      : [{ role: "assistant" as const, content: turnOutput(turn) }]),
  ]))).flat();
}

export async function makeRequest(
  model: string,
  text: string,
  images: ChatImage[],
  maxOutputTokens: number,
  session: SessionState = { turns: [] },
  readScreenshot: LoadScreenshot = loadScreenshot,
): Promise<OpenAI.Responses.ResponseCreateParamsStreaming> {
  const isMiniMaxM3 = model.toLowerCase() === "minimax-m3";
  const retainedInput = await buildTurnsInput(
    model,
    session.turns.slice(session.conversationSummary?.firstKeptTurnIndex ?? 0),
    readScreenshot,
  );

  return {
    model,
    instructions,
    input: [
      ...(session.conversationSummary
        ? [{
            role: "developer" as const,
            content: `Conversation summary:\n${session.conversationSummary.content}`,
          }]
        : []),
      ...retainedInput,
      await userInput(model, text, images, readScreenshot),
    ],
    reasoning: isMiniMaxM3 ? { effort: "minimal" } : { summary: "auto" },
    max_output_tokens: maxOutputTokens,
    stream: true,
  };
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
      input: await buildTurnsInput(model, turns, readScreenshot),
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
      tools: request.tools,
    }, { signal })
  ).input_tokens;
}
