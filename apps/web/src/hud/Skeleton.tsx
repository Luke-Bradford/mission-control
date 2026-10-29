/** Consistent non-content placeholder while a HUD read is pending. */
export function Skeleton({
  className = "",
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return <span className={`skeleton ${className}`.trim()} role="status" aria-label={label} />;
}
