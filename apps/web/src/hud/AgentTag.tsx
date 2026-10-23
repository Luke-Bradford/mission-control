import type { ConfigView, Crew } from "@mc/core";
import type { CSSProperties } from "react";
import { usePhone } from "../board/phone.ts";
import { seatRoleTitle } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";

/** An agent's colour by its config index (`--s1…--s7`, wrapping); FLIGHT is grey. */
export function agentColor(index: number | "flight"): string {
  return index === "flight" ? "var(--fg-2)" : `var(--s${(index % 7) + 1})`;
}

/**
 * The title of the role the named seat holds, placed by width: `suffix` is the text to show after
 * the call sign on a wide screen, `title` the tooltip that carries it on a phone. Both null while
 * the crew loads or for an observed loop.
 */
export function useRoleLabel(id: string): { suffix: string | null; title: string | undefined } {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const phone = usePhone();
  const role = seatRoleTitle(id, crew?.rows, config?.crew?.roles);
  if (role === null) return { suffix: null, title: undefined };
  return phone ? { suffix: null, title: role } : { suffix: role, title: undefined };
}

/** A coloured square, the agent's id and its role's title; `sm` is the small row variant. */
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
  const { suffix, title } = useRoleLabel(id);
  return (
    <span className={`ag${sm ? " sm" : ""}`} style={style} title={title}>
      <i aria-hidden="true" />
      <span id={domId}>{id}</span>
      {suffix !== null && <span className="rt">{` · ${suffix}`}</span>}
    </span>
  );
}
