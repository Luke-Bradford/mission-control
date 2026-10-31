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

/** "now", "today", "24h" or a day count such as "14d". */
export type MetricWindow = string;
export type MetricUnit =
  | "tickets"
  | "agents"
  | "PRs"
  | "hours"
  | "items"
  | "USD"
  | "characters"
  | "defects"
  | "milliseconds"
  | "rounds"
  | "test files"
  | "quota percentage points per interval";

export interface MetricDef {
  label: string;
  window: MetricWindow;
  unit: MetricUnit;
  /** What is counted and what is left out, in the operator's words; shown on hover. */
  definition: string;
  /** Where the value comes from. */
  source: string;
  /** The resource the value waits on: its load error is the figure's error. */
  from: "server" | "crew" | "attention";
}

/** Cycle time looks back over the flow window: enough finished tickets for a p85 to mean something. */
export const CYCLE_TIME_DAYS = FLOW_DAYS;
export const MERGED_WINDOW_MS = 24 * 60 * 60_000;
/** Below this many finished tickets a p85 is noise, so it is not shown. */
export const CYCLE_TIME_MIN_FOR_P85 = 5;

const CREW_REPOS = "Scope: the crew sessions' repos, or the selected session's repo.";
const ALL_REPOS =
  "Scope: every configured repo, observed loops' included, or the selected session's repo.";
const CREW_AGENTS = "Scope: crew seats and FLIGHT under the header's session filter.";
const ALL_AGENTS =
  "Scope: crew seats, FLIGHT and observed loops under the header's session filter.";

/**
 * A crew seat parked by a rate limit resumes on its own, so it is not blocked. The supervisor
 * writes this reason (apps/server/src/runtime/supervisor.ts, a hard-rule file, hence no shared
 * constant there).
 */
const RATE_LIMIT_PARK = /^rate[ -]limited\b/i;

export const METRICS: Readonly<Record<MetricId, MetricDef>> = {
  inProgress: {
    label: "In progress",
    window: "now",
    unit: "tickets",
    definition: `Tickets started and not yet merged: an agent is building them, or their PR is in checks, review or merging. Ready tickets nobody has started are not counted. ${CREW_REPOS}`,
    source: "GET /api/metrics (the Overview pipeline)",
    from: "server",
  },
  blocked: {
    label: "Blocked",
    window: "now",
    unit: "agents",
    definition: `Crew seats that cannot move without someone: waiting on a question, stalled, parked or in error. A seat parked by a rate limit resumes on its own and is not counted; an observed loop's hold is in Needs you instead. ${CREW_AGENTS}`,
    source: "GET /api/crew",
    from: "crew",
  },
  merged: {
    label: "Merged",
    window: "24h",
    unit: "PRs",
    definition: `Pull requests merged in the last 24 hours, linked to a ticket or not. ${CREW_REPOS} Merges in the observed loops' own repos show beside it as "+N loops".`,
    source: "GET /api/metrics",
    from: "server",
  },
  cycleTime: {
    label: "Cycle time p50",
    window: `${CYCLE_TIME_DAYS}d`,
    unit: "hours",
    definition: `Hours from a ticket's first move into Ready (or a later column) to Done, for tickets done in the last ${CYCLE_TIME_DAYS} days. p50 is the median; p85 is the time 85% of tickets beat, shown from ${CYCLE_TIME_MIN_FOR_P85} tickets. Done tickets with no Ready entry, or timestamps out of order, are left out and counted. ${ALL_REPOS}`,
    source: "GET /api/metrics (the board's flow history)",
    from: "server",
  },
  needsYou: {
    label: "Needs you",
    window: "now",
    unit: "items",
    definition:
      "Your whole inbox: every open item that is yours to act on, counted once. The session filter never hides one.",
    source: "GET /api/attention through needsYouItems (apps/web/src/attention.ts)",
    from: "attention",
  },
  agentsLive: {
    label: "Agents live",
    window: "now",
    unit: "agents",
    definition: `Agents able to take work now: not paused (by you or a crew pause), parked, blocked, stalled, stopped or in error. ${ALL_AGENTS}`,
    source: "GET /api/crew",
    from: "crew",
  },
  agentsWorking: {
    label: "Agents working",
    window: "now",
    unit: "agents",
    definition: `Agents running a turn right now. ${ALL_AGENTS}`,
    source: "GET /api/crew",
    from: "crew",
  },
  cost: {
    label: "Cost",
    window: "today",
    unit: "USD",
    definition: `API-equivalent cost of runs since local midnight; a subscription isn't billed per token. "—" when no run reported a cost. ${ALL_REPOS}`,
    source: "GET /api/metrics",
    from: "server",
  },
};

/** Range-scoped chart figures. They live beside the shared KPI registry so definitions, units and
 * windows remain a single source of truth without making them header metrics. */
