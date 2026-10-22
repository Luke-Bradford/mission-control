import type { CSSProperties } from "react";

/** An agent's colour by its config index (`--s1…--s7`, wrapping); FLIGHT is grey. */
export function agentColor(index: number | "flight"): string {
  return index === "flight" ? "var(--fg-2)" : `var(--s${(index % 7) + 1})`;
}

/** A coloured square and the agent's id; `sm` is the small row variant. */
export function AgentTag({
  id,
  index,
  sm,
  domId,
}: {
  id: string;
  index: number | "flight";
  sm?: boolean;
  /** The element's DOM id, for an `aria-labelledby` that names a control by the call sign alone. */
  domId?: string;
}) {
  const style = { "--c": agentColor(index) } as CSSProperties;
  return (
    <span id={domId} className={`ag${sm ? " sm" : ""}`} style={style}>
      <i aria-hidden="true" />
      {id}
    </span>
  );
}
