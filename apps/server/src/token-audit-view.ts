import {
  FLIGHT_WAKE_IDLE_MS,
  type Run,
  TOKEN_AUDIT_OVER_BUDGET_RUNS,
  TOKEN_AUDIT_TOP_RUNS,
  TOKEN_CONTEXT_BUDGET,
  type TokenAuditFigure,
  type TokenAuditFigures,
  type TokenAuditNamed,
  type TokenAuditRole,
  type TokenAuditRunRef,
  type TokenAuditView,
  type TokenCounts,
} from "@mc/core";
import { type CcConfig, configuredAgents } from "./config.ts";
import { flightWakeCost } from "./flight/cost.ts";
import { flightSeat } from "./flight/seat.ts";
import type { Store } from "./store.ts";

const DAY_MS = 86_400_000;
/** The role name shown for an observed loop, which has none. */
export const LOOP_ROLE = "loop";

type Top = Map<string, TokenAuditRunRef>;

const merge = (
  into: Map<string, TokenCounts>,
  from: Record<string, TokenCounts>,
  top: Top,
  run: Run,
) => {
  for (const [name, c] of Object.entries(from)) {
    const best = top.get(name);
    if (best === undefined || c.reread > best.value)
      top.set(name, { runId: run.id, agentId: run.agentId, ticket: run.ticket, value: c.reread });
    const t = into.get(name) ?? { added: 0, reread: 0, events: 0 };
    t.added += c.added;
    t.reread += c.reread;
    t.events += c.events;
    into.set(name, t);
  }
};

const named = (m: Map<string, TokenCounts>, top: Top): TokenAuditNamed[] => {
  const total = [...m.values()].reduce((s, c) => s + c.reread, 0);
  return [...m]
    .map(([name, c]) => ({
      name,
      ...c,
      share: total > 0 ? c.reread / total : 0,
      topRun: top.get(name) ?? null,
    }))
    .sort((a, b) => b.reread - a.reread || a.name.localeCompare(b.name));
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

/** Nearest-rank 90th percentile; 0 for no values. */
const p90 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.9) - 1)] ?? 0;
};

const ref = (run: Run, value: number): TokenAuditRunRef => ({
  runId: run.id,
  agentId: run.agentId,
  ticket: run.ticket,
  value,
});

const missing = (reason: string): { recorded: false; reason: string } => ({
  recorded: false,
  reason,
});

