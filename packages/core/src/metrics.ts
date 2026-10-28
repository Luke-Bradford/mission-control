import { FLOW_DAYS } from "./hud.ts";
import type { CrewRow } from "./types.ts";

/**
 * The metric registry: every figure the HUD shows on more than one page, defined once. Each page
 * labels a figure with `metricLabel` (its window included), puts `metricHover` on hover and renders
 * the value from `metricReadings`, so the same figure reads the same on Overview, FLIGHT, Telemetry
 * and Comms. A page that needs another window or scope shows a different label, never the same one.
 */
export const METRIC_IDS = [
  "inProgress",
  "blocked",
  "merged",
  "cycleTime",
  "needsYou",
  "agentsLive",
  "agentsWorking",
  "cost",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricWindow = "now" | "today" | "24h" | "14d";
export type MetricUnit = "tickets" | "agents" | "PRs" | "hours" | "items" | "USD";

export interface MetricDef {
  label: string;
  window: MetricWindow;
  unit: MetricUnit;
  /** What is counted and what is left out, in the operator's words; shown on hover. */
  definition: string;
  /** Where the value comes from. */
  source: string;
}

/** Cycle time looks back over the flow window: enough finished tickets for a p85 to mean something. */
export const CYCLE_TIME_DAYS = FLOW_DAYS;
export const MERGED_WINDOW_MS = 24 * 60 * 60_000;

const REPOS_IN_VIEW = "Repos in view: the header's session filter.";
const AGENTS_IN_VIEW =
  "Agents in view: crew seats, FLIGHT and observed loops under the header's session filter.";

export const METRICS: Readonly<Record<MetricId, MetricDef>> = {
  inProgress: {
    label: "In progress",
    window: "now",
    unit: "tickets",
    definition: `Tickets started and not yet merged: an agent is building them, or their PR is in checks, review or merging. Ready tickets nobody has started are not counted. ${REPOS_IN_VIEW}`,
    source: "GET /api/metrics (the Overview pipeline)",
  },
  blocked: {
    label: "Blocked",
    window: "now",
    unit: "agents",
    definition: `Agents that cannot move without someone: waiting on a question, stalled, parked or in error. A loop you paused is not blocked. ${AGENTS_IN_VIEW}`,
    source: "GET /api/crew",
  },
  merged: {
    label: "Merged",
    window: "24h",
    unit: "PRs",
    definition: `Pull requests merged in the last 24 hours, linked to a ticket or not. ${REPOS_IN_VIEW}`,
    source: "GET /api/metrics",
  },
  cycleTime: {
    label: "Cycle time p50",
    window: "14d",
    unit: "hours",
    definition: `Hours from a ticket's first move into Ready (or a later column) to Done, for tickets done in the last ${CYCLE_TIME_DAYS} days. p50 is the median; p85 is the time 85% of tickets beat. Done tickets with no Ready entry, or timestamps out of order, are left out. ${REPOS_IN_VIEW}`,
    source: "GET /api/metrics (the board's flow history)",
  },
  needsYou: {
    label: "Needs you",
    window: "now",
    unit: "items",
    definition:
      "Your whole inbox: every open item that is yours to act on, counted once. The session filter never hides one.",
    source: "GET /api/attention through needsYouItems (apps/web/src/attention.ts)",
  },
  agentsLive: {
    label: "Agents live",
    window: "now",
    unit: "agents",
    definition: `Agents able to take work: not paused (by you or a crew pause), stopped or in error. ${AGENTS_IN_VIEW}`,
    source: "GET /api/crew",
  },
  agentsWorking: {
    label: "Agents working",
    window: "now",
    unit: "agents",
    definition: `Agents running a turn right now. ${AGENTS_IN_VIEW}`,
    source: "GET /api/crew",
  },
  cost: {
    label: "Cost",
    window: "today",
    unit: "USD",
    definition: `API-equivalent cost of runs since local midnight; a subscription isn't billed per token. ${REPOS_IN_VIEW}`,
    source: "GET /api/metrics",
  },
};

/** A figure's label with its window: "Merged · 24h". */
export const metricLabel = (id: MetricId): string => `${METRICS[id].label} · ${METRICS[id].window}`;

/** A figure's hover text: its definition, window, unit and source. */
export function metricHover(id: MetricId): string {
  const m = METRICS[id];
  return `${m.definition}\nWindow: ${m.window} · unit: ${m.unit} · source: ${m.source}`;
}

/** `GET /api/metrics[?session=]`: the registry figures the server measures. */
export interface MetricsView {
  at: number;
  inProgress: { count: number; oldestAt: number | null };
  merged: { count: number };
  cycleTime: { p50Ms: number | null; p85Ms: number | null; n: number; excluded: number };
  cost: { usd: number };
}

/** The p-th percentile (0–100) by linear interpolation between ranks; p50 is the median. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** Hours, one decimal under 10: "0.4 h", "14 h". */
export function formatHours(ms: number): string {
  const h = ms / 3_600_000;
  return `${h < 10 ? h.toFixed(1) : String(Math.round(h))} h`;
}

const BLOCKED_STATES: readonly CrewRow["hudState"][] = ["blocked", "stalled", "error"];

export type MetricRow = Pick<
  CrewRow,
  "hudState" | "paused" | "crewPause" | "loop" | "run" | "kind" | "sessionId" | "repoId"
>;

export const isAgentWorking = (row: MetricRow): boolean => row.hudState === "running";

export const isAgentLive = (row: MetricRow): boolean =>
  !row.paused && !row.crewPause && row.hudState !== "stopped" && row.hudState !== "error";

export const isAgentBlocked = (row: MetricRow): boolean =>
  BLOCKED_STATES.includes(row.hudState) ||
  // A paused loop shows as parked: that is the operator's hold, not a block.
  (row.hudState === "parked" && !row.paused) ||
  (row.loop?.phase === "parked" && row.run !== null && row.run.endedAt === null);

/** A figure as a page shows it; null while its source loads. */
export interface MetricReading {
  value: string;
  /** The context line beside it ("of 11 agents", "p85 31 h · 12 tickets"), else null. */
  detail: string | null;
  /** The value as a number, for colour and idle styling. */
  n: number | null;
}

export interface MetricInputs {
  view: MetricsView | undefined;
  /** `/api/crew` rows already narrowed to the agents in view. */
  rows: readonly MetricRow[] | undefined;
  /** `needsYouItems(...).length`; undefined while attention loads. */
  needsYou: number | undefined;
}

const reading = (value: string, n: number | null, detail: string | null = null): MetricReading => ({
  value,
  n,
  detail,
});
const DASH = "—";

/** Every registry figure from its sources: the one place a value is computed and formatted. */
export function metricReadings({
  view,
  rows,
  needsYou,
}: MetricInputs): Record<MetricId, MetricReading | null> {
  const agents = (pred: (r: MetricRow) => boolean): MetricReading | null => {
    if (!rows) return null;
    const n = rows.filter(pred).length;
    return reading(String(n), n, `of ${rows.length} agents`);
  };
  const ct = view?.cycleTime;
  const blocked = rows?.filter(isAgentBlocked).length;
  return {
    inProgress: view ? reading(String(view.inProgress.count), view.inProgress.count) : null,
    blocked: blocked === undefined ? null : reading(String(blocked), blocked),
    merged: view ? reading(String(view.merged.count), view.merged.count) : null,
    cycleTime: ct
      ? reading(
          ct.p50Ms === null ? DASH : formatHours(ct.p50Ms),
          ct.p50Ms,
          ct.n === 0
            ? "no tickets done"
            : `p85 ${ct.p85Ms === null ? DASH : formatHours(ct.p85Ms)} · ${ct.n} ${ct.n === 1 ? "ticket" : "tickets"}`,
        )
      : null,
    needsYou: needsYou === undefined ? null : reading(String(needsYou), needsYou),
    agentsLive: agents(isAgentLive),
    agentsWorking: agents(isAgentWorking),
    cost: view ? reading(`~$${view.cost.usd.toFixed(2)}`, view.cost.usd) : null,
  };
}
