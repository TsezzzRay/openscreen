import type { ButtonHTMLAttributes } from "react";

const VARIANT = {
  outline: "border border-edge bg-fill text-ink-dim hover:bg-fill-hover hover:text-ink",
  plain: "text-ink-dim hover:bg-fill-hover hover:text-ink",
  primary: "bg-primary text-on-primary hover:bg-white",
} as const;

/** A circular icon-only button. `label` is required because there is no text. */
export function IconButton({
  label,
  variant = "outline",
  size = 36,
  className = "",
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  variant?: keyof typeof VARIANT;
  size?: 24 | 28 | 32 | 36;
}): React.ReactNode {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-35 ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}
