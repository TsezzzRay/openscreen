import type { ButtonHTMLAttributes } from "react";

const VARIANT = {
  primary: "bg-primary text-on-primary hover:bg-white",
  secondary: "bg-fill-selected text-ink hover:bg-white/[0.14]",
  ghost: "text-ink-dim hover:bg-fill-hover hover:text-ink",
} as const;

/**
 * The one text button. Primary is white on black — the chrome carries no
 * accent colour — and is reserved for the action Enter would take.
 */
export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANT;
}): React.ReactNode {
  return (
    <button
      type={type}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-3 text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}
