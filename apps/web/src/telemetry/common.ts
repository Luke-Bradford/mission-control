/** What the Telemetry groups share: the toolbar's scope and the small labels the charts use. */
import type { AccountId, AgentId, TelemetryRange } from "@mc/core";

export const DASH = "—";

/** A tile whose figure Mission Control does not store. */
export const NOT_TRACKED = "not tracked yet";
export const NOT_TRACKED_TITLE = "Mission Control does not store this figure yet.";

export interface AgentInfo {
  id: AgentId;
  /** Config order: the agent's colour. */
  index: number;
  /** null while the config loads. */
  accountId: AccountId | null;
}

/** The toolbar's choices, resolved: every group reads its slice from here. */
export interface Scope {
  range: TelemetryRange;
  /** Every configured agent. */
  all: AgentInfo[];
  /** The agents the Agent and Account selects leave in view. */
  agents: AgentInfo[];
  /** The Account select; "" for all. */
  account: string;
  /** The Ticket select; "" for all. */
  ticket?: string;
  /** What a panel says while there is no data: loading, or why not. */
  wait: string;
  /** The telemetry on screen is this scope's and its last read succeeded: now-cursors pulse. */
  live: boolean;
}

export const indexOf = (scope: Scope, id: AgentId): number =>
  scope.all.find((a) => a.id === id)?.index ?? 0;

/** `now` / `{n} min ago` / `{n} h ago` / `{n} days ago` for a point `mins` before now (the mockup's `rangeLabel`). */
export function minutesAgo(mins: number): string {
  if (mins < 1) return "now";
  if (mins < 120) return `${Math.round(mins)} min ago`;
  if (mins < 2880) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}
