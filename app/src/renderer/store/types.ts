import type { ImportedAttachment } from "@shared/ipc.ts";
import type { ProductApprovalTarget, ProductImageAttachment } from "@shared/protocol.ts";

export type TurnStatus =
  | "capturing"
  | "requesting"
  | "generating"
  | "awaiting-approval"
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

export interface ApprovalActivity {
  id: string;
  callId: string;
  tool: "bash" | "write" | "edit" | "desktop_click" | "desktop_scroll" | "desktop_type";
  target: ProductApprovalTarget;
  status: "pending" | "approved" | "denied" | "committed";
}

export interface ContextUsage {
  contextTokens: number;
  contextWindow: number;
}

export interface ChatTurn {
  id: string;
  /** Renderer-local binding to the persisted user message, not a new protocol ID. */
  transcriptId?: string | undefined;
  question: string;
  attachments: ImportedAttachment[];
  /** Images already in the persisted transcript, which have no local file. */
  historicalImageCount: number;
  reasoning: string;
  answer: string;
  toolActivities: ToolActivity[];
  approvals: ApprovalActivity[];
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
    approvals: [],
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
  return status === "capturing" || status === "requesting" || status === "generating" || status === "awaiting-approval";
}
