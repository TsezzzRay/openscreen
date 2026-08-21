import { useEffect, useRef, useState } from "react";

import type { ImportedAttachment } from "@shared/ipc.ts";
import { THINKING_LEVELS, sessionDisplayName } from "@shared/protocol.ts";
import type { ProductThinkingLevel } from "@shared/protocol.ts";

import { AttachmentStrip } from "../components/AttachmentStrip.tsx";
import { CaptureDot } from "../components/CaptureDot.tsx";
import { Composer } from "../components/Composer.tsx";
import { ShortcutHint } from "../components/ShortcutHint.tsx";
import { TurnView } from "../components/TurnView.tsx";
import { useAgent, useIsSending, useStore } from "../store/context.tsx";

function relativeTime(iso: string): string {
  const created = Date.parse(iso);
  if (Number.isNaN(created)) return "";
  const minutes = Math.round((Date.now() - created) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function MainApp(): React.ReactNode {
  const store = useStore();
  const state = useAgent();
  const isSending = useIsSending();
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [preview, setPreview] = useState<ImportedAttachment | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Follow the newest content while the reader is already at the bottom, and
  // leave them alone when they have scrolled up to read something.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.turns]);

  useEffect(() => {
    if (preview === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  const stopped = state.status.state === "stopped";

  return (
    <div className="flex h-full bg-surface text-ink">
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-edge-soft bg-surface-sunken">
        <div className="drag-region h-[52px] shrink-0" />

        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => store.createNewSession()}
            disabled={state.isManagingSession}
            className="w-full rounded-lg border border-edge bg-glass-raised px-3 py-2 text-left text-[13px] text-ink transition-colors hover:border-amber/40 disabled:opacity-50"
          >
            New chat
          </button>
        </div>

        <div className="flex items-center justify-between px-4 pb-2">
          <span className="eyebrow">Chats</span>
          <span className="font-mono text-[10px] text-ink-faint">
            {state.sessions.length}
          </span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {state.sessions.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-ink-faint">
              Ask something to start the first chat.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {state.sessions.map((session) => {
                const active = session.id === state.currentSessionId;
                const running = state.activeSessionIds.includes(session.id);
                if (renaming?.id === session.id) {
                  return (
                    <li key={session.id} className="px-1">
                      <input
                        autoFocus
                        value={renaming.value}
                        onChange={(event) =>
                          setRenaming({ id: session.id, value: event.target.value })
                        }
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenaming(null);
                          if (event.key !== "Enter") return;
                          const name = renaming.value.trim();
                          if (name.length > 0) store.renameSession(session.id, name);
                          setRenaming(null);
                        }}
                        className="w-full rounded-md border border-amber/50 bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none"
                        aria-label="Chat name"
                      />
                    </li>
                  );
                }
                return (
                  <li key={session.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => store.selectSession(session.id)}
                      className={[
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        active ? "bg-glass-raised" : "hover:bg-white/[0.03]",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "size-1 shrink-0 rounded-full",
                          running ? "bg-amber capture-live" : "bg-transparent",
                        ].join(" ")}
                        aria-hidden
                      />
                      <span
                        className={[
                          "min-w-0 flex-1 truncate text-[12.5px]",
                          active ? "text-ink" : "text-ink-dim",
                        ].join(" ")}
                      >
                        {sessionDisplayName(session)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {relativeTime(session.createdAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRenaming({ id: session.id, value: sessionDisplayName(session) })
                      }
                      disabled={running}
                      className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[9px] text-ink-faint group-hover:block disabled:hidden"
                    >
                      rename
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="shrink-0 border-t border-edge-soft px-4 py-3">
          <span className="eyebrow">Agent</span>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[12px] text-ink-dim">Thinking</span>
            <select
              value={state.thinking}
              disabled={state.isUpdatingAgentState || state.currentSessionId === undefined}
              onChange={(event) =>
                void store.selectThinking(event.target.value as ProductThinkingLevel)
              }
              className="rounded-md border border-edge bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none disabled:opacity-50"
            >
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => void store.compact()}
            disabled={state.isCompacting || state.currentSessionId === undefined}
            className="mt-2 w-full rounded-md border border-edge px-2 py-1.5 text-[12px] text-ink-dim transition-colors hover:border-amber/40 hover:text-ink disabled:opacity-50"
          >
            {state.isCompacting ? "Compacting…" : "Compact session"}
          </button>

          {state.compactionResult === undefined ? null : (
            <p className="mt-2 font-mono text-[10px] text-ink-faint">
              compacted {state.compactionResult.tokensBefore} tokens
            </p>
          )}
          {state.compactionError === undefined ? null : (
            <p className="mt-2 font-mono text-[10px] text-alert">
              {state.compactionError}
            </p>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-[52px] shrink-0 items-center gap-2.5 border-b border-edge-soft px-5">
          <CaptureDot status={state.status} attaching={false} />
          <h1 className="truncate text-[13px] text-ink">{state.currentTitle}</h1>
          <span className="ml-auto no-drag">
            <ShortcutHint keys={["opt", "space"]} label="overlay" />
          </span>
        </header>

        {state.sessionError === undefined ? null : (
          <p className="shrink-0 border-b border-alert/25 bg-alert/10 px-5 py-2 font-mono text-[11px] text-alert">
            {state.sessionError}
          </p>
        )}

        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-6"
        >
          {state.turns.length === 0 ? (
            <div className="mx-auto max-w-[520px] pt-16">
              <p className="eyebrow">No questions yet</p>
              <p className="mt-3 text-[15px] leading-relaxed text-ink">
                Ask about the window you are working in. OpenScreen attaches the
                current screen to each question you send.
              </p>
              <p className="mt-2 text-[13px] text-ink-dim">
                Press Option and Space anywhere to ask without leaving your app.
              </p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-[720px] flex-col gap-9">
              {state.turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  onRetry={(id) => store.retry(id)}
                  onOpenAttachment={setPreview}
                />
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-edge-soft px-5 py-4">
          <div className="mx-auto max-w-[720px]">
            {state.composer.pendingAttachments.length === 0 ? null : (
              <div className="mb-2.5">
                <AttachmentStrip
                  attachments={state.composer.pendingAttachments}
                  onRemove={(id) => store.removeAttachment(id)}
                  onOpen={setPreview}
                />
              </div>
            )}
            {state.composer.attachmentError === undefined ? null : (
              <p className="mb-2 font-mono text-[11px] text-alert">
                {state.composer.attachmentError}
              </p>
            )}

            <div className="flex items-end gap-3 rounded-xl border border-edge bg-surface-raised px-3.5 py-3 focus-within:border-amber/40">
              <Composer
                value={state.composer.draft}
                placeholder={
                  stopped
                    ? "The agent stopped — restart OpenScreen"
                    : "Ask about this screen"
                }
                disabled={stopped || state.isManagingSession}
                focusRequest={state.focusRequest}
                onChange={(value) => store.updateDraft(value)}
                onSubmit={() => store.submit()}
                onPasteImages={(buffers) => void store.addPastedImages(buffers)}
                className="text-[13.5px]"
              />
              <button
                type="button"
                onClick={() => void store.pickAttachments()}
                disabled={state.composer.importsInFlight > 0}
                className="shrink-0 font-mono text-[11px] text-ink-faint hover:text-ink-dim disabled:opacity-50"
              >
                {state.composer.importsInFlight > 0 ? "adding…" : "attach"}
              </button>
              <button
                type="button"
                onClick={() => (isSending ? store.cancelCurrentRequest() : store.submit())}
                disabled={
                  !isSending &&
                  (state.composer.draft.trim().length === 0 || stopped)
                }
                className="shrink-0 rounded-md bg-amber px-2.5 py-1 font-mono text-[11px] text-black transition-opacity disabled:opacity-25"
              >
                {isSending ? "stop" : "send"}
              </button>
            </div>
          </div>
        </div>
      </main>

      {preview === null ? null : (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/80 p-10"
          onClick={() => setPreview(null)}
          role="presentation"
        >
          <img
            src={preview.url}
            alt="Screenshot"
            className="max-h-full max-w-full rounded-lg border border-edge object-contain"
          />
        </div>
      )}
    </div>
  );
}
