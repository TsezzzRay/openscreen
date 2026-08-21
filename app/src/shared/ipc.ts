import type {
  ApplicationCommand,
  ApplicationEvent,
  ProductImageMimeType,
} from "./protocol.ts";

/** A command without its `requestId`; the renderer supplies that separately. */
export type AgentCommand = ApplicationCommand;

/** One runtime stdout line, still carrying its correlation id. */
export interface AgentEventEnvelope {
  requestId: string;
  event: ApplicationEvent;
}

export type AgentStatus =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "stopped"; message: string };

export interface ImportedAttachment {
  id: string;
  path: string;
  mimeType: ProductImageMimeType;
  /** Custom-scheme URL the renderer can put in an <img src>. */
  url: string;
}

export type OverlayMode = "collapsed" | "expanded";

export const IPC = {
  agentSend: "agent:send",
  agentEvent: "agent:event",
  agentStatus: "agent:status",
  attachmentsPick: "attachments:pick",
  attachmentsImport: "attachments:import",
  attachmentsRemove: "attachments:remove",
  overlayResize: "overlay:resize",
  overlayHide: "overlay:hide",
  overlayFocusRequested: "overlay:focus-requested",
  windowOpenMain: "window:open-main",
} as const;
