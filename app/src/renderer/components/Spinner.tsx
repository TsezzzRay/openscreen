import { LoaderCircle } from "lucide-react";

/** Running work. Stops turning under reduced motion and stays as a static ring. */
export function Spinner({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}): React.ReactNode {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={2.2}
      className={`shrink-0 motion-safe:animate-spin ${className}`}
      aria-hidden
    />
  );
}
