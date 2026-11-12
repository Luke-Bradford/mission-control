import type { ChainNode, DependencyChain } from "@mc/core";

/** A chain with more than this many dependents shows `SHOWN_WHEN_CAPPED` and a `{n} more` row. */
export const MAX_SHOWN = 5;
export const SHOWN_WHEN_CAPPED = 4;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHAIN_COLUMNS = [
  "Work",
  "State",
  "What holds it",
  "Next owner",
  "Waited",
  "Merge frees",
] as const;

export const STATE_WORD: Record<DependencyChain["state"], string> = {
  stuck: "Stuck",
  "with-you": "With you",
  moving: "Moving",
  unknown: "—",
};

/** A mark beside the state word, so the state is not carried by colour alone. */
export const STATE_MARK: Record<DependencyChain["state"], string> = {
  stuck: "▲",
  "with-you": "●",
  moving: "◆",
  unknown: "",
};

export const EDGE_WORD: Record<NonNullable<ChainNode["edge"]>, string> = {
  depends: "depends on",
  stacked: "stacked on",
  held: "held for",
  queue: "behind in seat queue",
};

export const NO_START = "The hub has no start time for this wait.";

/** A wait as days and hours, hours and minutes, or minutes; unknown is a dash. */
export function waitText(ms: number | null): string {
  if (ms === null) return "—";
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d) return `${d}d ${h}h`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export interface ChainRow {
  node: ChainNode;
  depth: number;
  parent: ChainNode;
}

/** The dependents under a root, each with the work it waits on, depth first. */
export function flattenChain(root: ChainNode): ChainRow[] {
  const out: ChainRow[] = [];
  const walk = (parent: ChainNode, depth: number) => {
    for (const node of parent.children) {
      out.push({ node, depth, parent });
      walk(node, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

export interface ChainStats {
  chains: number;
  stuck: number;
  waiting: number;
  longestMs: number | null;
}

/** The header figures, all as of now. `waiting` counts each ticket or PR once, whatever its roots. */
export function chainStats(chains: readonly DependencyChain[]): ChainStats {
  const waiting = new Set<string>();
  let longestMs: number | null = null;
  for (const c of chains) {
    for (const row of flattenChain(c.root)) waiting.add(row.node.ref);
    if (c.longestWaitMs !== null && (longestMs === null || c.longestWaitMs > longestMs))
      longestMs = c.longestWaitMs;
  }
  return {
    chains: chains.length,
    stuck: chains.filter((c) => c.state === "stuck").length,
    waiting: waiting.size,
    longestMs,
  };
}

/** The server names the next owner `operator`, `controller`, `nobody` or a seat; the page says it plainly. */
export function ownerText(owner: string): string {
  if (owner === "operator") return "You";
  if (owner === "controller") return "Controller";
  if (owner === "nobody") return "—";
  return owner;
}
