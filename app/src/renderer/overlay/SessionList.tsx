import { useMemo, useState } from "react";

import type { ProductSessionSummary } from "@shared/protocol.ts";
import { sessionDisplayName } from "@shared/protocol.ts";

/** Below this many chats, scanning the list beats typing at it. */
const FILTER_THRESHOLD = 8;

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

/**
 * The overlay's chat picker.
 *
 * It carries only what the command bar needs — pick one, or start a new one.
 * Renaming, compaction, and Agent settings stay in the main window, where there
 * is room to show what they did.
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

  return (
    <div className="border-t border-edge">
      {showFilter ? (
        <div className="border-b border-edge-soft px-4 py-2">
          <input
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter chats"
            aria-label="Filter chats"
            className="w-full bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-ink-faint">No chats match.</p>
      ) : (
        <ul className="max-h-[220px] overflow-y-auto py-1">
          {visible.map((session) => {
            const current = session.id === currentSessionId;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={[
                    "flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors",
                    current ? "bg-glass-raised" : "hover:bg-white/[0.03]",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "size-1 shrink-0 rounded-full",
                      activeSessionIds.includes(session.id)
                        ? "bg-amber capture-live"
                        : "bg-transparent",
                    ].join(" ")}
                    aria-hidden
                  />
                  <span
                    className={[
                      "min-w-0 flex-1 truncate text-[12.5px]",
                      current ? "text-ink" : "text-ink-dim",
                    ].join(" ")}
                  >
                    {sessionDisplayName(session)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {relativeTime(session.createdAt)}
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
