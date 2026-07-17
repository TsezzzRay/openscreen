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
  input: {
    text: string;
    image: string;
  };
};

export type Turn = {
  user: string;
  assistant: string;
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
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages: [
      { role: "system", content: instructions },
      ...turns.flatMap((turn) => [
        { role: "user" as const, content: turn.user },
        { role: "assistant" as const, content: turn.assistant },
      ]),
      {
        role: "user",
        content: [
          { type: "text", text },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    stream: false,
  };
}

async function run() {
  const client = new OpenAI();
  const model = getModel();
  const turns: Turn[] = [];
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    const { input } = JSON.parse(line) as InputEnvelope;
    const imageBase64 = (await readFile(input.image)).toString("base64");
    const response = await client.chat.completions.create(
      makeRequest(model, input.text, imageBase64, turns),
    );
    const output = response.choices[0]?.message.content ?? "";
    turns.push({ user: input.text, assistant: output });
    process.stdout.write(`${JSON.stringify({ output })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
