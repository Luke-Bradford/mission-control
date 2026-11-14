import {
  FLIGHT_WAKE_IDLE_MS,
  type Run,
  type RunTokenAudit,
  TOKEN_AUDIT_OTHER,
  TOKEN_AUDIT_OVER_BUDGET_RUNS,
  TOKEN_AUDIT_SUMMARY_ROWS,
  TOKEN_AUDIT_SUMMARY_RUNS,
  TOKEN_AUDIT_TOP_RUNS,
  TOKEN_CONTEXT_BUDGET,
  TOKEN_REWRITE_MIN_WRITE,
  TOKEN_REWRITE_READ_RATIO,
  type TokenAuditCoverage,
  type TokenAuditFigure,
  type TokenAuditFigures,
  type TokenAuditNamed,
  type TokenAuditRole,
  type TokenAuditRunRef,
  type TokenAuditSummary,
  type TokenAuditSummaryRow,
  type TokenAuditView,
  type TokenCall,
  type TokenCounts,
} from "@mc/core";
import { type CcConfig, configuredAgents } from "../config.ts";
import { flightWakeCost } from "../flight/cost.ts";
import { flightSeat } from "../flight/seat.ts";
import type { Store } from "../store.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
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

/** One view's inputs: the per-run audits it sums, and what says how they were chosen. */
interface Basis {
  days: number;
  hours: number | null;
  since: number;
  kind: "runs" | "events";
  rows: { run: Run; audit: RunTokenAudit }[];
  coverage: TokenAuditCoverage | null;
  /** Context size of each model call in the window, by run. */
  contexts: { runId: string; context: number }[];
}

/** The stored token audits of runs started in the last `days` days, summed for `GET /api/audit/tokens`. */
export function tokenAuditView(
  store: Store,
  config: CcConfig,
  now: number,
  days: number,
): TokenAuditView {
  const since = now - days * DAY_MS;
  return aggregate(store, config, now, {
    days,
    hours: null,
    since,
    kind: "runs",
    rows: store.runTokenAudits(since),
    coverage: null,
    contexts: store.runCallContexts(since),
  });
}

/**
 * What one run's calls in `(from, to]` did. Each call counts where it was made, not where its run
 * started. An addition is re-read by the run's later calls that are also in the window, so a
 * run's whole-run total is never spread over time. A call with no time is left out (the coverage
 * says so).
 */
