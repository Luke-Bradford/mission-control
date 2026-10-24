import {
  CI_FAILED_EVENT_PREFIX,
  CI_PARK_FAILED_PREFIX,
  CI_RERUN_FAILED_EVENT_PREFIX,
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_HEADLINE,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_LEDGER_TITLE_MAX,
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
  tokenTotal,
  wakeKeyPrefix,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { parseTicket } from "../runview.ts";
import type { Store } from "../store.ts";
import { median } from "../telemetry.ts";
import { flightSeat } from "./state.ts";
import { cut } from "./tools.ts";

export function flightLedgerView(config: CcConfig, store: Store): FlightLedgerView {
  const session = flightSeat(config)?.session.id ?? null;
  return { session, entries: session === null ? [] : orderLedger(store.flightLedger(session)) };
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
  metrics.flight.wakes = store
    .runs(seat.id, 50)
    .reduce(
      (sum, r) =>
        sum +
        Object.entries(store.claimedKeys(r.id)).filter(
          ([key, at]) => key.startsWith(wakeKeyPrefix(r.id)) && at >= since,
        ).length,
      0,
    );
  const issues = store.flowIssues(0);
  const minutes = merged.flatMap((p) => {
    const ticket = p.ticket === null ? null : parseTicket(p.ticket);
    const issue =
      ticket === null
        ? undefined
        : issues.find((i) => i.repoId === ticket.repoId && i.number === ticket.number);
    return issue?.startAt == null || p.mergedAt === null || issue.startAt > p.mergedAt
      ? []
      : [(p.mergedAt - issue.startAt) / 60_000];
  });
  const readyToMerged = median(minutes);
  metrics.readyToMergedMin = readyToMerged === null ? null : Math.round(readyToMerged);
  metrics.forTheController = store
    .flightDecisions(since, FLIGHT_DECISIONS_SCAN_LIMIT)
    .filter(
      (d) => d.about.includes(FOR_THE_CONTROLLER) || d.decision.includes(FOR_THE_CONTROLLER),
    ).length;
  return metrics;
}

export function flightSummary(config: CcConfig, store: Store, now: number): FlightSummaryView {
  const { session, entries } = flightLedgerView(config, store);
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
    headline:
      session === null
        ? ""
        : (store.flightBrief(session).find((r) => r.section === FLIGHT_HEADLINE)?.text ?? ""),
    now: open
      .filter((e) => e.kind === "work" && (e.status === "active" || e.status === "blocked"))
      .sort(priorityAge)
      .slice(0, FLIGHT_SUMMARY_LISTED)
      .map(item),
    watching: {
      counts,
      top: open
        .filter((e) => e.kind === "watch")
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
    incoming: open.filter((e) => e.kind === "incoming").length,
    metrics: flightMetrics(config, store, now),
  };
}
