/** Consistent non-content placeholder while a HUD read is pending. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />;
}
