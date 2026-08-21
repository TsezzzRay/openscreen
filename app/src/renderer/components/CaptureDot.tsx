import type { AgentStatus } from "@shared/ipc.ts";

/**
 * The capture indicator: the one ambient motion in the product.
 *
 * It is not decoration — it reports whether the runtime that records the screen
 * is actually alive, which is the single fact a user of a continuous-capture
 * assistant most needs at a glance.
 */
export function CaptureDot({
  status,
  attaching,
}: {
  status: AgentStatus;
  attaching: boolean;
}): React.ReactNode {
  const stopped = status.state === "stopped";
  const label = stopped
    ? "Capture stopped"
    : attaching
      ? "Attaching the current screen"
      : "Capture live";

  return (
    <span
      className="relative flex size-2.5 shrink-0 items-center justify-center"
      role="img"
      aria-label={label}
      title={label}
    >
      {attaching && !stopped ? (
        <span className="absolute size-2.5 rounded-full bg-amber/35" />
      ) : null}
      <span
        className={[
          "size-1.5 rounded-full transition-colors",
          stopped ? "bg-ink-faint" : "bg-amber",
          !stopped && !attaching ? "capture-live" : "",
        ].join(" ")}
      />
    </span>
  );
}
