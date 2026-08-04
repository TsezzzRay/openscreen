import { loadSession } from "../../session/store.js";
import type { ActivitySource } from "./types.js";

export async function loadSessionActivitySources(
  sessionsDirectory: string,
  sessionId: string,
  { includeInterrupted = true }: { includeInterrupted?: boolean } = {},
): Promise<ActivitySource[]> {
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
