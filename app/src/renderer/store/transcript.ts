import type { ProductTranscriptMessage } from "@shared/protocol.ts";

import { type ChatTurn, newTurn } from "./types.ts";

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

/**
 * A reloaded transcript reports only how many images a turn carried, not where
 * they live. Re-attach the local files from the copy held before the reload by
 * matching question text from the newest turn backwards, so each local set is
 * claimed at most once.
 */
export function restoreLocalAttachments(
  restored: ChatTurn[],
  previous: ChatTurn[],
): ChatTurn[] {
  const available = previous
    .map((turn, index) => ({ turn, index }))
    .filter((entry) => entry.turn.attachments.length > 0);

  const result = [...restored];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const turn = result[index]!;
    if (turn.attachments.length > 0) continue;
    let matchIndex = -1;
    for (let candidate = available.length - 1; candidate >= 0; candidate -= 1) {
      if (available[candidate]!.turn.question === turn.question) {
        matchIndex = candidate;
        break;
      }
    }
    if (matchIndex < 0) continue;
    const [match] = available.splice(matchIndex, 1);
    result[index] = { ...turn, attachments: match!.turn.attachments };
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
