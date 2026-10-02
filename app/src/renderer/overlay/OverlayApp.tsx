import { List } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AttachmentStrip } from "../components/AttachmentStrip.tsx";
import { ApprovalPanel } from "../components/ApprovalPanel.tsx";
import { CaptureDot } from "../components/CaptureDot.tsx";
import { Composer } from "../components/Composer.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { Kbd } from "../components/Kbd.tsx";
import { TurnView } from "../components/TurnView.tsx";
import { useAgent, useIsSending, useStore } from "../store/context.tsx";
import { isTurnInFlight } from "../store/types.ts";
import { shouldCopyAnswer } from "./copy-shortcut.ts";
import { SessionList } from "./SessionList.tsx";

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * The overlay is a command bar with the conversation kept underneath it.
 *
 * The window has one fixed size in every state, so the bar never moves and
 * nothing reflows while an answer streams in; the conversation scrolls inside
 * the middle of the panel. Idle, it shows where the current chat left off so a
 * follow-up needs no context switch. Renaming, compaction, and Agent settings
 * stay in the main window where there is room to show what they did.
 */
export function OverlayApp(): React.ReactNode {
  const store = useStore();
  const state = useAgent();
  const isSending = useIsSending();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSessions, setShowSessions] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void store.refreshApprovals(); }, [store]);

  const latest = state.turns[state.turns.length - 1];
  const latestAnswer = [...state.turns].reverse().find((turn) => turn.answer.length > 0)?.answer;
  const contextUsage = [...state.turns].reverse().find((turn) => turn.contextUsage !== undefined)
    ?.contextUsage;
  const hasTranscript = state.turns.some(
    (turn) =>
      turn.question.length > 0 || turn.answer.length > 0 ||
      turn.toolActivities.length > 0,
  );

  // Follow the newest content while the reader is already at the bottom, and
  // leave them alone when they have scrolled up to read something.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.turns, showSessions]);

  useEffect(() => {
    return window.openscreen.window.onFocusComposer(() =>
      store.requestInputFocus(),
    );
  }, [store]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyAnswer = useCallback(() => {
    if (latestAnswer === undefined) return;
    void navigator.clipboard.writeText(latestAnswer).then(() => setCopied(true));
  }, [latestAnswer]);

  const newChat = useCallback(() => {
    setShowSessions(false);
    setHistoryIndex(-1);
    store.createNewSession();
    store.requestInputFocus();
  }, [store]);

  const toggleSessions = useCallback(() => {
    setShowSessions((open) => {
      // The list is kept current by the main process; this is the user-reachable
      // way to force a re-read if that ever falls behind.
      if (!open) void store.refreshSessions();
      return !open;
    });
  }, [store]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape unwinds one layer at a time, so nothing on screen becomes
        // unreachable: the picker first, then a run in progress, then the panel.
        if (showSessions) setShowSessions(false);
        else if (isSending) store.cancelCurrentRequest();
        else window.openscreen.overlay.hide();
        return;
      }
      if (!event.metaKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        window.openscreen.shell.openMainWindow();
      } else if (event.key === "n" && !state.isManagingSession) {
        event.preventDefault();
        newChat();
      } else if (event.key === "o") {
        event.preventDefault();
        toggleSessions();
      } else if (event.key === "c") {
        const field = document.activeElement;
        const fieldSelectionLength =
          field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
            ? (field.selectionEnd ?? 0) - (field.selectionStart ?? 0)
            : 0;
        if (
          shouldCopyAnswer({
            pageSelection: window.getSelection()?.toString() ?? "",
            fieldSelectionLength,
            answer: latestAnswer,
          })
        ) {
          event.preventDefault();
          copyAnswer();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copyAnswer, isSending, latestAnswer, newChat, showSessions, state.isManagingSession, store, toggleSessions]);

  const recall = useCallback(
    (direction: -1 | 1) => {
      const questions = state.turns
        .map((turn) => turn.question)
        .filter((question) => question.length > 0);
      if (questions.length === 0) return;
      const next = Math.min(
        questions.length - 1,
        Math.max(-1, historyIndex + (direction === -1 ? 1 : -1)),
      );
      setHistoryIndex(next);
      store.updateDraft(next < 0 ? "" : questions[questions.length - 1 - next]!);
    },
    [historyIndex, state.turns, store],
  );

  const submit = useCallback(() => {
    setHistoryIndex(-1);
    setShowSessions(false);
    atBottom.current = true;
    store.submit();
  }, [store]);

  const stopped = state.status.state === "stopped";
  const canSubmit = !stopped && state.composer.draft.trim().length > 0;

  const primary: { label: string; keys: string[]; run: (() => void) | undefined } = showSessions
    ? { label: "Open chat", keys: ["↵"], run: undefined }
    : !isSending && latestAnswer !== undefined && !canSubmit
      ? { label: copied ? "Copied" : "Copy answer", keys: ["⌘", "C"], run: copyAnswer }
      : { label: "Ask", keys: ["↵"], run: canSubmit && !isSending ? submit : undefined };

  return (
    <div className="glass-edge flex h-full flex-col overflow-hidden rounded-[var(--radius-window)] border border-edge bg-glass">
      <div className="drag-region flex shrink-0 items-start gap-3 px-[18px] pb-3.5 pt-[18px]">
        <span className="flex h-7 items-center">
          <CaptureDot
            status={state.status}
            attaching={latest !== undefined && latest.status === "capturing"}
          />
        </span>
        <Composer
          value={state.composer.draft}
          placeholder={
            stopped
              ? "The agent stopped — restart OpenScreen"
              : hasTranscript
                ? "Ask a follow-up or something new…"
                : "Ask about this screen…"
          }
          disabled={stopped || state.isManagingSession}
          focusRequest={state.focusRequest}
          onChange={(value) => {
            setHistoryIndex(-1);
            store.updateDraft(value);
          }}
          onSubmit={submit}
          onPasteImages={(buffers) => void store.addPastedImages(buffers)}
          onHistory={showSessions ? undefined : recall}
          className="text-display"
        />
        <span className="no-drag flex h-7 shrink-0 items-center">
          {isSending ? (
            <button
              type="button"
              onClick={() => store.cancelCurrentRequest()}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-body text-ink-dim transition-colors hover:text-ink"
            >
              Stop <Kbd keys={["esc"]} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => window.openscreen.shell.openMainWindow()}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-body text-ink-dim transition-colors hover:text-ink"
            >
              Main window <Kbd keys={["⌘", "↵"]} />
            </button>
          )}
        </span>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="compact flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-edge-soft px-3.5 py-3.5"
      >
        <ApprovalPanel requests={state.approvals} sessions={state.sessions} decisionsInFlight={state.approvalDecisionsInFlight} error={state.approvalError} onDecide={(id, approved) => void store.decideApproval(id, approved)} />

        {state.composer.pendingAttachments.length === 0 ? null : (
          <AttachmentStrip
            attachments={state.composer.pendingAttachments}
            onRemove={(id) => store.removeAttachment(id)}
          />
        )}

        {showSessions ? (
          <SessionList
            sessions={state.sessions}
            currentSessionId={state.currentSessionId}
            activeSessionIds={state.activeSessionIds}
            onSelect={(id) => {
              setShowSessions(false);
              setHistoryIndex(-1);
              atBottom.current = true;
              store.selectSession(id);
              store.requestInputFocus();
            }}
          />
        ) : hasTranscript || isSending ? (
          state.turns.map((turn, index) => (
            <div
              key={turn.id}
              // Earlier turns step back so the latest exchange reads first.
              className={index === state.turns.length - 1 ? "" : "opacity-55 transition-opacity hover:opacity-100"}
            >
              <TurnView turn={turn} compact onRetry={(id) => store.retry(id)} />
            </div>
          ))
        ) : (
          <div className="m-auto max-w-[420px] text-center">
            <p className="text-ui text-ink">Ask about the window you are working in.</p>
            <p className="mt-1 text-body text-ink-dim">
              The current screen is attached to each question you send.
            </p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-4 px-[18px] pb-1 pt-2 text-caption">
        <span className={`min-w-0 truncate ${stopped ? "text-alert" : "text-ink-faint"}`}>
          {state.status.state === "stopped"
            ? state.status.message
            : latest !== undefined && isTurnInFlight(latest.status)
              ? `${state.currentTitle} · the current screen is attached to this question`
              : `${state.currentTitle}${state.turns.length === 0 ? "" : ` · ${state.turns.length} ${state.turns.length === 1 ? "turn" : "turns"}`}`}
        </span>
        {contextUsage === undefined ? null : (
          <span className="shrink-0 text-ink-faint">
            {formatTokens(contextUsage.contextTokens)} / {formatTokens(contextUsage.contextWindow)} context
          </span>
        )}
      </div>

      <div className="no-drag flex shrink-0 items-center justify-between px-2.5 pb-2.5 pt-1">
        <IconButton
          label={showSessions ? "Back to the chat (⌘O)" : "Chats (⌘O)"}
          aria-expanded={showSessions}
          onClick={toggleSessions}
          className={showSessions ? "bg-fill-selected text-ink" : ""}
        >
          <List size={15} strokeWidth={2} aria-hidden />
        </IconButton>
        <div className="glass-edge flex h-9 items-center gap-1 rounded-full border border-edge bg-[rgba(40,40,43,0.92)] pl-1 pr-1">
          {primary.run === undefined ? (
            <span className={`flex h-7 items-center gap-2 pl-3 pr-1.5 text-body ${showSessions ? "text-ink" : "text-ink-dim"}`}>
              {primary.label}
              <span className="text-ink-dim"><Kbd keys={primary.keys} /></span>
            </span>
          ) : (
            <button
              type="button"
              onClick={primary.run}
              className="flex h-7 items-center gap-2 rounded-full pl-3 pr-1.5 text-body text-ink transition-colors hover:bg-fill-hover"
            >
              {primary.label}
              <span className="text-ink-dim"><Kbd keys={primary.keys} /></span>
            </button>
          )}
          <span className="h-3.5 w-px bg-edge" aria-hidden />
          <button
            type="button"
            onClick={newChat}
            disabled={state.isManagingSession}
            className="flex h-7 items-center gap-2 rounded-full pl-2.5 pr-1.5 text-body text-ink-dim transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-40"
          >
            New chat
            <Kbd keys={["⌘", "N"]} />
          </button>
        </div>
      </div>
    </div>
  );
}
