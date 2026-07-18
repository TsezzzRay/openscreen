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

export type SessionState = {
  turns: Turn[];
  summary?: string;
  firstKeptTurnIndex: number;
};

export const CONTEXT_WINDOW_TOKENS = 272_000;
export const COMPACT_AT_TOKENS = 244_800;
export const KEEP_RECENT_TOKENS = 20_000;
export const MAX_OUTPUT_TOKENS = Math.floor(
  (CONTEXT_WINDOW_TOKENS - COMPACT_AT_TOKENS) * 0.8,
);
const MIN_RECENT_TURNS = 2;

export type ModelEvent = {
  type: string;
  delta?: string;
  message?: string;
  response?: {
    error?: { message?: string } | null;
    usage?: { total_tokens?: number } | null;
  };
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
  session: SessionState = { turns: [], firstKeptTurnIndex: 0 },
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
      ...(session.summary
        ? [{ role: "developer" as const, content: `Conversation summary:\n${session.summary}` }]
        : []),
      ...session.turns.slice(session.firstKeptTurnIndex).flatMap((turn) => [
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
    max_output_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
  };
}

export async function compactSession(
  session: SessionState,
  countTurns: (turns: Turn[]) => Promise<number>,
  summarize: (previousSummary: string | undefined, turns: Turn[]) => Promise<string>,
): Promise<boolean> {
  const latestFirstKeptTurnIndex = Math.max(
    session.firstKeptTurnIndex,
    session.turns.length - MIN_RECENT_TURNS,
  );
  let firstKeptTurnIndex = latestFirstKeptTurnIndex;

  if (
    latestFirstKeptTurnIndex > session.firstKeptTurnIndex &&
    await countTurns(session.turns.slice(latestFirstKeptTurnIndex)) <= KEEP_RECENT_TOKENS
  ) {
    let low = session.firstKeptTurnIndex;
    let high = latestFirstKeptTurnIndex;
    while (low < high) {
      const candidate = Math.floor((low + high) / 2);
      if (await countTurns(session.turns.slice(candidate)) <= KEEP_RECENT_TOKENS) {
        high = candidate;
      } else {
        low = candidate + 1;
      }
    }
    firstKeptTurnIndex = low;
  }

  if (firstKeptTurnIndex <= session.firstKeptTurnIndex) return false;

  const summary = await summarize(
    session.summary,
    session.turns.slice(session.firstKeptTurnIndex, firstKeptTurnIndex),
  );
  session.summary = summary;
  session.firstKeptTurnIndex = firstKeptTurnIndex;
  return true;
}

export async function compactIfNeeded(
  countInputTokens: () => Promise<number>,
  compact: () => Promise<boolean | void>,
): Promise<number> {
  let inputTokens = await countInputTokens();
  if (inputTokens < COMPACT_AT_TOKENS) return inputTokens;

  if (await compact() === false) {
    throw new Error("Current request exceeds the model context budget");
  }
  inputTokens = await countInputTokens();
  if (inputTokens >= COMPACT_AT_TOKENS) {
    throw new Error("Compacted request still exceeds the model context budget");
  }
  return inputTokens;
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
): Promise<{ output: string; totalTokens?: number } | null> {
  let output = "";
  let completed = false;
  let totalTokens: number | undefined;

  for await (const modelEvent of stream) {
    if (
      modelEvent.type === "response.output_text.delta" ||
      modelEvent.type === "response.refusal.delta"
    ) {
      output += modelEvent.delta ?? "";
    }
    if (modelEvent.type === "response.completed") {
      completed = true;
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

  send({ requestId, type: "completed" });
  return { output, totalTokens };
}

function textInput(turns: Turn[]): OpenAI.Responses.ResponseInput {
  return turns.flatMap((turn) => [
    { role: "user" as const, content: turn.user },
    { role: "assistant" as const, content: turn.assistant },
  ]);
}

async function summarizeTurns(
  client: OpenAI,
  model: string,
  previousSummary: string | undefined,
  turns: Turn[],
): Promise<string> {
  const response = await client.responses.create({
    model,
    instructions: `Summarize the earlier conversation concisely. Preserve only information needed for future turns: user intent, confirmed facts, decisions, and unfinished requests. Do not describe the summarization process.`,
    input: [
      ...(previousSummary
        ? [{ role: "developer" as const, content: `Previous summary:\n${previousSummary}` }]
        : []),
      {
        role: "user",
        content: turns
          .map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`)
          .join("\n\n"),
      },
    ],
    max_output_tokens: 4_096,
  });
  const summary = response.output_text.trim();
  if (!summary) throw new Error("Model returned an empty conversation summary");
  return summary;
}

async function run() {
  const client = new OpenAI();
  const model = getModel();
  const session: SessionState = { turns: [], firstKeptTurnIndex: 0 };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const countTurns = async (turns: Turn[]) => (
    await client.responses.inputTokens.count({ model, input: textInput(turns) })
  ).input_tokens;
  const compact = () => compactSession(
    session,
    countTurns,
    (previousSummary, turns) => summarizeTurns(
      client,
      model,
      previousSummary,
      turns,
    ),
  );

  for await (const line of lines) {
    const { requestId, input } = JSON.parse(line) as InputEnvelope;
    emit({ requestId, type: "started" });
    try {
      const imageBase64 = (await readFile(input.image)).toString("base64");
      const buildRequest = () => makeRequest(model, input.text, imageBase64, session);
      await compactIfNeeded(async () => {
        const request = buildRequest();
        return (
          await client.responses.inputTokens.count({
            model: request.model,
            instructions: request.instructions,
            input: request.input,
            reasoning: request.reasoning,
          })
        ).input_tokens;
      }, compact);
      const stream = await client.responses.create(
        buildRequest(),
      );
      const result = await relayStream(requestId, stream, emit);
      if (result !== null) {
        session.turns.push({ user: input.text, assistant: result.output });
        if ((result.totalTokens ?? 0) >= COMPACT_AT_TOKENS) {
          try {
            await compact();
          } catch (error) {
            process.stderr.write(
              `Turn-end compaction deferred: ${error instanceof Error ? error.message : "unknown error"}\n`,
            );
          }
        }
      }
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
