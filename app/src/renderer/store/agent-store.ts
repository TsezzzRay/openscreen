import type { AgentStatus, ImportedAttachment } from "@shared/ipc.ts";
import type {
  ApplicationEvent,
  ProductCompactionResult,
  ProductSessionState,
  ProductSessionSummary,
  ProductSessionView,
  ProductThinkingLevel,
} from "@shared/protocol.ts";
import { sessionDisplayName } from "@shared/protocol.ts";

import {
  projectTranscript,
  restoreLocalAttachments,
  sessionToRestore,
} from "./transcript.ts";
import { AgentFailureError, type AgentGateway, AgentTransport } from "./transport.ts";
import { type ChatTurn, newTurn, toProductAttachment } from "./types.ts";

const SELECTED_SESSION_KEY = "OpenScreenSelectedSessionID";

export interface ComposerSnapshot {
  draft: string;
  pendingAttachments: ImportedAttachment[];
  attachmentError?: string | undefined;
  importsInFlight: number;
}

export interface AgentSnapshot {
  status: AgentStatus;
  sessions: ProductSessionSummary[];
  currentSessionId?: string | undefined;
  currentTitle: string;
  turns: ChatTurn[];
  activeSessionIds: string[];
  thinking: ProductThinkingLevel;
  isManagingSession: boolean;
  isUpdatingAgentState: boolean;
  isCompacting: boolean;
  compactionResult?: ProductCompactionResult | undefined;
  compactionError?: string | undefined;
  sessionError?: string | undefined;
  focusRequest: number;
  composer: ComposerSnapshot;
}

const EMPTY_COMPOSER: ComposerSnapshot = {
  draft: "",
  pendingAttachments: [],
  importsInFlight: 0,
};

const INITIAL: AgentSnapshot = {
  status: { state: "starting" },
  sessions: [],
  currentTitle: "New Chat",
  turns: [],
  activeSessionIds: [],
  thinking: "off",
  isManagingSession: false,
  isUpdatingAgentState: false,
  isCompacting: false,
  focusRequest: 0,
  composer: EMPTY_COMPOSER,
};

/**
 * The single source of interface state, ported from the Swift `ChatViewModel`.
 *
 * Session content is cached per session id so switching chats is instant and a
 * background run keeps accumulating into its own transcript while the user
 * reads another one.
 */
export class AgentStore {
  private state: AgentSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly sessionViews = new Map<string, ProductSessionView>();
  private readonly turnCache = new Map<string, ChatTurn[]>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly composers = new Map<string, ComposerSnapshot>();

