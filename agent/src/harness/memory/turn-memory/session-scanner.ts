import { loadSession } from "../../session/store.js";
import type { TurnMemorySource } from "./types.js";

export async function loadSessionTurnMemorySources(
  sessionsDirectory: string,
  sessionId: string,
  { includeInterrupted = true }: { includeInterrupted?: boolean } = {},
): Promise<TurnMemorySource[]> {
  const session = await loadSession(sessionsDirectory, sessionId);
  return session.recordedTurns
    .filter(({ status }) => includeInterrupted || status !== "interrupted")
    .map((turn) => ({
      sourceId: `turn:${sessionId}:${turn.id}`,
      occurredAt: turn.finishedAt,
      turn,
      agentRuns: session.agentRuns.filter(({ turnId }) => turnId === turn.id),
    }));
}
