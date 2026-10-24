import {
  CI_FAILED_EVENT_PREFIX,
  CI_PARK_FAILED_PREFIX,
  CI_RERUN_FAILED_EVENT_PREFIX,
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_LEDGER_KINDS,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_LEDGER_STATUSES,
  FLIGHT_LEDGER_TITLE_MAX,
  FLIGHT_LIST_MAX,
  FLIGHT_METRICS_DAY_MS,
  FLIGHT_SUMMARY_LISTED,
  FLIGHT_WATCH_ORDER,
  type FlightLedgerEntry,
  type FlightLedgerView,
  type FlightMetrics,
  type FlightSummaryItem,
  type FlightSummaryView,
  FOR_THE_CONTROLLER,
  orderLedger,
  parkedEventText,
  priorityRank,
  type TestLockState,
  tokenTotal,
  wakeKeyPrefix,
} from "@mc/core";
import { z } from "zod";
import type { CcConfig } from "../config.ts";
import { crew, NO_LOCK } from "../hud.ts";
import type { Store } from "../store.ts";
import { median } from "../telemetry.ts";
import { flightBriefView, flightHeadline, flightSeat, flightTriageItems } from "./state.ts";
import { cut } from "./tools.ts";

export const FlightLedgerArgs = z.strictObject({
  kind: z.enum(FLIGHT_LEDGER_KINDS).optional(),
  status: z.enum([...FLIGHT_LEDGER_STATUSES, "open", "all"]).default("open"),
  limit: z.number().int().min(1).max(FLIGHT_LIST_MAX).default(FLIGHT_LIST_MAX),
  offset: z.number().int().min(0).default(0),
});

export function flightLedgerView(
  config: CcConfig,
  store: Store,
  args: z.input<typeof FlightLedgerArgs> = {},
): FlightLedgerView {
  const { kind, status, limit, offset } = FlightLedgerArgs.parse(args);
  const session = flightSeat(config)?.session.id ?? null;
  const entries = orderLedger(session === null ? [] : store.flightLedger(session)).filter(
    (e) =>
      (kind === undefined || e.kind === kind) &&
      (status === "all" ||
        (status === "open" ? FLIGHT_LEDGER_OPEN.includes(e.status) : e.status === status)),
  );
  const page = entries.slice(offset, offset + limit);
  const more = offset + page.length < entries.length;
  return { session, entries: page, more, nextOffset: more ? offset + page.length : null };
}

