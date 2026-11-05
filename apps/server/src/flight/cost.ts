/** What FLIGHT costs and how long its callers wait: read-only figures from the store. */
import {
  COMMS_CAPCOM,
  FLIGHT_COST_DAYS,
  type FlightWakeCost,
  type FlightWakeWaits,
} from "@mc/core";
import { runSpend } from "../spend.ts";
import type { Store } from "../store.ts";
import { flightSignalHistory } from "./signals.ts";

const DAY_MS = 24 * 60 * 60_000;
/** The reason for cost before a run's first wake: its start brief. */
export const START_REASON = "start";
const UNATTRIBUTED = "unattributed";

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const dayIndex = (at: number, since: number, days: number): number =>
  Math.min(days - 1, Math.max(0, Math.floor((at - since) / DAY_MS)));

/**
 * FLIGHT's cost in the last `days` days. A run's cost is spread over its messages by tokens; each
 * message belongs to the latest wake of its run at or before it (or to "start"), and a wake's share
 * is split evenly over the reasons that woke it.
 */
export function flightWakeCost(
  store: Store,
  now: number,
  flightId: string,
  crewIds: ReadonlySet<string>,
  days = FLIGHT_COST_DAYS,
): FlightWakeCost {
  const since = now - days * DAY_MS;
  const runs = store.runsOverlapping(since, now + 1).filter((r) => crewIds.has(r.agentId));
  const digests = store.digests(runs.map((r) => r.id));
  const wakes = new Map<string, { at: number; reasons: string[] }[]>();
  for (const w of store.flightWakes(since)) {
    const list = wakes.get(w.runId) ?? [];
    list.push(w);
    wakes.set(w.runId, list);
  }
  const byDay = Array.from({ length: days }, (_, i) => ({
    at: since + i * DAY_MS,
    usd: 0,
    crewUsd: 0,
  }));
  const reasons = new Map<string, { usd: number; wakes: number }>();
  const add = (reason: string, usd: number, wake: boolean) => {
    const r = reasons.get(reason) ?? { usd: 0, wakes: 0 };
    r.usd += usd;
    if (wake) r.wakes += 1;
    reasons.set(reason, r);
  };
  let totalUsd = 0;
  let crewUsd = 0;
  for (const run of runs) {
    const digest = digests.get(run.id);
    const spend = runSpend(run, digest, since, now, DAY_MS);
    for (let i = 0; i < days; i++) {
      const day = byDay[i];
      if (day !== undefined) day.crewUsd += spend[i] ?? 0;
    }
    crewUsd += spend.reduce((n, x) => n + x, 0);
    if (run.agentId !== flightId) continue;
    const own = (wakes.get(run.id) ?? []).sort((a, b) => a.at - b.at);
    const entries = (digest?.attemptUsage ?? []).filter((u) => u.at !== null);
    const tokens = (digest?.attemptUsage ?? []).reduce((n, u) => n + u.tokens, 0);
    if (tokens <= 0) {
      // no timestamped usage: the cost is by wall time, with no wake to blame
      const usd = spend.reduce((n, x) => n + x, 0);
      for (let i = 0; i < days; i++) {
        const day = byDay[i];
        if (day !== undefined) day.usd += spend[i] ?? 0;
      }
      totalUsd += usd;
      if (usd > 0) add(UNATTRIBUTED, usd, false);
      continue;
    }
    const counted = new Set<number>();
    for (const u of entries) {
      const at = u.at as number;
      if (at < since || at > now) continue;
      const usd = ((run.costUsd ?? 0) * u.tokens) / tokens;
      totalUsd += usd;
      const day = byDay[dayIndex(at, since, days)];
      if (day !== undefined) day.usd += usd;
      const wake = own.filter((w) => w.at <= at).at(-1);
      if (wake === undefined) {
        add(START_REASON, usd, false);
        continue;
      }
      const list = wake.reasons.length > 0 ? wake.reasons : [UNATTRIBUTED];
      for (const reason of list) add(reason, usd / list.length, !counted.has(wake.at));
      counted.add(wake.at);
    }
  }
  const week = byDay.slice(-7);
  const weekCrew = week.reduce((n, d) => n + d.crewUsd, 0);
  return {
    since,
    totalUsd,
    crewUsd,
    share: crewUsd > 0 ? totalUsd / crewUsd : null,
    weekShare: weekCrew > 0 ? week.reduce((n, d) => n + d.usd, 0) / weekCrew : null,
    byDay,
    byReason: [...reasons]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.usd - a.usd || a.reason.localeCompare(b.reason)),
  };
}

/**
 * How long each message from the operator, each blocker to FLIGHT and each seat call waited for
 * FLIGHT to act: until the first wake at or after it, or the first message FLIGHT's run produced
 * after it, whichever is earlier (a labelled blocker or an interrupting message reaches FLIGHT
 * without a recorded wake). Waits not yet ended are left out. Seat calls are read from `repo`'s
 * signal record, which keeps a week.
 */
export function flightWakeWaits(
  store: Store,
  now: number,
  flightId: string,
  repo?: string,
  days = FLIGHT_COST_DAYS,
): FlightWakeWaits {
  const since = now - days * DAY_MS;
  const seen = new Set(store.flightWakes(since).map((w) => w.at));
  const flightRuns = store.runsOverlapping(since, now + 1).filter((r) => r.agentId === flightId);
  const digests = store.digests(flightRuns.map((r) => r.id));
  for (const run of flightRuns)
    for (const u of digests.get(run.id)?.attemptUsage ?? []) if (u.at !== null) seen.add(u.at);
  const times = [...seen].sort((a, b) => a - b);
  const operator: number[][] = Array.from({ length: days }, () => []);
  const blocker: number[][] = Array.from({ length: days }, () => []);
  const record = (list: number[][], at: number) => {
    const end = times.find((t) => t >= at);
    if (end !== undefined) list[dayIndex(at, since, days)]?.push(end - at);
  };
  for (const m of store.commsTo(flightId, since)) {
    if (m.at > now) continue;
    if (m.from === COMMS_CAPCOM) record(operator, m.at);
    else if (m.label === "blocker") record(blocker, m.at);
  }
  if (repo !== undefined)
    for (const s of flightSignalHistory(store, repo, now))
      if (s.kind === "seat_call" && s.since >= since && s.since <= now) record(blocker, s.since);
  return {
    since,
    operatorMedianMs: median(operator.flat()),
    blockerMedianMs: median(blocker.flat()),
    byDay: operator.map((o, i) => ({
      at: since + i * DAY_MS,
      operatorMedianMs: median(o),
      operatorN: o.length,
      blockerMedianMs: median(blocker[i] ?? []),
      blockerN: blocker[i]?.length ?? 0,
    })),
  };
}
