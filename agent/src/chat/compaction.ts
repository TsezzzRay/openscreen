import type { SessionState, Turn } from "../session/store.js";

const MIN_RECENT_TURNS = 2;

export async function compactSession(
  session: SessionState,
  keepRecentTokens: number,
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
    await countTurns(session.turns.slice(latestFirstKeptTurnIndex)) <= keepRecentTokens
  ) {
    let low = session.firstKeptTurnIndex;
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