export function flightMetrics(config: CcConfig, store: Store, now: number): FlightMetrics {
  const since = now - FLIGHT_METRICS_DAY_MS;
  const metrics: FlightMetrics = {
    since,
    merged: 0,
    opened: 0,
    inReview: 0,
    inCi: 0,
    ciFailures: 0,
    reruns: 0,
    parks: { day: 0, live: [] },
    seats: [],
    flight: { wakes: 0, costUsd: 0 },
    readyToMergedMin: null,
    forTheController: 0,
  };
  const found = flightSeat(config);
  if (!found) return metrics;
  const { session, seat } = found;
  const prs = store.pullRequests(session.repoId);
  const merged = prs.filter(
    (p) => p.state === "merged" && p.mergedAt !== null && p.mergedAt >= since,
  );
  metrics.merged = merged.length;
  metrics.opened = prs.filter((p) => p.createdAt >= since).length;
  metrics.inReview = prs.filter((p) => p.state === "open" && !p.isDraft).length;
  metrics.inCi = prs.filter((p) => p.state === "open" && p.ci === "pending").length;
  for (const e of store.loopEvents(since, session.repoId)) {
    if (
      e.text.startsWith(CI_FAILED_EVENT_PREFIX) ||
      e.text.startsWith(CI_RERUN_FAILED_EVENT_PREFIX) ||
      e.text.startsWith(parkedEventText(CI_PARK_FAILED_PREFIX))
    )
      metrics.ciFailures++;
    const key = e.key.startsWith(`${e.runId}:`) ? e.key.slice(e.runId.length + 1) : "";
    if (
      (key.startsWith("rerun:") && e.text.includes("; re-ran ")) ||
      /^ruling-rerun:[^:]+$/.test(key)
    )
      metrics.reruns++;
    if (e.text.startsWith(parkedEventText(""))) metrics.parks.day++;
  }
  const parks = new Map<string, number>();
  for (const run of store.loopRuns(now)) {
    if (run.repoId !== session.repoId || run.endedAt !== null || !run.loop?.parked) continue;
    const kind = run.loop.parked.kind;
    parks.set(kind, (parks.get(kind) ?? 0) + 1);
  }
  metrics.parks.live = [...parks]
    .map(([kind, n]) => ({ kind, n }))
    .sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
  const runs = store.runsActiveSince(since).filter((r) => r.repoId === session.repoId);
  metrics.seats = session.seats
    .map((s) => {
      const mine = runs.filter((r) => r.agentId === s.id);
      return {
        seat: s.id,
        tokens: mine.reduce((sum, r) => sum + tokenTotal(r.tokens), 0),
        costUsd: Math.round(mine.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 100) / 100,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.seat.localeCompare(b.seat));
  metrics.flight.costUsd = metrics.seats.find((s) => s.seat === seat.id)?.costUsd ?? 0;
  metrics.flight.wakes = runs
    .filter((r) => r.agentId === seat.id && r.startedAt <= now)
    .reduce(
      (sum, r) =>
        sum +
        Number(r.startedAt >= since) +
        Object.entries(store.claimedKeys(r.id)).filter(
          ([key, at]) => key.startsWith(wakeKeyPrefix(r.id)) && at >= since && at <= now,
        ).length,
      0,
    );
  const readyToMerged = median(store.readyToMergedMinutes(session.repoId, since));
  metrics.readyToMergedMin = readyToMerged === null ? null : Math.round(readyToMerged);
  metrics.forTheController = store
    .flightDecisions(since, FLIGHT_DECISIONS_SCAN_LIMIT)
    .filter(
      (d) => d.about.includes(FOR_THE_CONTROLLER) || d.decision.includes(FOR_THE_CONTROLLER),
    ).length;
  return metrics;
}

export function flightSummary(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState = NO_LOCK,
  hubLogin: string | null = null,
): FlightSummaryView {
  const session = flightSeat(config)?.session.id ?? null;
  const entries = session === null ? [] : store.flightLedger(session);
  const open = entries.filter((e) => FLIGHT_LEDGER_OPEN.includes(e.status));
  const item = (e: FlightLedgerEntry): FlightSummaryItem => ({
    key: e.key,
    kind: e.kind,
    title: e.title,
    status: e.status,
    next: e.next,
    due: e.due,
    priority: e.priority,
    ageMin: Math.floor((now - e.createdAt) / 60_000),
  });
  const priorityAge = (a: FlightLedgerEntry, b: FlightLedgerEntry): number =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.createdAt - b.createdAt ||
    a.key.localeCompare(b.key);
  const counts: FlightSummaryView["watching"]["counts"] = {
    active: 0,
    waiting: 0,
    blocked: 0,
    done: 0,
    dropped: 0,
  };
  for (const e of entries) if (e.kind === "watch") counts[e.status]++;
  const rows = crew(config, store, now, lock, () => null).rows;
  const watching = open.filter((e) => e.kind === "watch");
  for (const watch of flightBriefView(config, store, lock, now, rows).watch ?? []) {
    const status = watch.state === "warn" ? "blocked" : watch.state === "ok" ? "done" : "active";
    counts[status]++;
    if (status === "done") continue;
    watching.push({
      key: `structured:${watch.id}`,
      kind: "watch",
      title: watch.title,
      status,
      next: watch.next,
      due: null,
      priority: null,
      createdAt: watch.updatedAt ?? now,
      updatedAt: watch.updatedAt ?? now,
      owner: null,
      waitsOn: null,
      refs: [],
      outcome: null,
      basis: watch.detail,
    });
  }
  const planned: FlightSummaryItem[] = (session === null ? [] : store.flightPlans(session))
    .filter((p) => p.status === "pending")
    .map((p) => ({
      key: p.id,
      kind: "plan",
      title: cut(p.label, FLIGHT_LEDGER_TITLE_MAX),
      status: p.status,
      next: null,
      due: p.dueAt,
      priority: null,
      ageMin: Math.floor((now - p.createdAt) / 60_000),
    }));
  return {
    session,
    ...flightHeadline(store, session, now),
    now: open
      .filter((e) => e.kind === "work" && (e.status === "active" || e.status === "blocked"))
      .sort(priorityAge)
      .slice(0, FLIGHT_SUMMARY_LISTED)
      .map(item),
    watching: {
      counts,
      top: watching
        .sort(
          (a, b) =>
            FLIGHT_WATCH_ORDER[a.status] - FLIGHT_WATCH_ORDER[b.status] || priorityAge(a, b),
        )
        .slice(0, FLIGHT_SUMMARY_LISTED)
        .map(item),
    },
    next: [...open.filter((e) => e.kind === "commitment").map(item), ...planned]
      .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.key.localeCompare(b.key))
      .slice(0, FLIGHT_SUMMARY_LISTED),
    incoming: new Set([
      ...open.filter((e) => e.kind === "incoming").map((e) => e.key),
      ...flightTriageItems(config, store, now, hubLogin, rows, lock).map((e) => e.key),
    ]).size,
    metrics: flightMetrics(config, store, now),
  };
}
