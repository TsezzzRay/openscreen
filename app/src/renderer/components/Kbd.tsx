/**
 * Outlined key caps, drawn as the glyphs printed on a Mac keyboard. The caps
 * are decorative beside a text label, so they stay hidden from assistive
 * technology unless they are the only label.
 */
export function Kbd({
  keys,
  size = "md",
  className = "",
}: {
  keys: string[];
  size?: "sm" | "md";
  className?: string;
}): React.ReactNode {
  const cap =
    size === "sm"
      ? "h-[17px] min-w-[17px] rounded-[4px] px-1 text-[10px]"
      : "h-5 min-w-5 rounded-[5px] px-1 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-hidden>
      {keys.map((key) => (
        <kbd
          key={key}
          className={`inline-flex items-center justify-center border border-current/25 font-sans leading-none ${cap}`}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
