import type { ReactNode } from "react";

/** A scrolling list a keyboard user can focus, so every row past the fold stays reachable. */
export function ScrollRegion({
  className,
  label,
  children,
}: {
  className: string;
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs the keyboard to reach its extra rows
    <section className={className} tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}
