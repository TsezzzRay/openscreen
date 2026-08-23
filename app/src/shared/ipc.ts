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

/**
 * A prompt the runtime is working on right now, as seen by the main process.
 *
 * The main process sits between every window and the runtime, so it can derive
 * this from traffic it already forwards: a `prompt` command opens a run and that
 * request's terminal event closes it. Windows share it so a run started in one
 * surface is visible — and stoppable — from the other. `text` is carried because
 * the event stream alone never repeats the question.
 */
export interface ActiveRun {
  sessionId: string;
  requestId: string;
  text: string;
  startedAt: string;
}

export const IPC = {
  agentSend: "agent:send",
  agentEvent: "agent:event",
  agentStatus: "agent:status",
  attachmentsPick: "attachments:pick",
  attachmentsImport: "attachments:import",
  attachmentsRemove: "attachments:remove",
  overlayResize: "overlay:resize",
  overlayHide: "overlay:hide",
  sessionRuns: "session:runs",
  sessionRunsGet: "session:runs-get",
  // The chat inventory changed somewhere. Both windows re-read the list; the
  // payload would only be a copy of what `list_sessions` already returns.
  sessionsInvalidated: "session:invalidated",
  // Both surfaces answer this: the hotkey routes it to whichever one the user
  // is meant to type into.
  focusComposer: "window:focus-composer",
  windowOpenMain: "window:open-main",
} as const;
