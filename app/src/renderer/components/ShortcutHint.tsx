/**
 * Key caps are recorded facts about the keyboard, so they use the mono role —
 * and they are spelled out rather than drawn as glyphs, which stay legible at
 * this size and keep every cap in the same register.
 */
export function ShortcutHint({
  keys,
  label,
}: {
  keys: string[];
  label?: string;
}): React.ReactNode {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {keys.map((key) => (
        <kbd key={key} className="keycap">
          {key}
        </kbd>
      ))}
      {label === undefined ? null : (
        <span className="font-mono text-[10px] text-ink-faint">{label}</span>
      )}
    </span>
  );
}