/** The stored token audits of runs started in the last `days` days, summed for `GET /api/audit/tokens`. */
export function tokenAuditView(
  store: Store,
  config: CcConfig,
  now: number,
  days: number,
): TokenAuditView {
  const since = now - days * DAY_MS;
  const roles = new Map<string, string>(
    configuredAgents(config).map((a) => [a.id, a.kind === "loop" ? LOOP_ROLE : a.seat.role]),
  );
  const rows = store.runTokenAudits(since);
  const bySource = new Map<string, TokenCounts>();
  const byCommand = new Map<string, TokenCounts>();
  const sourceTop: Top = new Map();
  const commandTop: Top = new Map();
  const byRole = new Map<string, TokenAuditRole & { peaks: number[] }>();
  const view = {
    runs: rows.length,
    calls: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reread: 0,
    rewrites: 0,
  };
  let readAfter = 0;
  let readWithReport = 0;
  const topRuns = rows.map(({ run, audit }) => {
    const reread = Object.values(audit.bySource).reduce((s, c) => s + c.reread, 0);
    const roleName = roles.get(run.agentId) ?? "unknown";
    const role = byRole.get(roleName) ?? {
      role: roleName,
      runs: 0,
      calls: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reread: 0,
      rewrites: 0,
      medianPeakContext: 0,
      peaks: [] as number[],
    };
    role.runs += 1;
    role.calls += audit.calls;
    role.output += audit.output;
    role.cacheRead += audit.cacheRead;
    role.cacheWrite += audit.cacheWrite;
    role.reread += reread;
    role.rewrites += audit.rewrites;
    role.peaks.push(audit.peakContext);
    byRole.set(roleName, role);
    merge(bySource, audit.bySource, sourceTop, run);
    merge(byCommand, audit.byCommand, commandTop, run);
    view.calls += audit.calls;
    view.output += audit.output;
    view.cacheRead += audit.cacheRead;
    view.cacheWrite += audit.cacheWrite;
    view.reread += reread;
    view.rewrites += audit.rewrites;
    if (audit.readAfterReport !== null) {
      readAfter += audit.readAfterReport;
      readWithReport += audit.cacheRead;
    }
    return {
      runId: run.id,
      agentId: run.agentId,
      ticket: run.ticket,
      role: roleName,
      calls: audit.calls,
      peakContext: audit.peakContext,
      medianContext: audit.medianContext,
      output: audit.output,
      reread,
      rewrites: audit.rewrites,
      readAfterReportShare:
        audit.readAfterReport === null || audit.cacheRead === 0
          ? null
          : audit.readAfterReport / audit.cacheRead,
      costUsd: run.costUsd,
    };
  });
  const flight = flightSeat(config);
  const cost =
    flight === null
      ? null
      : flightWakeCost(
          store,
          now,
          flight.seat.id,
          new Set(configuredAgents(config).flatMap((a) => (a.kind === "crew" ? [a.id] : []))),
          days,
        );
  const start = cost?.byReason.find((r) => r.reason === "start");
  return {
    days,
    since,
    ...view,
    readAfterReportShare: readWithReport > 0 ? readAfter / readWithReport : null,
    byRole: [...byRole.values()]
      .map(({ peaks, ...r }) => ({ ...r, medianPeakContext: median(peaks) }))
      .sort((a, b) => b.reread - a.reread || a.role.localeCompare(b.role)),
    bySource: named(bySource, sourceTop),
    byCommand: named(byCommand, commandTop),
    topRuns: topRuns
      .sort((a, b) => b.reread - a.reread || a.runId.localeCompare(b.runId))
      .slice(0, TOKEN_AUDIT_TOP_RUNS),
    hubSections: (() => {
      const tops = new Map(store.promptSectionTopRuns(since).map((t) => [t.section, t]));
      return store
        .promptSectionTotals(since)
        .sort((a, b) => b.tokens - a.tokens)
        .map((h) => {
          const t = tops.get(h.section);
          return {
            ...h,
            topRun:
              t === undefined
                ? null
                : { runId: t.runId, agentId: t.agentId, ticket: t.ticket, value: t.tokens },
          };
        });
    })(),
    flightStart:
      cost === null
        ? null
        : {
            usd: start?.usd ?? 0,
            totalUsd: cost.totalUsd,
            share: cost.totalUsd > 0 ? (start?.usd ?? 0) / cost.totalUsd : 0,
          },
    controller:
      config.audit?.controllerSessions === true ? store.controllerUsageSince(since) : null,
    figures: figures(store, now, days, since, roles, rows, flight, cost),
  };
}

const fig = <T>(days: number, unit: string, value: T): TokenAuditFigure<T> => ({
  recorded: true,
  days,
  unit,
  value,
});