  constructor(private readonly transport: AgentGateway = new AgentTransport()) {
    this.transport.onStatus((status) => this.patch({ status }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentSnapshot => this.state;

  get isSending(): boolean {
    const id = this.state.currentSessionId;
    return id !== undefined && this.state.activeSessionIds.includes(id);
  }

  // ---------------------------------------------------------------- sessions

  async restoreSessions(): Promise<void> {
    if (this.state.isManagingSession) return;
    this.patch({ isManagingSession: true });
    try {
      const sessions = await this.listSessions();
      this.patch({ sessions });
      const preferred = localStorage.getItem(SELECTED_SESSION_KEY) ?? undefined;
      const id = sessionToRestore(sessions, preferred);
      if (id !== undefined) {
        this.applyView(await this.getSession(id));
      } else {
        this.applyView(await this.createSession());
        this.patch({ sessions: await this.listSessions() });
      }
      this.patch({ sessionError: undefined });
    } catch {
      this.patch({ sessionError: "Couldn't load chats. Please try again." });
    } finally {
      this.patch({ isManagingSession: false });
    }
  }

  selectSession(id: string): void {
    if (this.state.isManagingSession || id === this.state.currentSessionId) return;
    const cached = this.sessionViews.get(id);
    // A session with a run in flight must not be re-read from disk: its
    // transcript is still being written to and the cache holds the live turns.
    if (this.state.activeSessionIds.includes(id) && cached !== undefined) {
      this.adoptSession(cached);
      return;
    }
    void this.manageSession(async () => this.applyView(await this.getSession(id)));
  }

  createNewSession(): void {
    if (this.state.isManagingSession) return;
    void this.manageSession(async () => this.applyView(await this.createSession()));
  }

  renameSession(id: string, name: string): void {
    if (this.state.isManagingSession || this.state.activeSessionIds.includes(id)) return;
    void this.manageSession(async () => {
      const event = await this.transport.collect(
        { requestId: crypto.randomUUID(), type: "rename_session", sessionId: id, name },
        "session_renamed",
      );
      this.applyRenamedSession(event.session);
    });
  }

  // ----------------------------------------------------------------- prompts

  submit(): void {
    const text = this.state.composer.draft.trim();
    const sessionId = this.state.currentSessionId;
    if (
      text.length === 0 ||
      sessionId === undefined ||
      this.state.isManagingSession ||
      this.isSending ||
      this.state.composer.importsInFlight > 0
    ) {
      return;
    }

    const turnId = crypto.randomUUID();
    const attachments = this.state.composer.pendingAttachments;
    this.setTurns(sessionId, [
      ...(this.turnCache.get(sessionId) ?? []),
      newTurn({ id: turnId, question: text, attachments, status: "capturing" }),
    ]);
    this.updateComposer(sessionId, () => EMPTY_COMPOSER);
    this.activeTurnIds.set(sessionId, turnId);
    this.patch({ activeSessionIds: [...this.state.activeSessionIds, sessionId] });

    void this.runPrompt(sessionId, turnId, text, attachments);
  }

  private async runPrompt(
    sessionId: string,
    turnId: string,
    text: string,
    attachments: ImportedAttachment[],
  ): Promise<void> {
    try {
      await this.transport.send(
        {
          requestId: turnId,
          type: "prompt",
          sessionId,
          input: {
            text,
            ...(attachments.length > 0
              ? { images: attachments.map(toProductAttachment) }
              : {}),
          },
        },
        (event) => this.applyRunEvent(event, sessionId, turnId),
      );
      try {
        this.cacheView(await this.getSession(sessionId));
        this.patch({ sessions: await this.listSessions() });
        if (this.state.currentSessionId === sessionId) {
          this.patch({ sessionError: undefined });
        }
      } catch {
        if (this.state.currentSessionId === sessionId) {
          this.patch({
            sessionError: "Couldn't refresh the completed chat. Please try again.",
          });
        }
      }
    } catch (error) {
      if (error instanceof AgentFailureError && error.aborted) {
        this.updateTurn(sessionId, turnId, (turn) => ({
          ...turn,
          status: "aborted",
          error: undefined,
        }));
      } else {
        this.updateTurn(sessionId, turnId, (turn) => ({
          ...turn,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      if (this.activeTurnIds.get(sessionId) === turnId) {
        this.activeTurnIds.delete(sessionId);
        this.patch({
          activeSessionIds: this.state.activeSessionIds.filter((id) => id !== sessionId),
        });
      }
    }
  }

  cancelCurrentRequest(): void {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined) return;
    const targetRequestId = this.activeTurnIds.get(sessionId);
    if (targetRequestId === undefined) return;
    void this.transport
      .send({ requestId: crypto.randomUUID(), type: "abort", sessionId, targetRequestId })
      .catch((error: unknown) => {
        this.patch({
          sessionError: error instanceof Error ? error.message : String(error),
        });
      });
  }

  retry(turnId: string): void {
    const turn = this.state.turns.find((item) => item.id === turnId);
    const sessionId = this.state.currentSessionId;
    if (turn === undefined || sessionId === undefined) return;
    if (turn.status !== "failed" && turn.status !== "aborted") return;
    this.updateComposer(sessionId, () => ({
      draft: turn.question,
      pendingAttachments: turn.attachments,
      importsInFlight: 0,
    }));
    this.requestInputFocus();
  }

  private applyRunEvent(
    event: ApplicationEvent,
    sessionId: string,
    turnId: string,
  ): void {
    if ("sessionId" in event && event.sessionId !== sessionId) return;

    if (event.type === "compaction_completed") {
      if (event.automatic && this.state.currentSessionId === sessionId) {
        this.patch({ compactionResult: event.result });
      }
      return;
    }

    this.updateTurn(sessionId, turnId, (turn) => {
      switch (event.type) {
        case "run_started":
          return { ...turn, status: "requesting" };
        case "reasoning_delta":
          return { ...turn, status: "generating", reasoning: turn.reasoning + event.delta };
        case "answer_delta":
          return { ...turn, status: "generating", answer: turn.answer + event.delta };
        case "answer_completed":
          return {
            ...turn,
            status: "completed",
            answer: event.answer,
            ...(event.contextUsage === undefined
              ? {}
              : { contextUsage: event.contextUsage }),
          };
        case "tool_started":
        case "tool_updated":
        case "tool_finished": {
          const status = event.type === "tool_finished" ? "finished" : "running";
          const text = "text" in event ? event.text : "";
          const isError = "isError" in event ? event.isError : false;
          const index = turn.toolActivities.findIndex(
            (activity) => activity.callId === event.callId,
          );
          const activities = [...turn.toolActivities];
          if (index >= 0) {
            const existing = activities[index]!;
            activities[index] = {
              ...existing,
              text: text.length > 0 ? text : existing.text,
              status,
              isError,
            };
          } else {
            activities.push({
              callId: event.callId,
              name: event.name,
              text,
              status,
              isError,
            });
          }
          return { ...turn, toolActivities: activities };
        }
        default:
          return turn;
      }
    });
  }

  // ------------------------------------------------------------ agent state

  async selectThinking(thinking: ProductThinkingLevel): Promise<void> {
    await this.mutateState((sessionId) =>
      this.transport
        .collect(
          { requestId: crypto.randomUUID(), type: "set_thinking", sessionId, thinking },
          "state_updated",
        )
        .then((event) => event.state),
    );
  }

  async compact(instructions?: string): Promise<void> {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined || this.state.isCompacting) return;
    this.patch({ isCompacting: true, compactionError: undefined });
    try {
      const event = await this.transport.collect(
        {
          requestId: crypto.randomUUID(),
          type: "compact",
          sessionId,
          ...(instructions === undefined ? {} : { instructions }),
        },
        "compaction_completed",
      );
      if (this.state.currentSessionId === sessionId) {
        this.patch({ compactionResult: event.result });
      }
      try {
        const view = await this.getSession(sessionId);
        if (this.state.currentSessionId === sessionId) this.applyView(view);
        else this.cacheView(view);
      } catch {
        if (this.state.currentSessionId === sessionId) {
          this.patch({
            sessionError: "Session compacted, but the chat couldn't be refreshed.",
          });
        }
      }
    } catch {
      if (this.state.currentSessionId === sessionId) {
        this.patch({ compactionError: "Compaction failed. Please try again." });
      }
    } finally {
      this.patch({ isCompacting: false });
    }
  }

  private async mutateState(
    operation: (sessionId: string) => Promise<ProductSessionState>,
  ): Promise<void> {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined || this.state.isUpdatingAgentState) return;
    this.patch({ isUpdatingAgentState: true });
    try {
      this.cacheState(sessionId, await operation(sessionId));
      if (this.state.currentSessionId === sessionId) {
        this.patch({ sessionError: undefined });
      }
    } catch {
      if (this.state.currentSessionId === sessionId) {
        this.patch({ sessionError: "Couldn't update Agent settings. Please try again." });
      }
    } finally {
      this.patch({ isUpdatingAgentState: false });
    }
  }

  // ------------------------------------------------------------- attachments

  updateDraft(draft: string): void {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined) return;
    this.updateComposer(sessionId, (composer) => ({ ...composer, draft }));
  }

  requestInputFocus(): void {
    this.patch({ focusRequest: this.state.focusRequest + 1 });
  }

  async pickAttachments(): Promise<void> {
    await this.importAttachments(() => window.openscreen.attachments.pick());
  }

  async addPastedImages(buffers: Uint8Array[]): Promise<void> {
    if (buffers.length === 0) return;
    await this.importAttachments(() =>
      window.openscreen.attachments.importBuffers(buffers),
    );
  }

  private async importAttachments(
    load: () => Promise<ImportedAttachment[]>,
  ): Promise<void> {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined) return;
    this.updateComposer(sessionId, (composer) => ({
      ...composer,
      importsInFlight: composer.importsInFlight + 1,
      attachmentError: undefined,
    }));
    try {
      const imported = await load();
      this.updateComposer(sessionId, (composer) => ({
        ...composer,
        pendingAttachments: [...composer.pendingAttachments, ...imported],
      }));
    } catch (error) {
      this.updateComposer(sessionId, (composer) => ({
        ...composer,
        attachmentError: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.updateComposer(sessionId, (composer) => ({
        ...composer,
        importsInFlight: composer.importsInFlight - 1,
      }));
    }
  }

  removeAttachment(id: string): void {
    const sessionId = this.state.currentSessionId;
    if (sessionId === undefined) return;
    let removed: ImportedAttachment | undefined;
    this.updateComposer(sessionId, (composer) => {
      removed = composer.pendingAttachments.find((item) => item.id === id);
      return {
        ...composer,
        pendingAttachments: composer.pendingAttachments.filter((item) => item.id !== id),
      };
    });
    if (removed === undefined) return;
    // Only delete the file if no turn already sent it.
    const used = [...this.turnCache.values()]
      .flat()
      .some((turn) => turn.attachments.some((item) => item.id === removed!.id));
    if (!used) void window.openscreen.attachments.remove(removed.path);
  }

  // -------------------------------------------------------------- internals

  private listSessions(): Promise<ProductSessionSummary[]> {
    return this.transport
      .collect({ requestId: crypto.randomUUID(), type: "list_sessions" }, "sessions")
      .then((event) => event.sessions);
  }

  private createSession(): Promise<ProductSessionView> {
    return this.transport
      .collect({ requestId: crypto.randomUUID(), type: "create_session" }, "session_view")
      .then((event) => event.view);
  }

  private getSession(sessionId: string): Promise<ProductSessionView> {
    return this.transport
      .collect(
        { requestId: crypto.randomUUID(), type: "get_session", sessionId },
        "session_view",
      )
      .then((event) => event.view);
  }

  private async manageSession(operation: () => Promise<void>): Promise<void> {
    this.patch({ isManagingSession: true });
    try {
      await operation();
      this.patch({ sessions: await this.listSessions(), sessionError: undefined });
    } catch {
      this.patch({ sessionError: "Couldn't update chats. Please try again." });
    } finally {
      this.patch({ isManagingSession: false });
    }
  }

  private applyView(view: ProductSessionView): void {
    if (this.state.currentSessionId !== view.session.id) this.clearTransientState();
    this.cacheView(view);
    this.adoptSession(this.sessionViews.get(view.session.id) ?? view);
  }

  private adoptSession(view: ProductSessionView): void {
    localStorage.setItem(SELECTED_SESSION_KEY, view.session.id);
    if (this.state.currentSessionId !== view.session.id) this.clearTransientState();
    this.patch({
      currentSessionId: view.session.id,
      currentTitle: sessionDisplayName(view.session),
      turns: this.turnCache.get(view.session.id) ?? [],
      thinking: view.state.thinking,
      composer: this.composers.get(view.session.id) ?? EMPTY_COMPOSER,
    });
  }

  private cacheView(view: ProductSessionView): void {
    const previous = this.turnCache.get(view.session.id) ?? [];
    const rebound = restoreLocalAttachments(projectTranscript(view.messages), previous);
    this.sessionViews.set(view.session.id, view);
    this.turnCache.set(view.session.id, rebound);
    if (this.state.currentSessionId === view.session.id) {
      this.patch({
        currentTitle: sessionDisplayName(view.session),
        turns: rebound,
        thinking: view.state.thinking,
      });
    }
  }

  private cacheState(sessionId: string, state: ProductSessionState): void {
    const view = this.sessionViews.get(sessionId);
    if (view !== undefined) this.sessionViews.set(sessionId, { ...view, state });
    if (this.state.currentSessionId === sessionId) {
      this.patch({ thinking: state.thinking });
    }
  }

  private applyRenamedSession(summary: ProductSessionSummary): void {
    const sessions = this.state.sessions.some((item) => item.id === summary.id)
      ? this.state.sessions.map((item) => (item.id === summary.id ? summary : item))
      : [...this.state.sessions, summary];
    this.patch({ sessions });
    const view = this.sessionViews.get(summary.id);
    if (view !== undefined) {
      this.sessionViews.set(summary.id, { ...view, session: summary });
    }
    if (this.state.currentSessionId === summary.id) {
      this.patch({ currentTitle: sessionDisplayName(summary) });
    }
  }

  private clearTransientState(): void {
    this.patch({ compactionResult: undefined, compactionError: undefined });
  }

  private setTurns(sessionId: string, turns: ChatTurn[]): void {
    this.turnCache.set(sessionId, turns);
    if (this.state.currentSessionId === sessionId) this.patch({ turns });
  }

  private updateTurn(
    sessionId: string,
    turnId: string,
    update: (turn: ChatTurn) => ChatTurn,
  ): void {
    const turns = this.turnCache.get(sessionId);
    if (turns === undefined) return;
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    const next = [...turns];
    next[index] = update(turns[index]!);
    this.setTurns(sessionId, next);
  }

  private updateComposer(
    sessionId: string,
    update: (composer: ComposerSnapshot) => ComposerSnapshot,
  ): void {
    const composer = update(this.composers.get(sessionId) ?? EMPTY_COMPOSER);
    this.composers.set(sessionId, composer);
    if (this.state.currentSessionId === sessionId) this.patch({ composer });
  }

  private patch(patch: Partial<AgentSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
