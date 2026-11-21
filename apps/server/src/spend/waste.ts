/** Spend per merged change, what the crew's wakes cost, and the retrospective's counts. */
import {
  FLIGHT_ACTIVITY_DAYS,
  type FlightDay,
  type Run,
  seatDef,
  WASTE_WINDOW_MS,
  WASTE_WINDOWS,
  type WasteCounts,
  type WasteReport,
  type WasteSpend,
  type WasteWindow,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";

const HOUR_MS = 3_600_000;

interface AgentInfo {
  loop: string;
  vendor: string;
}

/** Each agent's loop kind and vendor, from the config; an agent it does not list is `other`. */
function agentInfo(config: CcConfig): Map<string, AgentInfo> {
  const out = new Map<string, AgentInfo>();
  const vendorOf = (accountId: string): string =>
    config.accounts.find((a) => a.id === accountId)?.vendor ?? "unknown";
  for (const session of config.crew?.sessions ?? []) {
    for (const seat of session.seats) {
      out.set(seat.id, {
        loop: seatDef(seat).loop,
        vendor: seat.modelVendor ?? vendorOf(seat.accountId),
      });
    }
  }
  for (const loop of config.loops) {
    if (!out.has(loop.id)) out.set(loop.id, { loop: "observed", vendor: vendorOf(loop.accountId) });
  }
  return out;
}

/** A run's new tokens: input, output and cache writes (cache reads are the same context read again). */
const runTokens = (r: Run): number =>
  r.tokens === null ? 0 : r.tokens.input + r.tokens.output + r.tokens.cacheCreate;

/** Spend over one window, with each vendor's coverage. A cost is null where no run recorded one. */
function spendFor(config: CcConfig, store: Store, window: WasteWindow, now: number): WasteSpend {
  const since = now - WASTE_WINDOW_MS[window];
  const agents = agentInfo(config);
  const runs = store.waste.runsSince(since);
  const mergedCount = store.waste.mergedBetween(since, now).length;
  const vendors = new Map<
    string,
    { vendor: string; runs: number; runsWithCost: number; costUsd: number | null; tokens: number }
  >();
  let costUsd: number | null = null;
  let buildCost = 0;
  let tokens = 0;
  let buildTokens = 0;
  let withCost = 0;
  for (const r of runs) {
    const info = agents.get(r.agentId);
    const vendor = info?.vendor ?? "unknown";
    const v = vendors.get(vendor) ?? { vendor, runs: 0, runsWithCost: 0, costUsd: null, tokens: 0 };
    v.runs += 1;
    const tk = runTokens(r);
    v.tokens += tk;
    tokens += tk;
    const build = info?.loop === "build";
    if (build) buildTokens += tk;
    if (r.costUsd !== null) {
      v.runsWithCost += 1;
      v.costUsd = (v.costUsd ?? 0) + r.costUsd;
      costUsd = (costUsd ?? 0) + r.costUsd;
      withCost += 1;
      if (build) buildCost += r.costUsd;
    }
    vendors.set(vendor, v);
  }
  return {
    window,
    since,
    merged: mergedCount,
    costUsd,
    runs: runs.length,
    runsWithCost: withCost,
    tokens,
    perMergeUsd: costUsd === null || mergedCount === 0 ? null : costUsd / mergedCount,
    perMergeTokens: mergedCount === 0 ? null : tokens / mergedCount,
    buildingShareUsd: costUsd === null || costUsd === 0 ? null : buildCost / costUsd,
    buildingShareTokens: tokens === 0 ? null : buildTokens / tokens,
    vendors: [...vendors.values()].sort((a, b) => a.vendor.localeCompare(b.vendor)),
  };
}

/** What GET /waste serves: spend per merged change, the building share, open alarms and each check's record. */
export function wasteReport(config: CcConfig, store: Store, now: number): WasteReport {
  return {
    at: now,
    spend: WASTE_WINDOWS.map((w) => spendFor(config, store, w, now)),
    alarms: [],
    checks: [],
    flight: flightActivity(config, store, now),
    counts: latestCounts(config, store),
  };
}

/** The latest daily retrospective's counts, or null before the first. */
function latestCounts(config: CcConfig, store: Store): WasteCounts | null {
  for (const repoId of new Set(config.crew?.sessions.map((s) => s.repoId))) {
    const report = store.retrospectives(repoId)[0] as { counts?: WasteCounts } | undefined;
    if (report?.counts !== undefined) return report.counts;
  }
  return null;
}

/** The retrospective's counts over [since, now]: tickets, runs per ticket, review rounds, idle seat-hours. */
export function wasteCounts(
  config: CcConfig,
  store: Store,
  repoId: string,
  day: string,
  since: number,
  now: number,
): WasteCounts {
  const q = store.waste;
  const opened = q.ticketsOpened(since).filter((o) => o.repoId === repoId).length;
  const closed = q.ticketsClosed(since).get(repoId) ?? 0;
  const perTicket = new Map<string, number>();
  for (const r of q.runsSince(since))
    if (r.repoId === repoId && r.ticket !== null && r.reviewId === null)
      perTicket.set(r.ticket, (perTicket.get(r.ticket) ?? 0) + 1);
  const busiest = [...perTicket].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const reviews = store.reviewsIn(["reported"], { repo: repoId, since, until: now });
  const failed = reviews.filter(
    (r) => r.blocking > 0 || r.verdict?.spec === "fail" || r.verdict?.quality === "fail",
  ).length;
  const seats = new Set(config.crew?.sessions.flatMap((s) => s.seats.map((x) => x.id)));
  const spans = new Map<string, { state: string; at: number }>();
  let idleMs = 0;
  const close = (id: string, until: number) => {
    const open = spans.get(id);
    if (open?.state === "idle") idleMs += Math.max(0, until - open.at);
  };
  // each seat starts the window in the state it was last left in, so a quiet seat still counts
  const before = q.agentStatesBefore(since);
  for (const id of seats) {
    const state = before.get(id) ?? store.seatSession(id)?.state;
    if (state !== undefined) spans.set(id, { state, at: since });
  }
  for (const e of store.agentEvents(since)) {
    if (!seats.has(e.agentId) || e.at > now) continue;
    if (!spans.has(e.agentId)) spans.set(e.agentId, { state: e.from, at: since });
    close(e.agentId, e.at);
    spans.set(e.agentId, { state: e.to, at: e.at });
  }
  for (const id of spans.keys()) close(id, now);
  return {
    day,
    at: now,
    since,
    ticketsOpened: opened,
    ticketsClosed: closed,
    ticketsWithRuns: perTicket.size,
    runsPerTicket: {
      mean:
        perTicket.size === 0
          ? null
          : [...perTicket.values()].reduce((n, x) => n + x, 0) / perTicket.size,
      max: busiest?.[1] ?? null,
      maxTicket: busiest?.[0] ?? null,
    },
    reviewRounds: { reported: reviews.length, failed },
    idleSeatHours: idleMs / HOUR_MS,
  };
}

/** FLIGHT's wakes, waits and token share in each of the last FLIGHT_ACTIVITY_DAYS 24-hour buckets. */
function flightActivity(config: CcConfig, store: Store, now: number): FlightDay[] {
  const since = now - FLIGHT_ACTIVITY_DAYS * 24 * HOUR_MS;
  const agents = agentInfo(config);
  const days: FlightDay[] = Array.from({ length: FLIGHT_ACTIVITY_DAYS }, (_, i) => ({
    since: since + i * 24 * HOUR_MS,
    wakes: 0,
    flightTokens: 0,
    totalTokens: 0,
    tokenShare: null,
  }));
  const bucket = (at: number): FlightDay | undefined =>
    at > now
      ? undefined
      : days[Math.min(FLIGHT_ACTIVITY_DAYS - 1, Math.floor((at - since) / (24 * HOUR_MS)))];
  for (const w of store.flightWakes(since)) {
    const d = bucket(w.at);
    if (d !== undefined) d.wakes += 1;
  }
  for (const r of store.waste.runsSince(since)) {
    const d = bucket(r.startedAt);
    if (d === undefined) continue;
    const tk = runTokens(r);
    d.totalTokens += tk;
    if (agents.get(r.agentId)?.loop === "watch") d.flightTokens += tk;
  }
  for (const d of days) d.tokenShare = d.totalTokens === 0 ? null : d.flightTokens / d.totalTokens;
  return days;
}
