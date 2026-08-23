import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AttachmentStrip } from "../components/AttachmentStrip.tsx";
import { CaptureDot } from "../components/CaptureDot.tsx";
import { Composer } from "../components/Composer.tsx";
import { ShortcutHint } from "../components/ShortcutHint.tsx";
import { TurnView } from "../components/TurnView.tsx";
import { useAgent, useIsSending, useStore } from "../store/context.tsx";
import { isTurnInFlight } from "../store/types.ts";
import { SessionList } from "./SessionList.tsx";

/**
 * The overlay is a command bar with the conversation kept underneath it.
 *
 * The bar stays where it is and everything else grows downward from it, so the
 * three-second question never has to wait for a window to settle. The chat
 * itself scrolls in place: recent exchanges are right there to scroll back
 * through, while renaming, compaction, and Agent settings stay in the main
 * window where there is room to show what they did.
 */
export function OverlayApp(): React.ReactNode {
  const store = useStore();
  const state = useAgent();
  const isSending = useIsSending();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSessions, setShowSessions] = useState(false);

  const latest = state.turns[state.turns.length - 1];
  const hasTranscript = state.turns.some(
    (turn) =>
      turn.question.length > 0 || turn.answer.length > 0 ||
      turn.toolActivities.length > 0,
  );
  // The chat and the chat picker share the space below the bar, so the panel
  // never stacks itself past the window ceiling.
  const showTranscript = !showSessions && (isSending || hasTranscript);

  // Drive the window height from the rendered content so the bar keeps its
  // position and everything else grows downward from it.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const report = () => window.openscreen.overlay.resize(element.scrollHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  });

  // Follow the newest content while the reader is already at the bottom, and
  // leave them alone when they have scrolled up to read something.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.turns, showTranscript]);

  useEffect(() => {
    return window.openscreen.window.onFocusComposer(() =>
      store.requestInputFocus(),
    );
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
      if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        window.openscreen.shell.openMainWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSending, showSessions, store]);

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
    store.submit();
  }, [store]);

  const openSessions = useCallback(() => {
    setShowSessions((open) => {
      // The list is kept current by the main process; this is the user-reachable
      // way to force a re-read if that ever falls behind.
      if (!open) void store.refreshSessions();
      return !open;
    });
  }, [store]);

  const stopped = state.status.state === "stopped";

  return (
    <div
      ref={root}
      className="flex flex-col overflow-hidden rounded-[var(--radius-pane)] border border-edge bg-glass shadow-[0_18px_50px_rgba(0,0,0,0.45)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.45)]"
    >
      <div className="drag-region flex items-center gap-3 px-4 py-[18px]">
        <CaptureDot
          status={state.status}
          attaching={latest !== undefined && latest.status === "capturing"}
        />
        <Composer
          value={state.composer.draft}
          placeholder={
            stopped ? "The agent stopped — restart OpenScreen" : "Ask about this screen"
          }
          disabled={stopped || state.isManagingSession}
          focusRequest={state.focusRequest}
          onChange={(value) => {
            setHistoryIndex(-1);
            store.updateDraft(value);
          }}
          onSubmit={submit}
          onPasteImages={(buffers) => void store.addPastedImages(buffers)}
          onHistory={recall}
          className="text-[14px]"
        />
        <div className="no-drag flex shrink-0 items-center gap-2">
          {isSending ? (
            <button
              type="button"
              onClick={() => store.cancelCurrentRequest()}
              className="font-mono text-[10px] text-amber"
            >
              stop
            </button>
          ) : (
            <ShortcutHint keys={["enter"]} />
          )}
          <ShortcutHint keys={["esc"]} />
        </div>
      </div>

      {state.composer.pendingAttachments.length === 0 ? null : (
        <div className="border-t border-edge-soft px-4 py-2.5">
          <AttachmentStrip
            attachments={state.composer.pendingAttachments}
            onRemove={(id) => store.removeAttachment(id)}
          />
        </div>
      )}

      {showSessions ? (
        <SessionList
          sessions={state.sessions}
          currentSessionId={state.currentSessionId}
          activeSessionIds={state.activeSessionIds}
          onSelect={(id) => {
            setShowSessions(false);
            setHistoryIndex(-1);
            store.selectSession(id);
            store.requestInputFocus();
          }}
        />
      ) : null}

      {showTranscript ? (
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="compact max-h-[480px] overflow-y-auto border-t border-edge px-4 py-3"
        >
          <div className="flex flex-col gap-5">
            {state.turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                compact
                onRetry={(id) => store.retry(id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-edge-soft px-4 py-2">
        <div className="no-drag flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={openSessions}
            aria-expanded={showSessions}
            className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-ink-faint hover:text-ink-dim"
          >
            <span aria-hidden>{showSessions ? "⌃" : "⌄"}</span>
            <span className="truncate">
              {state.status.state === "stopped"
                ? state.status.message
                : latest !== undefined && isTurnInFlight(latest.status)
                  ? "the current screen is attached to this question"
                  : state.currentTitle}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSessions(false);
              setHistoryIndex(-1);
              store.createNewSession();
              store.requestInputFocus();
            }}
            disabled={state.isManagingSession}
            className="shrink-0 font-mono text-[10px] text-ink-faint hover:text-ink-dim disabled:opacity-40"
          >
            new
          </button>
        </div>
        <button
          type="button"
          onClick={() => window.openscreen.shell.openMainWindow()}
          className="no-drag shrink-0 font-mono text-[10px] text-ink-faint hover:text-ink-dim"
        >
          open the full app
        </button>
      </div>
    </div>
  );
}
