import type { Crew, MachineView, Telemetry } from "@mc/core";
import { useNow } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dur, elapsed, percent } from "../fmt.ts";
import { sessionTag, useMetrics } from "../metrics.ts";
import { NEEDS_YOU_PATH, PAGE_PATHS, telemetryPath } from "../router.ts";
import { DASH } from "./common.ts";
import { crewCounts, crewVerdict, quotaWindows, tightestQuota } from "./health.ts";
import { Stat, type StatSpec } from "./Stat.tsx";

/** Days the cost comparison averages over, and the days the Merged comparison averages over. */
const COST_DAYS = 7;
const MERGED_DAYS = 14;

interface Inputs {
  /** The page's unfiltered telemetry: today, 14-day and now figures do not depend on the range. */
  t: Telemetry | undefined;
  /** A 7-day read, for the cost comparison. */
  t7: Telemetry | undefined;
  crew: Crew | undefined;
  machine: MachineView | undefined;
  now: number;
  /** The registry's cost and merged readings (`useMetrics`), so every page shows one value. */
  registry: { cost: string | undefined; merged: string | undefined; session: string | null };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** The memory share free now: the OS's pressure reading, else what is left of the installed memory. */
function memFreePct(m: MachineView | undefined): number | null {
  const s = m?.latest;
  if (!s) return null;
  if (s.memoryPressureFreePct != null) return s.memoryPressureFreePct;
  return s.memUsedBytes == null ? null : (1 - s.memUsedBytes / s.memTotalBytes) * 100;
}

/** The band's eight stats; `—` for a figure still loading or not recorded. */
export function healthStats({ t, t7, crew, machine, now, registry }: Inputs): StatSpec[] {
  const counts = crew ? crewCounts(crew.rows) : null;
  const quotas = quotaWindows(t);
  const verdict =
    counts && t && machine
      ? crewVerdict({ quotas, machineWarning: machine.warning, crew: counts })
      : null;
  const tight = tightestQuota(quotas);
  const days = t?.throughput ?? [];
  // The registry's cost and merged follow the header's session filter; the comparisons are crew-wide.
  const scoped = registry.session !== null;
  const followed = scoped
    ? ` On Telemetry this follows the header's session filter (${registry.session}); the comparison is crew-wide, so it is left out.`
    : "";
  const mergedMean = days.length > 0 ? sum(days.map((d) => d.merged)) / days.length : null;
  const spend7 = t7 ? t7.totals.map((r) => r.costUsd).filter((c): c is number => c !== null) : [];
  const costAvg = spend7.length > 0 ? sum(spend7) / COST_DAYS : null;
  const q = t?.quality;
  const mem = memFreePct(machine);
  const cpu = machine?.latest?.cpuPct ?? null;
  const reset = tight?.resetAt != null && tight.resetAt > now ? elapsed(tight.resetAt - now) : null;
  return [
    {
      id: "health",
      label: "Crew health",
      value: verdict?.word ?? DASH,
      unit: "verdict",
      window: "now",
      definition:
        "Needs attention for a quota at its stop level, a machine capacity warning, or a stalled or errored seat. Watch for a quota at its alert level or a seat question waiting. Otherwise Healthy.",
      drill: { kind: "link", href: NEEDS_YOU_PATH, target: "the Needs you list" },
      detail: verdict?.reason,
      verdict: verdict?.word,
    },
    {
      id: "response",
      label: "Your response",
      value: t?.capcom?.medianMs != null ? dur(t.capcom.medianMs) : DASH,
      unit: "median",
      window: "today",
      definition: "Median time you took to answer a seat's question today.",
      drill: { kind: "needs-route", target: "the runs for each answered question" },
      detail: t?.capcom ? `${t.capcom.answered} answered` : undefined,
    },
    {
      id: "cost",
      label: "~Cost",
      value: registry.cost ?? DASH,
      metric: "cost",
      unit: "USD",
      window: scoped ? `today · ${registry.session}` : "today",
      definition: `API-equivalent estimate of today's spend; a subscription is not billed per token. Compared with the average day of the last ${COST_DAYS} days (the hub sends no daily series, so this is the ${COST_DAYS}-day total divided by ${COST_DAYS}).${followed}`,
      drill: { kind: "needs-route", target: "the runs that make up today's cost" },
      detail:
        costAvg === null || scoped ? undefined : `vs ${cost(costAvg)} ${COST_DAYS}-day average`,
    },
    {
      id: "merged",
      label: "Merged",
      value: registry.merged ?? DASH,
      metric: "merged",
      unit: "PRs",
      window: scoped ? `today · ${registry.session}` : "today",
      definition: `Pull requests merged today, compared with the daily mean of the last ${MERGED_DAYS} days.${followed}`,
      drill: { kind: "link", href: PAGE_PATHS.board, target: "Board, stage merged" },
      detail:
        mergedMean === null ? undefined : `vs ${mergedMean.toFixed(1)} ${MERGED_DAYS}-day mean`,
    },
    {
      id: "ci",
      label: "CI first push",
      value: q?.ciGreenFirstPushPct != null ? percent(q.ciGreenFirstPushPct) : DASH,
      unit: "% of merged PRs",
      window: "14d",
      definition: "Share of merged PRs whose checks were green on the first push, last 14 days.",
      drill: { kind: "needs-route", target: "the merged PRs behind this share" },
      detail: q ? `${q.prs} merged PRs` : undefined,
    },
    {
      id: "review",
      label: "First-pass review",
      value: q?.firstPassReviewPct != null ? percent(q.firstPassReviewPct) : DASH,
      unit: "% of reviewed PRs",
      window: "14d",
      definition: "Share of reviewed PRs with no blocking finding in round 1, last 14 days.",
      drill: { kind: "needs-route", target: "the reviewed PRs behind this share" },
      detail: q?.reviewedPrs !== undefined ? `${q.reviewedPrs} reviewed PRs` : undefined,
    },
    {
      id: "quota",
      label: "Tightest quota",
      value: tight ? percent(tight.pct) : DASH,
      unit: "% used",
      window: "now",
      definition:
        "Highest used share of any account window, with its reset. Alert and stop levels are set per account.",
      drill: { kind: "link", href: telemetryPath("cost"), target: "Cost and tokens, Quota used" },
      detail: tight ? `${tight.name}${reset ? ` · resets in ${reset}` : ""}` : undefined,
    },
    {
      id: "machine",
      label: "Machine",
      value: mem === null ? DASH : percent(mem),
      unit: "% memory free",
      window: "now",
      definition:
        "Memory free now, with CPU and the capacity warning. The hub holds new work when memory runs low or CPU runs high.",
      drill: { kind: "link", href: telemetryPath("machine"), target: "Machine, CPU and memory" },
      detail: machine
        ? `CPU ${cpu === null ? DASH : percent(cpu)} · ${machine.warning ? "capacity warning" : "no warning"}`
        : undefined,
    },
  ];
}

/** The health band: eight figures, one row, on every tab. */
export function HealthBand({
  t,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const t7 = useResource<Telemetry>(RESOURCES.telemetry("7d")).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const machine = useResource<MachineView>(RESOURCES.machine).data;
  const now = useNow();
  const metrics = useMetrics();
  const registry = {
    cost: metrics.readings.cost?.value,
    merged: metrics.readings.merged?.value,
    session: sessionTag(metrics.session),
  };
  const stats = healthStats({ t, t7, crew, machine, now, registry });
  return (
    <section className="band" aria-label="Health band">
      {stats.map((s) => (
        <Stat key={s.id} stat={s} onNeedsRoute={onNeedsRoute} />
      ))}
    </section>
  );
}
