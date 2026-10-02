import { MessagesSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ProductSessionSummary } from "@shared/protocol.ts";
import { sessionDisplayName } from "@shared/protocol.ts";

import { relativeTime } from "../relative-time.ts";

/** Below this many chats, scanning the list beats typing at it. */
const FILTER_THRESHOLD = 8;

/**
 * The overlay's chat picker.
 *
 * It carries only what the command bar needs — pick one with the arrow keys and
 * Enter, or click it. Renaming, compaction, and Agent settings stay in the main
 * window, where there is room to show what they did.
 *
 * The keys are taken in the capture phase so the composer underneath, which
 * keeps focus, does not also treat Enter as "send".
 */
export function SessionList({
  sessions,
  currentSessionId,
  activeSessionIds,
  onSelect,
}: {
  sessions: ProductSessionSummary[];
  currentSessionId?: string | undefined;
  activeSessionIds: string[];
  onSelect: (id: string) => void;
}): React.ReactNode {
  const [filter, setFilter] = useState("");
  const showFilter = sessions.length > FILTER_THRESHOLD;

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!showFilter || needle.length === 0) return sessions;
    return sessions.filter((session) =>
      sessionDisplayName(session).toLowerCase().includes(needle),
    );
  }, [filter, sessions, showFilter]);

  const [highlight, setHighlight] = useState(() =>
    Math.max(0, sessions.findIndex((session) => session.id === currentSessionId)),
  );
  const index = Math.min(highlight, Math.max(0, visible.length - 1));
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") {
        const session = visible[index];
        if (session !== undefined) onSelect(session.id);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(Math.min(visible.length - 1, Math.max(0, index + step)));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [index, onSelect, visible]);

  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2.5 pb-1.5">
        <span className="text-caption font-medium text-ink-dim">Chats</span>
        <span className="text-caption text-ink-faint">{sessions.length}</span>
      </div>
      {showFilter ? (
        <input
          autoFocus
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setHighlight(0);
          }}
          placeholder="Filter chats"
          aria-label="Filter chats"
          className="mx-1 mb-1.5 h-8 rounded-full bg-fill-hover px-3.5 text-body text-ink outline-none placeholder:text-ink-faint"
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="px-2.5 py-3 text-body text-ink-faint">No chats match.</p>
      ) : (
        <ul ref={list} role="listbox" aria-label="Chats" className="flex flex-col">
          {visible.map((session, position) => {
            const current = session.id === currentSessionId;
            const running = activeSessionIds.includes(session.id);
            return (
              <li key={session.id} role="option" aria-selected={position === index}>
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  onMouseMove={() => setHighlight(position)}
                  className={[
                    "flex h-[42px] w-full items-center gap-3 rounded-[10px] px-2.5 text-left",
                    position === index ? "bg-fill-selected" : "",
                  ].join(" ")}
                >
                  <span className="relative flex size-[22px] shrink-0 items-center justify-center rounded-md bg-white/[0.12] text-ink">
                    <MessagesSquare size={13} strokeWidth={2.2} aria-hidden />
                    {running ? (
                      <span className="capture-live absolute -right-0.5 -top-0.5 size-2 rounded-full border border-surface bg-signal" />
                    ) : null}
                  </span>
                  <span className="min-w-0 truncate text-ui text-ink">
                    {sessionDisplayName(session)}
                  </span>
                  <span className="shrink-0 text-ui text-ink-dim">
                    {relativeTime(session.createdAt)}
                  </span>
                  <span className="ml-auto shrink-0 text-body text-ink-faint">
                    {current ? "Current" : running ? "Running" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
