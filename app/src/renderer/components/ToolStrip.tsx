import {
  AppWindow,
  ChevronRight,
  CircleX,
  FileText,
  FolderSearch,
  MousePointerClick,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { ToolActivity } from "../store/types.ts";
import { Spinner } from "./Spinner.tsx";

/** The first line of a tool result, which is the part worth showing inline. */
function summarise(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function toolIcon(name: string): LucideIcon {
  if (name === "bash") return Terminal;
  if (name === "read" || name === "write" || name === "edit") return FileText;
  if (name === "ls" || name === "find" || name === "grep") return FolderSearch;
  if (name === "desktop_windows" || name === "desktop_window_state") return AppWindow;
  if (name.startsWith("desktop_")) return MousePointerClick;
  return Wrench;
}

/**
 * Steps stay open while any of them is still running, so the user can watch the
 * run, and fold into one summary line once they have all finished.
 */
export function toolSummary(activities: ToolActivity[]): {
  running: boolean;
  label: string;
  failed: number;
} {
  const running = activities.some((activity) => activity.status === "running");
  const failed = activities.filter((activity) => activity.isError).length;
  const count = activities.length;
  const base = `Ran ${count} ${count === 1 ? "action" : "actions"}`;
  return { running, failed, label: failed === 0 ? base : `${base} · ${failed} failed` };
}

export function ToolStrip({
  activities,
}: {
  activities: ToolActivity[];
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  if (activities.length === 0) return null;
  const summary = toolSummary(activities);
  const expanded = summary.running || open;

  return (
    <div className="flex flex-col items-start gap-1">
      {summary.running ? null : (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={[
            "inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge-soft bg-fill px-2.5 text-caption transition-colors hover:bg-fill-hover",
            summary.failed > 0 ? "text-alert" : "text-ink-dim",
          ].join(" ")}
        >
          <ChevronRight
            size={13}
            strokeWidth={2.2}
            className={`transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          {summary.label}
        </button>
      )}
      {expanded ? (
        <ul className="flex w-full flex-col">
          {activities.map((activity) => {
            const Icon = toolIcon(activity.name);
            return (
              <li
                key={activity.callId}
                className="flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-body"
              >
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-white/[0.12] text-ink">
                  <Icon size={11} strokeWidth={2.2} aria-hidden />
                </span>
                <span
                  className={`shrink-0 font-mono text-caption ${activity.isError ? "text-alert" : "text-ink"}`}
                >
                  {activity.name}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink-faint">
                  {summarise(activity.text)}
                </span>
                <span className="shrink-0 text-caption text-ink-faint">
                  {activity.status === "running" ? (
                    <Spinner size={13} className="text-signal" />
                  ) : activity.isError ? (
                    <CircleX size={13} className="text-alert" aria-label="Failed" />
                  ) : (
                    "Done"
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