function windowAudit(calls: readonly TokenCall[], from: number, to: number): RunTokenAudit | null {
  const inWin = calls.map((c) => c.at != null && c.at > from && c.at <= to);
  const total = inWin.filter(Boolean).length;
  if (total === 0) return null;
  const bySource: Record<string, TokenCounts> = {};
  const byCommand: Record<string, TokenCounts> = {};
  const contexts: number[] = [];
  let seen = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let rewrites = 0;
  let rewriteTokens = 0;
  calls.forEach((c, i) => {
    if (!inWin[i]) return;
    seen += 1;
    const left = total - seen + 1;
    contexts.push(c.context);
    cacheRead += c.cacheRead;
    cacheWrite += c.cacheWrite;
    output += c.output;
    const prev = calls[i - 1];
    if (
      prev !== undefined &&
      c.cacheWrite > TOKEN_REWRITE_MIN_WRITE &&
      c.cacheRead < TOKEN_REWRITE_READ_RATIO * prev.context
    ) {
      rewrites += 1;
      rewriteTokens += c.cacheWrite;
    }
    for (const a of c.added) {
      const into = (m: Record<string, TokenCounts>, name: string) => {
        const t = m[name] ?? { added: 0, reread: 0, events: 0 };
        m[name] = t;
        t.added += a.tokens;
        t.reread += a.tokens * left;
        t.events += 1;
      };
      into(bySource, a.source);
      if (a.command !== null) into(byCommand, a.command);
    }
  });
  const sorted = [...contexts].sort((x, y) => x - y);
  return {
    calls: total,
    peakContext: sorted.at(-1) ?? 0,
    medianContext: sorted[total >> 1] ?? 0,
    cacheRead,
    cacheWrite,
    output,
    rewrites,
    rewriteTokens,
    readAfterReport: null,
    bySource,
    byCommand,
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The model calls made in the last `hours` hours, by role and source, for `?hours=N`. Calls are
 * placed by the time their first frame was written, so a run that began days ago still counts for
 * what it did in the window. `coverage` says what the stored times cannot cover.
 */
export function tokenAuditWindowView(
  store: Store,
  config: CcConfig,
  now: number,
  hours: number,
): TokenAuditView {
  const from = now - hours * HOUR_MS;
  const rows: { run: Run; audit: RunTokenAudit }[] = [];
  const contexts: { runId: string; context: number }[] = [];
  for (const { run, calls } of store.tokenCallsOfRunsActiveIn(from, now)) {
    const audit = windowAudit(calls, from, now);
    if (audit === null) continue;
    rows.push({ run, audit });
    for (const c of calls) {
      if (c.at != null && c.at > from && c.at <= now)
        contexts.push({ runId: run.id, context: c.context });
    }
  }
  const states = store.tokenAuditStates(from, now);
  const pendingRuns = states.filter((s) => !s.stored).length;
  const untimedRuns = states.filter((s) => s.stored && s.calls > 0 && s.untimed).length;
  const unreadRuns = states.filter((s) => s.stored && s.calls === 0).length;
  const gaps: string[] = [];
  if (pendingRuns > 0)
    gaps.push(
      `${plural(pendingRuns, "run", "runs")} in the window ${pendingRuns === 1 ? "has" : "have"} no token audit stored yet (still running, or not read yet)`,
    );
  if (untimedRuns > 0)
    gaps.push(
      `${plural(untimedRuns, "run", "runs")} in the window ${untimedRuns === 1 ? "has" : "have"} calls stored without a time (made before call times were kept, and the transcript could not give them)`,
    );
  if (unreadRuns > 0)
    gaps.push(
      `${plural(unreadRuns, "run", "runs")} in the window ${unreadRuns === 1 ? "has" : "have"} no readable transcript (Codex, observed loop or missing file)`,
    );
  const gapped = pendingRuns + untimedRuns + unreadRuns > 0;
  const coverage: TokenAuditCoverage = {
    status: !gapped ? "complete" : rows.length > 0 ? "partial" : "unavailable",
    pendingRuns,
    untimedRuns,
    unreadRuns,
    reason: gapped
      ? `${gaps.join("; ")}. Their calls are not in these totals, so a zero here is not proof of none.`
      : null,
  };
  return aggregate(store, config, now, {
    days: hours / 24,
    hours,
    since: from,
    kind: "events",
    rows,
    coverage,
    contexts,
  });
}

/** The two lists and totals the summary read shares with the full one; rows past the top fold into `other`. */
function summaryRows(all: TokenAuditNamed[]): { rows: TokenAuditSummaryRow[]; other: number } {
  const top = all.slice(0, TOKEN_AUDIT_SUMMARY_ROWS);
  const rest = all.slice(TOKEN_AUDIT_SUMMARY_ROWS);
  const rows: TokenAuditSummaryRow[] = top.map((r) => ({
    name: r.name,
    added: r.added,
    reread: r.reread,
    events: r.events,
    share: r.share,
  }));
  if (rest.length > 0) {
    const sum = rest.reduce(
      (t, r) => ({
        added: t.added + r.added,
        reread: t.reread + r.reread,
        events: t.events + r.events,
        share: t.share + r.share,
      }),
      { added: 0, reread: 0, events: 0, share: 0 },
    );
    rows.push({ name: TOKEN_AUDIT_OTHER, ...sum });
  }
  return { rows, other: rest.length };
}

/**
 * The bounded read for an agent: totals, every role, the top sources and commands with one
 * `other` row each, and a few runs. Each list plus its `other` row adds up to the full read.
 */
export function tokenAuditSummary(view: TokenAuditView): TokenAuditSummary {
  const q = view.hours != null ? `hours=${view.hours}` : `days=${view.days}`;
  const sources = summaryRows(view.bySource);
  const commands = summaryRows(view.byCommand);
  const runs = view.topRuns.slice(0, TOKEN_AUDIT_SUMMARY_RUNS);
  return {
    days: view.days,
    hours: view.hours ?? null,
    since: view.since,
    basis: view.basis ?? "runs",
    coverage: view.coverage ?? null,
    runs: view.runs,
    calls: view.calls,
    output: view.output,
    cacheRead: view.cacheRead,
    cacheWrite: view.cacheWrite,
    reread: view.reread,
    rewrites: view.rewrites,
    byRole: view.byRole,
    bySource: sources.rows,
    byCommand: commands.rows,
    otherSources: sources.other,
    otherCommands: commands.other,
    topRuns: runs,
    links: {
      full: `/api/audit/tokens?${q}`,
      runs: [...new Set(runs.map((r) => `/api/agents/${r.agentId}/runs`))],
    },
  };
}

function aggregate(store: Store, config: CcConfig, now: number, basis: Basis): TokenAuditView {
  const { days, since, rows } = basis;
  const roles = new Map<string, string>(
    configuredAgents(config).map((a) => [a.id, a.kind === "loop" ? LOOP_ROLE : a.seat.role]),
  );
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
    hours: basis.hours,
    basis: basis.kind,
    coverage: basis.coverage,
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
    figures: figures(store, now, days, since, roles, rows, basis.contexts, flight, cost),
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
  contexts: { runId: string; context: number }[],
  flight: ReturnType<typeof flightSeat>,
  cost: ReturnType<typeof flightWakeCost> | null,
): TokenAuditFigures {
  const roleOf = (r: Run) => roles.get(r.agentId) ?? "unknown";
  const runById = new Map(rows.map(({ run }) => [run.id, run]));

  const perRole = new Map<string, number[]>();
  for (const c of contexts) {
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
      "Call times are stored from this release on, but the pause before a cache rewrite is not worked out from them yet.",
    ),
    reviewRunsPerTicket,
    flight: flightFigure,
    costPerMergedPr,
  };
}
