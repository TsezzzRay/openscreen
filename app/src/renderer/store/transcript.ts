import type { ProductTranscriptMessage } from "@shared/protocol.ts";

import { type ChatTurn, isTurnInFlight, newTurn } from "./types.ts";

/**
 * Folds the runtime's flat transcript into the turn shape the interface
 * renders. Assistant and tool messages attach to the preceding user message;
 * `context` messages are injected background material and stay hidden.
 */
export function projectTranscript(messages: ProductTranscriptMessage[]): ChatTurn[] {
  const result: ChatTurn[] = [];
  const current = (id: string): ChatTurn => {
    if (result.length === 0) result.push(newTurn({ id }));
    return result[result.length - 1]!;
  };

  for (const message of messages) {
    switch (message.role) {
      case "user":
        result.push(
          newTurn({
            id: message.id,
            transcriptId: message.id,
            question: message.text,
            historicalImageCount: message.imageCount ?? 0,
          }),
        );
        break;
      case "assistant": {
        const turn = current(message.id);
        turn.reasoning += message.reasoning ?? "";
        turn.answer += message.text;
        if (message.isError === true) {
          turn.status = "failed";
          turn.error = "The previous Agent run did not complete.";
        }
        break;
      }
      case "tool": {
        const turn = current(message.id);
        turn.toolActivities.push({
          callId: message.id,
          name: message.toolName ?? "tool",
          text: message.text,
          status: "finished",
          isError: message.isError ?? false,
        });
        break;
      }
      case "context":
        break;
    }
  }
  return result;
}

/** Preserve request identity and live decisions across a Session projection refresh. */
export function restoreLiveTurnState(restored: ChatTurn[], previous: ChatTurn[]): ChatTurn[] {
  const available = [...previous];
  const result = [...restored];
  const persistedIds = new Set(restored.map(turn => turn.id));
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const turn = result[index]!;
    let candidate = available.findIndex(live => (live.transcriptId ?? live.id) === turn.id);
    if (candidate < 0) {
      candidate = available.length - 1;
      while (candidate >= 0 && (available[candidate]!.transcriptId !== undefined ||
        persistedIds.has(available[candidate]!.id) || available[candidate]!.question !== turn.question)) candidate -= 1;
    }
    if (candidate < 0) continue;
    const [match] = available.splice(candidate, 1);
    const live = match!;
    result[index] = {
      ...turn,
      id: live.id,
      transcriptId: turn.id,
      attachments: turn.attachments.length > 0 ? turn.attachments : live.attachments,
      approvals: live.approvals,
      ...(live.status === "aborted" || live.status === "failed"
        ? { status: live.status, error: live.error } : {}),
    };
  }
  // Cancellation can precede writing the user message. Keep the live turn so
  // the terminal event can still be correlated even if the file has no entry.
  for (const live of available.filter(turn => isTurnInFlight(turn.status) || turn.status === "aborted" || turn.status === "failed")) {
    const following = new Set(previous.slice(previous.indexOf(live) + 1).map(turn => turn.id));
    const next = result.findIndex(turn => following.has(turn.id));
    result.splice(next < 0 ? result.length : next, 0, live);
  }
  return result;
}

export function sessionToRestore(
  sessions: { id: string }[],
  preferredId: string | undefined,
): string | undefined {
  if (preferredId !== undefined && sessions.some((s) => s.id === preferredId)) {
    return preferredId;
  }
  return sessions[0]?.id;
}
