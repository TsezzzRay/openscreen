import { useEffect, useState } from "react";

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/**
 * A braille spinner rendered as text rather than as a CSS animation, so running
 * work stays in the same monospaced record register as the tool line it sits on.
 */
export function Spinner({ className = "" }: { className?: string }): React.ReactNode {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 90);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={`font-mono ${className}`} aria-hidden>
      {FRAMES[frame]}
    </span>
  );
}
