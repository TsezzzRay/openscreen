import type { ActiveRun, AgentEventEnvelope } from "@shared/ipc.ts";
import type { ApplicationCommand } from "@shared/protocol.ts";

/**
 * Commands whose completion changes what the chat list shows.
 *
 * A prompt is here because a chat with no explicit name takes its display name
 * from its first question, so the turn that starts a chat also renames it.
 */
const INVENTORY_COMMANDS = new Set<ApplicationCommand["type"]>([
  "create_session",
  "rename_session",
  "prompt",
]);

export interface SessionHubOptions {
  /** The runs currently in flight, whenever that set changes. */
  onRuns: (runs: ActiveRun[]) => void;
  /** The chat list is stale and every window should re-read it. */
  onSessionsChanged: () => void;
  now?: () => Date;
}

/**
 * What the two windows have to agree on, derived by watching the traffic that
 * already passes through the main process.
 *
 * Each renderer owns its own transcript state and only claims the events for
 * requests it issued, so without this a run started in the overlay is invisible
 * to the main window — its submit button stays live, nothing there can stop the
 * run — and a chat created in one window never appears in the other. The main
 * process forwards every command and every event, so it can derive both facts
 * by observation alone: the runtime needs no new protocol, and neither surface
 * has to report what it is doing.
 *
 * Chat *selection* is deliberately not here. The two surfaces are used for
 * different things at the same moment, so each keeps its own.
 */
export class SessionHub {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly inventoryRequests = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: SessionHubOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get activeRuns(): ActiveRun[] {
    return [...this.runs.values()];
  }

  /** Opens a run, and notes the commands worth re-reading the list after. */
  observeCommand(command: ApplicationCommand): void {
    if (INVENTORY_COMMANDS.has(command.type)) {
      this.inventoryRequests.add(command.requestId);
    }
    if (command.type !== "prompt") return;
    this.runs.set(command.requestId, {
      sessionId: command.sessionId,
      requestId: command.requestId,
      text: command.input.text,
      startedAt: this.now().toISOString(),
    });
    this.options.onRuns(this.activeRuns);
  }

  /**
   * Settles a request on its terminal event. Every request produces exactly one
   * of these. A failed request invalidates the list too: a prompt can append its
   * question — and so name the chat — before whatever failed it.
   */
  observeEvent(envelope: AgentEventEnvelope): void {
    const { type } = envelope.event;
    if (type !== "completed" && type !== "failed") return;
    if (this.runs.delete(envelope.requestId)) {
      this.options.onRuns(this.activeRuns);
    }
    if (this.inventoryRequests.delete(envelope.requestId)) {
      this.options.onSessionsChanged();
    }
  }

  /**
   * Drops every request without a terminal event. The runtime child owns all
   * run state, so when it stops there is nothing left to finish or abort.
   */
  clear(): void {
    this.inventoryRequests.clear();
    if (this.runs.size === 0) return;
    this.runs.clear();
    this.options.onRuns(this.activeRuns);
  }
}
