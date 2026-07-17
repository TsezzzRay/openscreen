import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import OpenAI from "openai";

const instructions = `You are OpenScreen, a screen-aware assistant.

Answer the user's question using the attached screenshot.
Reply in the same language as the user.
Be direct and concise.
If the answer cannot be determined from the screenshot, say so.
Do not claim that you clicked, typed, changed, or executed anything.`;

type InputEnvelope = {
  requestId: string;
  input: {
    text: string;
    image: string;
  };
};

export type Turn = {
  user: string;
  assistant: string;
};

export type ModelEvent = {
  type: string;
  delta?: string;
  message?: string;
  response?: { error?: { message?: string } | null };
};

export type OutputEnvelope = {
  requestId: string;
  type: "started" | "reasoning_delta" | "answer_delta" | "completed" | "failed";
  delta?: string;
  message?: string;
};

export function getModel(env: NodeJS.ProcessEnv = process.env) {
  const model = env.OPENAI_MODEL?.trim();
  if (!model) throw new Error("OPENAI_MODEL is required");
  return model;
}

export function makeRequest(
  model: string,
  text: string,
  imageBase64: string,
  turns: Turn[] = [],
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const imageURL = `data:image/png;base64,${imageBase64}`;
  const isMiniMaxM3 = model.toLowerCase() === "minimax-m3";
  const image = (isMiniMaxM3
    ? {
        type: "input_image",
        image_url: { url: imageURL, detail: "default" },
      }
    : {
        type: "input_image",
        detail: "auto",
        image_url: imageURL,
      }) as unknown as OpenAI.Responses.ResponseInputImage;

  return {
    model,
    instructions,
    input: [
      ...turns.flatMap((turn) => [
        { role: "user" as const, content: turn.user },
        { role: "assistant" as const, content: turn.assistant },
      ]),
      {
        role: "user",
        content: [
          { type: "input_text", text },
          image,
        ],
      },
    ],
    reasoning: isMiniMaxM3 ? { effort: "minimal" } : { summary: "auto" },
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

function emit(event: OutputEnvelope) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function relayStream(
  requestId: string,
  stream: AsyncIterable<ModelEvent>,
  send: (event: OutputEnvelope) => void,
): Promise<string | null> {
  let output = "";
  let completed = false;

  for await (const modelEvent of stream) {
    if (
      modelEvent.type === "response.output_text.delta" ||
      modelEvent.type === "response.refusal.delta"
    ) {
      output += modelEvent.delta ?? "";
    }
    if (modelEvent.type === "response.completed") {
      completed = true;
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

  send({ requestId, type: "completed" });
  return output;
}

async function run() {
  const client = new OpenAI();
  const model = getModel();
  const turns: Turn[] = [];
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    const { requestId, input } = JSON.parse(line) as InputEnvelope;
    emit({ requestId, type: "started" });
    try {
      const imageBase64 = (await readFile(input.image)).toString("base64");
      const stream = await client.responses.create(
        makeRequest(model, input.text, imageBase64, turns),
      );
      const output = await relayStream(requestId, stream, emit);
      if (output !== null) turns.push({ user: input.text, assistant: output });
    } catch (error) {
      emit({
        requestId,
        type: "failed",
        message: error instanceof Error ? error.message : "Model request failed",
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
