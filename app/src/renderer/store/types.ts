import type { ImportedAttachment } from "@shared/ipc.ts";
import type { ProductImageAttachment } from "@shared/protocol.ts";

export type TurnStatus =
  | "capturing"
  | "requesting"
  | "generating"
  | "completed"
  | "failed"
  | "aborted";

export interface ToolActivity {
  callId: string;
  name: string;
  text: string;
  status: "running" | "finished";
  isError: boolean;
}

export interface ContextUsage {
  contextTokens: number;
  contextWindow: number;
}

export interface ChatTurn {
  id: string;
  question: string;
  attachments: ImportedAttachment[];
  /** Images already in the persisted transcript, which have no local file. */
  historicalImageCount: number;
  reasoning: string;
  answer: string;
  toolActivities: ToolActivity[];
  contextUsage?: ContextUsage | undefined;
  status: TurnStatus;
  error?: string | undefined;
}

export function newTurn(partial: Partial<ChatTurn> & { id: string }): ChatTurn {
  return {
    question: "",
    attachments: [],
    historicalImageCount: 0,
    reasoning: "",
    answer: "",
    toolActivities: [],
    status: "completed",
    ...partial,
  };
}

export function toProductAttachment(
  attachment: ImportedAttachment,
): ProductImageAttachment {
  return { path: attachment.path, mimeType: attachment.mimeType };
}

export function isTurnInFlight(status: TurnStatus): boolean {
  return status === "capturing" || status === "requesting" || status === "generating";
}
