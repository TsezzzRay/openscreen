import type OpenAI from "openai";

export type Turn = {
  user: string;
  assistant: string;
  screenshotPath: string;
  outputItems?: Array<
    OpenAI.Responses.ResponseReasoningItem | OpenAI.Responses.ResponseOutputMessage
  >;
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