export const TELEMETRY_METRICS = {
  throughput: {
    label: "Throughput",
    window: "selected range",
    unit: "tickets",
    definition: `Tickets with a pull request merged in the selected range, grouped into timestamped buckets. Empty buckets are zero. ${CREW_REPOS}`,
    source: "GET /api/telemetry (series.throughput)",
    from: "server",
  },
  quality: {
    label: "Quality",
    window: "selected range, daily",
    unit: "PRs",
    definition: `Daily CI first-pass rate, review pass rate and review rounds for merged pull requests. A day without evidence is null, never zero. ${CREW_REPOS}`,
    source: "GET /api/telemetry (series.quality)",
    from: "server",
  },
  quotaBurn: {
    label: "Quota burn",
    window: "selected range",
    unit: "quota percentage points per interval",
    definition: `Positive changes in an account window's used percentage, grouped into the selected range's timestamped intervals. Projected exhaustion uses that range's total burn pace; no spend means no projection. ${CREW_REPOS}`,
    source: "GET /api/telemetry (series.quota.burn, series.quota.projectedExhaustionAt)",
    from: "server",
  },
  costPerMergedTicket: {
    label: "Cost per merged ticket",
    window: "selected range",
    unit: "USD",
    definition: `All observed run cost for each ticket whose pull request merged in the selected range, including work before the range. The in-range cost remains available separately. ${CREW_REPOS}`,
    source: "GET /api/telemetry (tokensByTicket.totalCostUsd)",
    from: "server",
  },
} as const satisfies Readonly<Record<string, MetricDef>>;

/** Range-scoped Comms figures, shared by the Comms page and the hub route. */
export const COMMS_METRICS = {
  messageLengthP95: {
    label: "Message length p95",
    window: "24h",
    unit: "characters",
    definition:
      "The 95th-percentile message length for each sender over the shared 24-hour Comms range. Messages sent before the range are left out.",
    source: "GET /api/comms/metrics (p95BySeat)",
    from: "server",
  },
} as const satisfies Readonly<Record<string, MetricDef>>;

export interface CommsMetricsView {
  /** Matches the shared 24-hour Comms graph range. */
  from: number;
  to: number;
  p95BySeat: { seatId: string; p95: number | null; n: number }[];
}

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
  /** `count`: the crew sessions' repos; `loops`: the other repos in view (observed loops'). */
  merged: { count: number; loops: number };
  cycleTime: { p50Ms: number | null; p85Ms: number | null; n: number; excluded: number };
  /** null when no run in scope reported a cost. */
  cost: { usd: number | null };
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

/** Hours, one decimal under 10: "0.4 h", "9.9 h", "10 h", "14 h" (9.96 h reads "10 h"). */
export function formatHours(ms: number): string {
  const h = ms / 3_600_000;
  const tenths = Math.round(h * 10) / 10;
  return `${tenths < 10 ? tenths.toFixed(1) : String(Math.round(h))} h`;
}

/** The cycle-time context line: "p85 31 h · 12 tickets · 3 left out"; no p85 under five tickets. */
export function cycleTimeDetail(ct: MetricsView["cycleTime"]): string {
  const parts = [
    ...(ct.n >= CYCLE_TIME_MIN_FOR_P85 && ct.p85Ms !== null
      ? [`p85 ${formatHours(ct.p85Ms)}`]
      : []),
    `${ct.n} ${ct.n === 1 ? "ticket" : "tickets"}`,
    ...(ct.excluded > 0 ? [`${ct.excluded} left out`] : []),
  ];
  return parts.join(" · ");
}

const BLOCKED_STATES: readonly CrewRow["hudState"][] = ["blocked", "stalled", "error"];
const NOT_LIVE_STATES: readonly CrewRow["hudState"][] = [...BLOCKED_STATES, "parked", "stopped"];

export type MetricRow = Pick<
  CrewRow,
  "hudState" | "paused" | "crewPause" | "loop" | "run" | "kind" | "sessionId" | "repoId" | "note"
>;

const openLoopPark = (row: MetricRow): boolean =>
  row.loop?.phase === "parked" && row.run !== null && row.run.endedAt === null;

/** Parked by a rate limit: it resumes on its own. */
const rateLimited = (row: MetricRow): boolean =>
  (row.hudState === "parked" && RATE_LIMIT_PARK.test(row.note ?? "")) ||
  (openLoopPark(row) && RATE_LIMIT_PARK.test(row.loop?.parked ?? ""));

export const isAgentWorking = (row: MetricRow): boolean => row.hudState === "running";

/**
 * A crew seat that needs someone to move: blocked, stalled, parked or in error, or its open loop
 * parked. Observed loops are not counted: their holds reach Needs you. Rate-limit parks resume.
 */
export const isAgentBlocked = (row: MetricRow): boolean =>
  row.kind === "crew" &&
  !rateLimited(row) &&
  (BLOCKED_STATES.includes(row.hudState) || row.hudState === "parked" || openLoopPark(row));

/** Able to take work now: not paused, parked, blocked, stalled, stopped or in error. */
export const isAgentLive = (row: MetricRow): boolean =>
  !row.paused && !row.crewPause && !NOT_LIVE_STATES.includes(row.hudState) && !isAgentBlocked(row);

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

/** API-equivalent dollars, always marked as an estimate: "~$12.35". */
export const usd = (n: number): string => `~$${n.toFixed(2)}`;

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
    merged: view
      ? reading(
          String(view.merged.count),
          view.merged.count,
          view.merged.loops > 0 ? `+${view.merged.loops} loops` : null,
        )
      : null,
    cycleTime: ct
      ? reading(
          ct.p50Ms === null ? DASH : formatHours(ct.p50Ms),
          ct.p50Ms,
          ct.n === 0 ? "no tickets done" : cycleTimeDetail(ct),
        )
      : null,
    needsYou: needsYou === undefined ? null : reading(String(needsYou), needsYou),
    agentsLive: agents(isAgentLive),
    agentsWorking: agents(isAgentWorking),
    cost: view ? reading(view.cost.usd === null ? DASH : usd(view.cost.usd), view.cost.usd) : null,
  };
}
