import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AttachmentStrip } from "../components/AttachmentStrip.tsx";
import { CaptureDot } from "../components/CaptureDot.tsx";
import { Composer } from "../components/Composer.tsx";
import { ShortcutHint } from "../components/ShortcutHint.tsx";
import { TurnView } from "../components/TurnView.tsx";
import { useAgent, useIsSending, useStore } from "../store/context.tsx";
import { isTurnInFlight } from "../store/types.ts";

/**
 * The overlay is a command bar, not a second chat window.
 *
 * It shows one exchange at a time — the one you just asked for — because its
 * job is a three-second answer about the screen in front of you. Earlier
 * questions are reachable the way they are in a shell, with the up arrow, and
 * the full scrollback lives in the main window.
 */
export function OverlayApp(): React.ReactNode {
  const store = useStore();
  const state = useAgent();
  const isSending = useIsSending();
  const root = useRef<HTMLDivElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const latest = state.turns[state.turns.length - 1];
  const showPanel =
    latest !== undefined && (isSending || latest.answer.length > 0 ||
      latest.toolActivities.length > 0 || latest.status === "failed");

  // Drive the window height from the rendered content so the bar keeps its
  // position and the answer grows downward from it.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const report = () => window.openscreen.overlay.resize(element.scrollHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  });

  useEffect(() => {
    return window.openscreen.overlay.onFocusRequested(() => store.requestInputFocus());
  }, [store]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape stops a run in progress before it dismisses the overlay, so
        // there is never a run you can no longer reach.
        if (isSending) store.cancelCurrentRequest();
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
  }, [isSending, store]);

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
    store.submit();
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

      {showPanel && latest !== undefined ? (
        <div className="compact max-h-[420px] overflow-y-auto border-t border-edge px-4 py-3">
          <TurnView turn={latest} compact onRetry={(id) => store.retry(id)} />
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-edge-soft px-4 py-2">
        <span className="font-mono text-[10px] text-ink-faint">
          {state.status.state === "stopped"
            ? state.status.message
            : latest !== undefined && isTurnInFlight(latest.status)
              ? "the current screen is attached to this question"
              : state.currentTitle}
        </span>
        <button
          type="button"
          onClick={() => window.openscreen.shell.openMainWindow()}
          className="font-mono text-[10px] text-ink-faint hover:text-ink-dim"
        >
          open the full app
        </button>
      </div>
    </div>
  );
}