function figures(
  store: Store,
  now: number,
  days: number,
  since: number,
  roles: Map<string, string>,
  rows: { run: Run; audit: { peakContext: number } }[],
  flight: ReturnType<typeof flightSeat>,
  cost: ReturnType<typeof flightWakeCost> | null,
): TokenAuditFigures {
  const roleOf = (r: Run) => roles.get(r.agentId) ?? "unknown";
  const runById = new Map(rows.map(({ run }) => [run.id, run]));

  const perRole = new Map<string, number[]>();
  for (const c of store.runCallContexts(since)) {
    const run = runById.get(c.runId);
    if (run === undefined) continue;
    const list = perRole.get(roleOf(run)) ?? [];
    list.push(c.context);
    perRole.set(roleOf(run), list);
  }
  const contextByRole =
    perRole.size === 0
      ? missing("No model calls are stored for runs in this window.")
      : fig(
          days,
          "tokens per model call",
          [...perRole]
            .map(([role, xs]) => ({
              role,
              calls: xs.length,
              p90Context: p90(xs),
              budget: TOKEN_CONTEXT_BUDGET,
            }))
            .sort((a, b) => b.p90Context - a.p90Context || a.role.localeCompare(b.role)),
        );

  const over = rows
    .filter(({ audit }) => audit.peakContext > TOKEN_CONTEXT_BUDGET)
    .sort((a, b) => b.audit.peakContext - a.audit.peakContext || a.run.id.localeCompare(b.run.id));
  const overBudget = fig(days, "runs", {
    budget: TOKEN_CONTEXT_BUDGET,
    count: over.length,
    runs: over
      .slice(0, TOKEN_AUDIT_OVER_BUDGET_RUNS)
      .map(({ run, audit }) => ({ ...ref(run, audit.peakContext), role: roleOf(run) })),
  });

  const byTicket = new Map<string, { runs: number; latest: Run }>();
  for (const r of store.reviewRunsSince(since)) {
    const t = byTicket.get(r.ticket as string);
    byTicket.set(r.ticket as string, { runs: (t?.runs ?? 0) + 1, latest: r });
  }
  const reviewRunsPerTicket =
    byTicket.size === 0
      ? missing("No review run on a ticket started in this window.")
      : fig(
          days,
          "review runs",
          [...byTicket]
            .map(([ticket, t]) => ({ ticket, runs: t.runs, latestRunId: t.latest.id }))
            .sort((a, b) => b.runs - a.runs || a.ticket.localeCompare(b.ticket)),
        );

  let flightFigure: TokenAuditFigures["flight"] = missing(
    "There is no FLIGHT seat in this crew, so there are no wakes to count.",
  );
  if (flight !== null && cost !== null) {
    const wakes = store.flightWakes(since).filter((w) => w.at <= now);
    const decided = store.flightDecisions(since, 100_000).map((d) => d.at);
    const noDecision = wakes.filter(
      (w) => !decided.some((at) => at >= w.at && at - w.at <= FLIGHT_WAKE_IDLE_MS),
    ).length;
    const runs = store.runsOverlapping(since, now + 1).filter((r) => r.agentId === flight.seat.id);
    const digests = store.digests(runs.map((r) => r.id));
    const contexts: number[] = [];
    for (const w of wakes) {
      const before = (digests.get(w.runId)?.attemptUsage ?? [])
        .filter((u) => u.at !== null && u.at <= w.at && u.usage !== undefined)
        .sort((a, b) => (a.at as number) - (b.at as number))
        .at(-1)?.usage;
      if (before !== undefined) contexts.push(before.input + before.cacheRead + before.cacheCreate);
    }
    const sessions = runs.filter((r) => r.startedAt >= since).length;
    const start = cost.byReason.find((r) => r.reason === "start");
    flightFigure = fig(days, "wakes", {
      wakes: wakes.length,
      wakesWithNoDecision: noDecision,
      contextAtWake:
        contexts.length === 0
          ? missing("No FLIGHT message with recorded usage came before a wake in this window.")
          : fig(days, "tokens", {
              median: median(contexts),
              p90: p90(contexts),
              samples: contexts.length,
            }),
      sessions,
      sessionsPerDay: sessions / days,
      startCost: {
        usd: start?.usd ?? 0,
        totalUsd: cost.totalUsd,
        share: cost.totalUsd > 0 ? (start?.usd ?? 0) / cost.totalUsd : 0,
      },
    });
  }

  const { mergedPrs, runs: mergedRuns } = store.mergedTicketRuns(since, now);
  const roleCost = new Map<string, { usd: number; top: Run | null }>();
  for (const r of mergedRuns) {
    if (r.costUsd === null) continue;
    const c = roleCost.get(roleOf(r)) ?? { usd: 0, top: null };
    c.usd += r.costUsd;
    if (c.top === null || r.costUsd > (c.top.costUsd ?? 0)) c.top = r;
    roleCost.set(roleOf(r), c);
  }
  const costPerMergedPr =
    mergedPrs === 0 || roleCost.size === 0
      ? missing("No PR merged in this window has a run with a recorded cost.")
      : fig(days, "USD per merged PR", {
          mergedPrs,
          byRole: [...roleCost]
            .map(([role, c]) => ({
              role,
              usd: c.usd,
              perPr: c.usd / mergedPrs,
              topRun: c.top === null ? null : ref(c.top, c.top.costUsd ?? 0),
            }))
            .sort((a, b) => b.usd - a.usd || a.role.localeCompare(b.role)),
        });

  return {
    contextByRole,
    overBudget,
    longPassingCommands: missing(
      "The hub does not keep whether a command passed or how long its output was. It would need to store each Bash result's exit status and output length.",
    ),
    repeatedPrompt: missing(
      "The hub keeps each prompt section's size, not its text. It would need to store a hash of each section per wake to tell what was sent again.",
    ),
    rewriteWait: missing(
      "Stored model calls carry no time. The hub would need to store each call's timestamp to know the pause before a cache rewrite.",
    ),
    reviewRunsPerTicket,
    flight: flightFigure,
    costPerMergedPr,
  };
}
