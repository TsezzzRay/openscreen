import OpenAI from "openai";

import {
  buildTurnsInput,
  loadScreenshot,
  type LoadScreenshot,
} from "../session/context.js";
import type { Turn } from "../session/types.js";

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
      ...await buildTurnsInput(model, turns, readScreenshot, false),
    ],
    max_output_tokens: maxOutputTokens,
  }, { signal });
  const summary = response.output_text.trim();
  if (!summary) throw new Error("Model returned an empty conversation summary");
  return summary;
}
