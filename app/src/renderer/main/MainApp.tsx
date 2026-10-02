import { ArrowUp, ChevronDown, Check, Paperclip, Pencil, Search, Square, SquarePen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ImportedAttachment } from "@shared/ipc.ts";
import { THINKING_LEVELS, sessionDisplayName } from "@shared/protocol.ts";
import type { ProductThinkingLevel } from "@shared/protocol.ts";

import { AttachmentStrip } from "../components/AttachmentStrip.tsx";
import { ApprovalPanel } from "../components/ApprovalPanel.tsx";
import { Button } from "../components/Button.tsx";
import { CaptureDot } from "../components/CaptureDot.tsx";
import { Composer } from "../components/Composer.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { Kbd } from "../components/Kbd.tsx";
import { TurnView } from "../components/TurnView.tsx";
import { groupByDate } from "../relative-time.ts";
import { useAgent, useIsSending, useStore } from "../store/context.tsx";
import { isTurnInFlight } from "../store/types.ts";

export function MainApp(): React.ReactNode {
  const store = useStore();
  const state = useAgent();
  const isSending = useIsSending();
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [preview, setPreview] = useState<ImportedAttachment | null>(null);
  const [filter, setFilter] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => { void store.refreshApprovals(); }, [store]);

  // Follow the newest content while the reader is already at the bottom, and
  // leave them alone when they have scrolled up to read something.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.turns]);

  // Option+Space with this window in front means "let me type here" rather than
  // summoning a second composer over it.
  useEffect(() => {
    return window.openscreen.window.onFocusComposer(() => store.requestInputFocus());
  }, [store]);

  useEffect(() => {
    if (preview === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const sessions =
      needle.length === 0
        ? state.sessions
        : state.sessions.filter((session) =>
            sessionDisplayName(session).toLowerCase().includes(needle),
          );
    return groupByDate(sessions);
  }, [filter, state.sessions]);

  const stopped = state.status.state === "stopped";
  const latest = state.turns[state.turns.length - 1];
  const statusLine =
    state.status.state === "stopped"
      ? state.status.message
      : latest !== undefined && latest.status === "capturing"
        ? "Reading the screen"
        : latest !== undefined && isTurnInFlight(latest.status)
          ? "Working"
          : state.status.state === "starting"
            ? "Starting"
            : "Capture live";

  return (
    <div className="flex h-full text-ink">
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-edge-soft bg-white/[0.015]">
        <div className="drag-region flex h-[52px] shrink-0 items-center justify-end px-3">
          <IconButton
            label="New chat"
            variant="plain"
            size={28}
            onClick={() => store.createNewSession()}
            disabled={state.isManagingSession}
            className="no-drag"
          >
            <SquarePen size={16} strokeWidth={1.8} aria-hidden />
          </IconButton>
        </div>

        <label className="mx-2.5 mb-2 flex h-[34px] shrink-0 items-center gap-2 rounded-full bg-fill-hover px-3 text-ink-faint focus-within:text-ink-dim">
          <Search size={14} strokeWidth={2} aria-hidden />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
          />
        </label>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {state.sessions.length === 0 ? (
            <p className="px-2.5 py-3 text-body text-ink-faint">
              Ask something to start the first chat.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-2.5 py-3 text-body text-ink-faint">No chats match.</p>
          ) : (
            groups.map(({ group, items }) => (
              <section key={group}>
                <h2 className="px-2.5 pb-1 pt-3.5 text-caption text-ink-faint">{group}</h2>
                <ul className="flex flex-col gap-px">
                  {items.map((session) => {
                    const active = session.id === state.currentSessionId;
                    const running = state.activeSessionIds.includes(session.id);
                    if (renaming?.id === session.id) {
                      return (
                        <li key={session.id}>
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
                            className="h-8 w-full rounded-[9px] border border-signal/60 bg-surface px-2.5 text-body text-ink outline-none"
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
                            "flex h-8 w-full items-center gap-2 rounded-[9px] px-2.5 text-left transition-colors",
                            active ? "bg-fill-selected" : "hover:bg-fill-hover",
                          ].join(" ")}
                        >
                          {running ? (
                            <span className="capture-live size-1.5 shrink-0 rounded-full bg-signal" aria-label="Running" />
                          ) : null}
                          <span
                            className={`min-w-0 flex-1 truncate text-body ${active ? "text-ink" : "text-ink-dim"}`}
                          >
                            {sessionDisplayName(session)}
                          </span>
                        </button>
                        {running ? null : (
                          <IconButton
                            label="Rename chat"
                            variant="plain"
                            size={24}
                            onClick={() =>
                              setRenaming({ id: session.id, value: sessionDisplayName(session) })
                            }
                            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <Pencil size={12} strokeWidth={2} aria-hidden />
                          </IconButton>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="drag-region relative flex h-14 shrink-0 flex-col items-center justify-center border-b border-edge-soft px-40">
          <h1 className="max-w-full truncate text-ui font-medium text-ink">{state.currentTitle}</h1>
          <p className={`flex items-center gap-1 text-caption ${stopped ? "text-alert" : "text-ink-faint"}`}>
            <span className="-my-1 -ml-1 scale-75">
              <CaptureDot
                status={state.status}
                attaching={latest !== undefined && latest.status === "capturing"}
              />
            </span>
            <span className="truncate">{statusLine}</span>
          </p>
          <div className="no-drag absolute right-3.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            <ThinkingMenu
              value={state.thinking}
              disabled={state.isUpdatingAgentState || state.currentSessionId === undefined}
              onSelect={(level) => void store.selectThinking(level)}
            />
            <Button
              onClick={() => void store.compact()}
              disabled={state.isCompacting || state.currentSessionId === undefined}
            >
              {state.isCompacting ? "Compacting…" : "Compact"}
            </Button>
          </div>
        </header>

        <ApprovalBanner>
          <ApprovalPanel requests={state.approvals} sessions={state.sessions} decisionsInFlight={state.approvalDecisionsInFlight} error={state.approvalError} onDecide={(id, approved) => void store.decideApproval(id, approved)} />
        </ApprovalBanner>

        {state.sessionError === undefined ? null : (
          <p className="shrink-0 border-b border-alert/25 bg-alert/10 px-6 py-2 text-body text-alert">
            {state.sessionError}
          </p>
        )}
        {state.compactionError === undefined ? null : (
          <p className="shrink-0 border-b border-alert/25 bg-alert/10 px-6 py-2 text-body text-alert">
            {state.compactionError}
          </p>
        )}
        {state.compactionResult === undefined ? null : (
          <p className="shrink-0 border-b border-edge-soft px-6 py-2 text-caption text-ink-faint">
            Compacted {state.compactionResult.tokensBefore} tokens
          </p>
        )}

        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-7 py-6"
        >
          {state.turns.length === 0 ? (
            <div className="mx-auto max-w-[460px] pt-24 text-center">
              <p className="text-title font-medium text-ink">Ask about the window you are working in</p>
              <p className="mt-2 text-ui text-ink-dim">
                OpenScreen attaches the current screen to each question you send.
              </p>
              <p className="mt-4 inline-flex items-center gap-2 text-body text-ink-faint">
                Ask from anywhere with <Kbd keys={["⌥", "Space"]} />
              </p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-[680px] flex-col gap-8">
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

        <div className="shrink-0 px-7 pb-[18px] pt-3">
          <div className="mx-auto max-w-[680px]">
            {state.composer.pendingAttachments.length === 0 ? null : (
              <div className="mb-2.5 pl-12">
                <AttachmentStrip
                  attachments={state.composer.pendingAttachments}
                  onRemove={(id) => store.removeAttachment(id)}
                  onOpen={setPreview}
                />
              </div>
            )}
            {state.composer.attachmentError === undefined ? null : (
              <p className="mb-2 pl-12 text-caption text-alert">
                {state.composer.attachmentError}
              </p>
            )}

            <div className="flex items-end gap-2.5">
              <IconButton
                label={state.composer.importsInFlight > 0 ? "Adding screenshots…" : "Attach screenshots"}
                size={36}
                onClick={() => void store.pickAttachments()}
                disabled={state.composer.importsInFlight > 0}
                className="mb-1"
              >
                <Paperclip size={16} strokeWidth={2} aria-hidden />
              </IconButton>
              <div className="flex min-h-11 flex-1 items-end gap-2 rounded-[22px] border border-edge bg-fill py-[5px] pl-[18px] pr-[5px] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-colors focus-within:border-white/25">
                <div className="flex-1 py-[6px]">
                  <Composer
                    value={state.composer.draft}
                    placeholder={
                      stopped
                        ? "The agent stopped — restart OpenScreen"
                        : "Ask about this screen…"
                    }
                    disabled={stopped || state.isManagingSession}
                    focusRequest={state.focusRequest}
                    onChange={(value) => store.updateDraft(value)}
                    onSubmit={() => store.submit()}
                    onPasteImages={(buffers) => void store.addPastedImages(buffers)}
                    className="text-ui"
                  />
                </div>
                <IconButton
                  label={isSending ? "Stop" : "Send"}
                  variant="primary"
                  size={32}
                  onClick={() => (isSending ? store.cancelCurrentRequest() : store.submit())}
                  disabled={
                    !isSending &&
                    (state.composer.draft.trim().length === 0 || stopped)
                  }
                >
                  {isSending ? (
                    <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden />
                  ) : (
                    <ArrowUp size={16} strokeWidth={2.4} aria-hidden />
                  )}
                </IconButton>
              </div>
            </div>
            <p className="mt-2 flex justify-end gap-4 text-caption text-ink-faint">
              <span className="flex items-center gap-1.5">Send <Kbd keys={["↵"]} size="sm" /></span>
              <span className="flex items-center gap-1.5">New line <Kbd keys={["⇧", "↵"]} size="sm" /></span>
            </p>
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
            className="max-h-full max-w-full rounded-xl border border-edge object-contain"
          />
        </div>
      )}
    </div>
  );
}

/** Gives pending approvals their own scroll region under the header. */
function ApprovalBanner({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto px-7 [&:has(section)]:border-b [&:has(section)]:border-edge-soft [&:has(section)]:py-4">
      <div className="mx-auto max-w-[680px]">{children}</div>
    </div>
  );
}

function ThinkingMenu({
  value,
  disabled,
  onSelect,
}: {
  value: ProductThinkingLevel;
  disabled: boolean;
  onSelect: (level: ProductThinkingLevel) => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        Thinking: {value}
        <ChevronDown size={13} strokeWidth={2.2} aria-hidden />
      </Button>
      {open ? (
        <ul
          role="listbox"
          aria-label="Thinking level"
          className="glass-edge absolute right-0 top-9 z-20 min-w-40 rounded-xl border border-edge bg-[rgba(40,40,43,0.97)] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
        >
          {THINKING_LEVELS.map((level) => (
            <li key={level} role="option" aria-selected={level === value}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (level !== value) onSelect(level);
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-body text-ink hover:bg-fill-selected"
              >
                <span className="flex-1">{level}</span>
                {level === value ? <Check size={14} strokeWidth={2.2} aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
