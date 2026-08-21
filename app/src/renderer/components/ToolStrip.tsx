import type { ToolActivity } from "../store/types.ts";
import { Spinner } from "./Spinner.tsx";

/** The first line of a tool result, which is the part worth showing inline. */
function summarise(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function ToolStrip({
  activities,
}: {
  activities: ToolActivity[];
}): React.ReactNode {
  if (activities.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {activities.map((activity) => (
        <li
          key={activity.callId}
          className="flex items-baseline gap-2 font-mono text-[11px] leading-5"
        >
          <span className="w-3 shrink-0 text-center">
            {activity.status === "running" ? (
              <Spinner className="text-amber" />
            ) : activity.isError ? (
              <span className="text-alert">✕</span>
            ) : (
              <span className="text-ink-faint">✓</span>
            )}
          </span>
          <span
            className={activity.isError ? "shrink-0 text-alert" : "shrink-0 text-ink-dim"}
          >
            {activity.name}
          </span>
          <span className="truncate text-ink-faint">{summarise(activity.text)}</span>
        </li>
      ))}
    </ul>
  );
}
