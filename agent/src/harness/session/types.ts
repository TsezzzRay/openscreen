import type { ConversationOutputItem } from "../../types.js";

export type ChatImage = {
  id: string;
  source: "system_capture" | "user_upload";
  path: string;
};

export type Turn = {
  id?: string;
  user: string;
  assistant: string;
  reasoning?: string;
  images?: ChatImage[];
  screenshotPath?: string;
  status?: "completed" | "failed" | "cancelled";
  outputItems?: ConversationOutputItem[];
};

export type SessionState = {
  turns: Turn[];
  summary?: string;
  firstKeptTurnIndex: number;
};

export function turnImages(
  turn: Pick<Turn, "images" | "screenshotPath">,
): ChatImage[] {
  if (turn.images) return turn.images;
  return turn.screenshotPath
    ? [{ id: "legacy-system", source: "system_capture", path: turn.screenshotPath }]
    : [];
}
