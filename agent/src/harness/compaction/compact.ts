import type { SessionState, Turn } from "../session/types.js";

export async function compactSession(
  session: SessionState,
  keepRecentTokens: number,
  minimumRecentTurns: number,
  countTurns: (turns: Turn[]) => Promise<number>,
  summarize: (previousSummary: string | undefined, turns: Turn[]) => Promise<string>,
): Promise<boolean> {
  const previousFirstKeptTurnIndex =
    session.conversationSummary?.firstKeptTurnIndex ?? 0;
  const latestFirstKeptTurnIndex = Math.max(
    previousFirstKeptTurnIndex,
    session.turns.length - minimumRecentTurns,
  );
  let firstKeptTurnIndex = latestFirstKeptTurnIndex;

  if (
    latestFirstKeptTurnIndex > previousFirstKeptTurnIndex &&
    await countTurns(session.turns.slice(latestFirstKeptTurnIndex)) <= keepRecentTokens
  ) {
    let low = previousFirstKeptTurnIndex;
    let high = latestFirstKeptTurnIndex;
    while (low < high) {
      const candidate = Math.floor((low + high) / 2);
      if (await countTurns(session.turns.slice(candidate)) <= keepRecentTokens) {
        high = candidate;
      } else {
        low = candidate + 1;
      }
    }
    firstKeptTurnIndex = low;
  }

  if (firstKeptTurnIndex <= previousFirstKeptTurnIndex) return false;

  const summary = await summarize(
    session.conversationSummary?.content,
    session.turns.slice(previousFirstKeptTurnIndex, firstKeptTurnIndex),
  );
  session.conversationSummary = {
    content: summary,
    createdAt: new Date().toISOString(),
    firstKeptTurnIndex,
  };
  return true;
}

export async function compactIfNeeded(
  compactAtTokens: number,
  countInputTokens: () => Promise<number>,
  compact: () => Promise<boolean | void>,
): Promise<number> {
  let inputTokens = await countInputTokens();
  if (inputTokens < compactAtTokens) return inputTokens;

  if (await compact() === false) {
    throw new Error("Current request exceeds the model context budget");
  }
  inputTokens = await countInputTokens();
  if (inputTokens >= compactAtTokens) {
    throw new Error("Compacted request still exceeds the model context budget");
  }
  return inputTokens;
}
