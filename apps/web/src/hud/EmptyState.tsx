import type { ReactNode } from "react";

/** Consistent, quiet no-data treatment for every HUD panel. */
export function EmptyState({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`empty-state ${className}`.trim()}>{children}</p>;
}
