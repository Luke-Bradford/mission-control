/**
 * `GET /api/telemetry?range=`: the Telemetry page's aggregates, computed from the store on each
 * request. Read-only; nothing here touches a loop or GitHub.
 */
import {
  type AgentSeries,
  cacheHitPct,
  FLOW_DAYS,
  percentile as interpolatedPercentile,
  LIVE_MINUTES,
  NO_SIZE,
  type ReviewRow,
  type Run,
  type RunDigest,
  stallStart,
  startOfLocalDay,
  TELEMETRY_POINTS,
  TELEMETRY_RANGES,
  type Telemetry,
  type TelemetryRange,
  type TestLockEntryView,
  type TestLockRun,
  type TestLockState,
  type TestLockView,
  TICKET_SIZES,
} from "@mc/core";
import { WINDOWS } from "./collectors/usage-common.ts";
import { agentIds, type CcConfig, configuredAgents, crewSeatDef } from "./config.ts";
import { crew } from "./hud.ts";
import { type PrCache, runPrs, runTicket } from "./runview.ts";
import { runSpend } from "./spend.ts";
import type { Store } from "./store.ts";
import { clippedMs, dayFormatter, endOf, lastDays, lockLabel } from "./views.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type Interval = [number, number];

/**
 * The share of a run's wall time inside [since, now): 0..1. A run with no wall time (an `unknown`
 * run with no end) counts whole when it started inside the window.
 */
function share(r: Run, since: number, now: number): number {
  const wall = endOf(r, now) - r.startedAt;
  if (wall <= 0) return r.startedAt >= since && r.startedAt < now ? 1 : 0;
  return clippedMs(r, since, now) / wall;
}

/** Total length of the union of intervals. */
function unionMs(intervals: Interval[]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: Interval | null = null;
  for (const [a, b] of sorted) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return cur ? total + cur[1] - cur[0] : total;
}

/** Nearest-rank percentile of an ascending list; null when it is empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Median length of each command's done holds, once it has three. */
export function usualLockMs(runs: TestLockRun[]): Record<string, number> {
  const lengths = new Map<string, number[]>();
  for (const r of runs) {
    if (r.outcome !== "done" || r.endedAt === null) continue;
    const list = lengths.get(r.command) ?? [];
    list.push(r.endedAt - r.startedAt);
    lengths.set(r.command, list);
  }
  return Object.fromEntries(
    [...lengths]
      .filter(([, list]) => list.length >= 3)
      .map(([command, list]) => [command, median(list) as number]),
  );
}

/** The test lock as `/api/test-lock` serves it: each holder and waiter labelled, the holder with its usual length. */
export function lockView(
  config: CcConfig,
  store: Store,
  state: TestLockState,
  now: number,
): TestLockView {
  const entry = (e: TestLockState["waiting"][number]): TestLockEntryView => ({
    ...e,
    label: lockLabel(config, e.seatId, e.command),
  });
  const usual = usualLockMs(store.lockRuns(now - TELEMETRY_RANGES["7d"] * MINUTE_MS));
  return {
    holder: state.holder
      ? { ...entry(state.holder), usualMs: usual[state.holder.command] ?? null }
      : null,
    waiting: state.waiting.map(entry),
  };
}

const addCost = (sum: number | null, c: number | null, f = 1): number | null =>
  c === null ? sum : (sum ?? 0) + c * f;

const ioTokens = (r: Run): number => (r.tokens ? r.tokens.input + r.tokens.output : 0);

/** Which loops the scoped parts count; null is no restriction. */
export interface TelemetryScope {
  agent: string | null;
  account: string | null;
  ticket?: string | null;
}

/**
 * `scope` intersects ticket, agent and account for today, ticket bars, tools and totals;
 * the flow of work, quota, machine and the per-agent series stay crew-wide. Unfiltered, the page
 * shows the registry's working, merged and cost (`METRICS` in @mc/core) instead of `today`'s.
 */
export function telemetry(
  config: CcConfig,
  store: Store,
  range: TelemetryRange,
  now: number,
  scope: TelemetryScope,
  commitLines: ReadonlyMap<
    string,
    { additions: number | null; deletions: number | null }
  > = new Map(),
): Telemetry {
  const tz = config.operator.timezone;
  const agents = configuredAgents(config);
  const ids = agentIds(config);
  const known = new Set(ids);
  const scoped = agents.filter(
    (a) =>
      (scope.agent === null || a.id === scope.agent) &&
      (scope.account === null || a.accountId === scope.account),
  );
  const scopedIds = new Set(scoped.map((l) => l.id));
  const dayStart = startOfLocalDay(now, tz);
  const rangeMs = TELEMETRY_RANGES[range] * MINUTE_MS;
  const since = now - rangeMs;
  const liveSince = Math.floor(now / MINUTE_MS) * MINUTE_MS - (LIVE_MINUTES - 1) * MINUTE_MS;

  // One read covers today, the range and the live hour.
  const earliest = Math.min(dayStart, since, liveSince);
  const runs = store.runsOverlapping(earliest, now + 1).filter((r) => known.has(r.agentId));
  const latestRuns = new Map<string, Run>();
  for (const id of ids) {
    const r = store.seatRun(id);
    if (r) latestRuns.set(id, r);
  }
  const digests: Map<string, RunDigest> = store.digests([
    ...new Set([...runs.map((r) => r.id), ...[...latestRuns.values()].map((r) => r.id)]),
  ]);
  const prsByRepo = config.repos.map((repo) => [repo.id, store.pullRequests(repo.id)] as const);
  const prs = prsByRepo.flatMap(([, p]) => p);
  // The same rows resolve a run's ticket through its PRs (tokensByTicket).
  const prCache: PrCache = new Map(
    prsByRepo.map(([id, p]) => [id, new Map(p.map((x) => [x.number, x]))]),
  );
  const matches = (r: Run): boolean =>
    scopedIds.has(r.agentId) &&
    (scope.ticket == null || runTicket(r, runPrs(config, store, r, prCache)) === scope.ticket);
  const inToday = runs.filter((r) => share(r, dayStart, now) > 0);
  const inRange = runs.filter((r) => share(r, since, now) > 0);

  // ── today ──
  let tokens = 0;
  let cacheRead = 0;
  let toolCalls = 0;
  let turns = 0;
  let costUsd: number | null = null;
  for (const r of inToday) {
    if (!matches(r)) continue;
    const f = share(r, dayStart, now);
    const d = digests.get(r.id);
    tokens += ioTokens(r) * f;
    cacheRead += (r.tokens?.cacheRead ?? 0) * f;
    toolCalls += (d?.toolCalls ?? 0) * f;
    turns += (d?.turns ?? 0) * f;
  }
  for (const r of runs) {
    if (!matches(r) || r.costUsd === null) continue;
    if (share(r, dayStart, now) <= 0 && !digests.get(r.id)?.attemptUsage?.length) continue;
    costUsd = (costUsd ?? 0) + (runSpend(r, digests.get(r.id), dayStart, now)[0] ?? 0);
  }
  const merged = prs.flatMap((p) => (p.mergedAt === null ? [] : [p.mergedAt]));
  const today: Telemetry["today"] = {
    commits: new Set(
      store
        .telemetryCommits(dayStart, now)
        .filter((c) => {
          const r = store.run(c.runId);
          return r !== null && matches(r);
        })
        .map((c) => `${c.repoId}#${c.sha}`),
    ).size,
    tokens: Math.round(tokens),
    cacheRead: Math.round(cacheRead),
    costUsd,
    toolCalls: Math.round(toolCalls),
    turns: Math.round(turns),
    working: crew(config, store, now).rows.filter(
      (r) =>
        r.hudState === "running" &&
        scopedIds.has(r.id) &&
        (scope.ticket == null ||
          inToday.some((run) => run.agentId === r.id && run.endedAt === null && matches(run))),
    ).length,
    agents: scoped.length,
  };

  // ── flow of work ──
  const dayOf = dayFormatter(tz);
  const days = lastDays(dayOf(now), FLOW_DAYS);
  const perDay = new Map(days.map((d) => [d, 0]));
  for (const m of merged) {
    const d = dayOf(m);
    const n = perDay.get(d);
    if (n !== undefined && m <= now) perDay.set(d, n + 1);
  }
  const throughput = days.map((day) => ({ day, merged: perDay.get(day) ?? 0 }));

  const flowSince = now - FLOW_DAYS * DAY_MS;
  const bySize = new Map<string, number[]>();
  let excluded = 0;
  for (const i of store.flowIssues(flowSince)) {
    if (i.doneAt === null) continue;
    if (i.startAt === null || i.startAt > i.doneAt) {
      excluded += 1;
      continue;
    }
    const size = i.size ?? NO_SIZE;
    const list = bySize.get(size) ?? [];
    list.push(i.doneAt - i.startAt);
    bySize.set(size, list);
  }
  const standard: readonly string[] = TICKET_SIZES;
  const others = [...bySize.keys()].filter((s) => !standard.includes(s) && s !== NO_SIZE).sort();
  const sizes = [...TICKET_SIZES, ...others, NO_SIZE];
  const cycleTime: Telemetry["cycleTime"] = {
    rows: sizes.map((size) => {
      const list = bySize.get(size) ?? [];
      return {
        size,
        p50Ms: interpolatedPercentile(list, 50),
        p85Ms: interpolatedPercentile(list, 85),
        tickets: list.length,
      };
    }),
    excluded,
  };

  // Ruling R14: a first push whose CI never finished (`pending`) counts as known but not green.
  const ciKnown = store.flowPrs(flowSince).filter((p) => p.firstPushCi !== null);
  const green = ciKnown.filter((p) => p.firstPushCi === "passing").length;
  // Review figures cover PRs merged in the window that have a reported review.
  const mergedKeys = new Set(
    prs
      .filter((p) => p.mergedAt !== null && p.mergedAt > flowSince && p.mergedAt <= now)
      .map((p) => `${p.repoId}#${p.number}`),
  );
  const reviewsByPr = new Map<string, ReviewRow[]>();
  for (const rv of store.reviewsIn(["reported"])) {
    const key = `${rv.repoId}#${rv.prNumber}`;
    if (!mergedKeys.has(key)) continue;
    reviewsByPr.set(key, [...(reviewsByPr.get(key) ?? []), rv]);
  }
  const reviewed = [...reviewsByPr.values()];
  const firstPass = reviewed.filter(
    (rvs) => rvs.filter((r) => r.round === 1).sort((a, b) => a.id - b.id)[0]?.blocking === 0,
  );
  const crewIds = new Set(agents.filter((a) => a.kind === "crew").map((a) => a.id));
  const commitRuns = store
    .runsOverlapping(flowSince, now + 1)
    .filter(
      (r) =>
        crewIds.has(r.agentId) &&
        r.startedAt >= flowSince &&
        r.endedAt !== null &&
        r.loop != null &&
        r.reviewId == null,
    );
  const quality: Telemetry["quality"] = {
    retroFindingsPerPr:
      reviewed.length === 0
        ? null
        : reviewed.reduce(
            (sum, rvs) => sum + rvs.reduce((n, r) => n + r.blocking + r.minor, 0),
            0,
          ) / reviewed.length,
    sentBackPrs: reviewed.filter((rvs) => rvs.some((r) => r.blocking > 0)).length,
    humanReviewWaitMs: median(store.noteWaits(["ready", "review"], flowSince)),
    ciGreenFirstPushPct: ciKnown.length === 0 ? null : (green / ciKnown.length) * 100,
    prs: ciKnown.length,
    reviewRoundsPerPr:
      reviewed.length === 0
        ? null
        : reviewed.reduce((sum, rvs) => sum + Math.max(...rvs.map((r) => r.round)), 0) /
          reviewed.length,
    firstPassReviewPct: reviewed.length === 0 ? null : (firstPass.length / reviewed.length) * 100,
    reviewedPrs: reviewed.length,
    commitsPerRun:
      commitRuns.length === 0
        ? null
        : commitRuns.reduce((sum, r) => sum + store.runCommits(r.id).length, 0) / commitRuns.length,
  };

  // ── agents ──
  const bucketMs = rangeMs / TELEMETRY_POINTS;
  const tokensPerMinute: AgentSeries[] = ids.map((agentId) => {
    const points = Array<number>(TELEMETRY_POINTS).fill(0);
    for (const r of inRange) {
      if (r.agentId !== agentId) continue;
      const total = ioTokens(r);
      if (total === 0) continue;
      const start = r.startedAt;
      const end = endOf(r, now);
      if (end <= start) {
        const i = Math.min(TELEMETRY_POINTS - 1, Math.floor((start - since) / bucketMs));
        if (i >= 0) points[i] = (points[i] ?? 0) + total;
        continue;
      }
      const rate = total / (end - start);
      for (let i = 0; i < TELEMETRY_POINTS; i++) {
        const a = since + i * bucketMs;
        const overlap = Math.min(end, a + bucketMs) - Math.max(start, a);
        if (overlap > 0) points[i] = (points[i] ?? 0) + rate * overlap;
      }
    }
    return { agentId, points: points.map((p) => p / (bucketMs / MINUTE_MS)) };
  });

  const liveMinutes: AgentSeries[] = ids.map((agentId) => {
    const points = Array<number>(LIVE_MINUTES).fill(0);
    for (const r of runs) {
      if (r.agentId !== agentId) continue;
      for (const [minute, n] of digests.get(r.id)?.minuteTokens ?? []) {
        const i = Math.round((minute - liveSince) / MINUTE_MS);
        if (i >= 0 && i < LIVE_MINUTES) points[i] = (points[i] ?? 0) + n;
      }
    }
    return { agentId, points };
  });

  const elapsed = now - dayStart;
  const stateEvents = store.agentEvents(0).filter((e) => e.at <= now);
  const lockRuns = store.lockRuns(0);
  let agentWaitMs = 0;
  const utilisation: Telemetry["utilisation"] = agents.map((agent) => {
    const questions =
      agent.kind === "crew"
        ? store
            .questionsOverlapping(agent.id, dayStart, now)
            .map((q): Interval => [Math.max(dayStart, q.at), Math.min(now, q.answeredAt ?? now)])
        : [];
    agentWaitMs += unionMs(questions);
    const events = stateEvents.filter((e) => e.agentId === agent.id);
    const lockWaits = lockRuns
      .filter((l) => l.seatId === agent.id)
      .map((l): Interval => [Math.max(dayStart, l.queuedAt), Math.min(now, l.startedAt)]);
    const waits = [
      ...lockWaits,
      ...store.telemetryNoteIntervals(agent.id, dayStart, now, ["ready", "review"]),
    ];
    const blocked = [
      ...questions,
      ...store.telemetryNoteIntervals(agent.id, dayStart, now, ["blocked"]),
    ];
    // Ordinary loop transitions are not recorded. Bound carried state by run activity,
    // using the same foreground/background silence threshold as the HUD.
    const active = runs
      .filter((r) => r.agentId === agent.id)
      .map((r): Interval => {
        const d = digests.get(r.id);
        const last = Math.max(r.startedAt, d?.lastEventAt ?? r.startedAt);
        return [
          r.startedAt,
          Math.min(
            r.endedAt ?? now,
            stallStart(last, agent.kind === "loop" && (d?.background.length ?? 0) > 0),
          ),
        ];
      });
    const boundaries = [
      ...new Set([
        dayStart,
        now,
        ...events.map((e) => e.at),
        ...[...waits, ...blocked, ...active].flat(),
      ]),
    ]
      .filter((at) => at >= dayStart && at <= now)
      .sort((a, b) => a - b);
    const ms = { working: 0, waiting: 0, blocked: 0, idle: 0, unknown: 0 };
    let eventIndex = 0;
    let state: (typeof events)[number]["to"] | null = null;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const a = boundaries[i] as number;
      const b = boundaries[i + 1] as number;
      while (events[eventIndex] && (events[eventIndex]?.at ?? Infinity) <= a) {
        state = events[eventIndex]?.to ?? null;
        eventIndex++;
      }
      const overlaps = (intervals: Interval[]) =>
        intervals.some(([start, end]) => start < b && end > a);
      const recordedAt = events[eventIndex - 1]?.at ?? -Infinity;
      const supported = active.some(([start, end]) => start <= recordedAt && start < b && end > a);
      const carried = state !== null && state !== "idle" && !supported ? "idle" : state;
      const category =
        overlaps(blocked) ||
        carried === "blocked" ||
        carried === "parked" ||
        carried === "stalled" ||
        carried === "error"
          ? "blocked"
          : overlaps(waits) || carried === "waiting"
            ? "waiting"
            : carried === "running"
              ? "working"
              : carried === null
                ? "unknown"
                : "idle";
      ms[category] += b - a;
    }
    const pct = (value: number) => (elapsed <= 0 ? 0 : (value / elapsed) * 100);
    return {
      agentId: agent.id,
      working: pct(ms.working),
      waiting: pct(ms.waiting),
      blocked: pct(ms.blocked),
      idle: pct(ms.idle),
      unknown: elapsed <= 0 ? 100 : pct(ms.unknown),
    };
  });

  const answers = store.operatorAnswers(dayStart);
  const responses = answers.map((a) => a.answeredAt - a.at).sort((a, b) => a - b);
  const longest = answers.reduce<{ agentId: string; ms: number } | null>((best, a) => {
    const ms = a.answeredAt - a.at;
    return best === null || ms > best.ms ? { agentId: a.agentId, ms } : best;
  }, null);
  const capcom: NonNullable<Telemetry["capcom"]> = {
    answered: answers.length,
    medianMs: median(responses),
    p90Ms: percentile(responses, 90),
    stopped: store.operatorStops(dayStart),
    longest,
    agentWaitMs,
  };

  const turnUsage: Telemetry["turnUsage"] = ids.map((agentId) => {
    const latest = latestRuns.get(agentId);
    return { agentId, turns: (latest && digests.get(latest.id)?.turnUsage) || [] };
  });

  const tools = new Map<
    string,
    {
      calls: number;
      failed: number;
      durations: number[];
      slowest: NonNullable<Telemetry["toolLatency"][number]["slowest"]> | null;
    }
  >();
  for (const r of runs) {
    if (!matches(r) || r.startedAt < since) continue;
    for (const [tool, t] of Object.entries(digests.get(r.id)?.tools ?? {})) {
      const acc = tools.get(tool) ?? { calls: 0, failed: 0, durations: [], slowest: null };
      if (t.slowest && (acc.slowest === null || t.slowest.durationMs > acc.slowest.durationMs)) {
        acc.slowest = { ...t.slowest, agentId: r.agentId };
      }
      acc.calls += t.calls;
      acc.failed += t.failed;
      acc.durations.push(...t.durationsMs);
      tools.set(tool, acc);
    }
  }
  const toolLatency: Telemetry["toolLatency"] = [...tools]
    .map(([tool, t]) => {
      const sorted = [...t.durations].sort((a, b) => a - b);
      return {
        tool,
        calls: t.calls,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        failed: t.failed,
        slowest: t.slowest,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  const subagents: Telemetry["subagents"] = inToday
    .filter(matches)
    .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
    .flatMap((r) =>
      (digests.get(r.id)?.subagents ?? []).map((s) => ({ ...s, agentId: r.agentId })),
    );

  // ── capacity ──
  const quota: Telemetry["quota"] = config.accounts.flatMap((a) =>
    WINDOWS.flatMap((window) => {
      const points = store.usage(a.id, window, since).map((s) => ({ at: s.at, pct: s.pct }));
      return points.length === 0 ? [] : [{ accountId: a.id, window, points }];
    }),
  );

  // Averaged per bucket in SQL: at most TELEMETRY_POINTS rows, however many samples the range holds.
  const machine: Telemetry["machine"] = store.machineBuckets(
    since,
    now,
    bucketMs,
    TELEMETRY_POINTS,
  );

  // ── cost: runs in range, pro rata to their wall time inside it ──
  const tokensByStep: NonNullable<Telemetry["tokensByStep"]> = (
    ["plan", "build", "review"] as const
  ).map((step) => ({ step, tokens: 0, costUsd: null, runs: 0 }));
  const byTicket = new Map<string, { tokens: number; costUsd: number | null }>();
  type TotalsAcc = Omit<Telemetry["totals"][number], "cacheHitPct"> & { cacheCreate: number };
  const totals = new Map<string, TotalsAcc>();
  for (const r of inRange) {
    const f = share(r, since, now);
    const d = digests.get(r.id);
    const step = r.reviewId != null ? "review" : crewSeatDef(config, r.agentId).loop;
    const stepRow = tokensByStep.find((row) => row.step === step);
    if (crewIds.has(r.agentId) && stepRow) {
      stepRow.tokens += ioTokens(r) * f;
      stepRow.costUsd = addCost(stepRow.costUsd, r.costUsd, f);
      stepRow.runs += 1;
    }
    if (!matches(r)) continue;
    const ticket = runTicket(r, runPrs(config, store, r, prCache));
    if (ticket !== null) {
      const t = byTicket.get(ticket) ?? { tokens: 0, costUsd: null };
      t.tokens += ioTokens(r) * f;
      t.costUsd = addCost(t.costUsd, r.costUsd, f);
      byTicket.set(ticket, t);
    }
    // An empty model name is no model: "" and null are one row, shown as null.
    const model = r.model || d?.model || null;
    const key = `${r.agentId}\n${model ?? ""}`;
    const row = totals.get(key) ?? {
      agentId: r.agentId,
      accountId: agents.find((a) => a.id === r.agentId)?.accountId ?? "",
      model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      turns: 0,
      toolCalls: 0,
      costUsd: null,
      additions: null,
      deletions: null,
    };
    row.input += (r.tokens?.input ?? 0) * f;
    row.output += (r.tokens?.output ?? 0) * f;
    row.cacheRead += (r.tokens?.cacheRead ?? 0) * f;
    row.cacheCreate += (r.tokens?.cacheCreate ?? 0) * f;
    row.turns += (d?.turns ?? 0) * f;
    row.toolCalls += (d?.toolCalls ?? 0) * f;
    row.costUsd = addCost(row.costUsd, r.costUsd, f);
    totals.set(key, row);
  }
  const seenCommits = new Set<string>();
  const measuredRows = new Set<string>();
  for (const c of store.telemetryCommits(since, now)) {
    const r = store.run(c.runId);
    if (r === null || !matches(r)) continue;
    const commitKey = `${c.repoId}#${c.sha}`;
    if (seenCommits.has(commitKey)) continue;
    const model = r.model || digests.get(r.id)?.model || null;
    const key = `${r.agentId}\n${model ?? ""}`;
    const row = totals.get(key);
    if (!row) continue;
    seenCommits.add(commitKey);
    const counts = commitLines.get(commitKey);
    if (!measuredRows.has(key)) {
      row.additions = 0;
      row.deletions = 0;
      measuredRows.add(key);
    }
    row.additions =
      row.additions == null || counts?.additions == null ? null : row.additions + counts.additions;
    row.deletions =
      row.deletions == null || counts?.deletions == null ? null : row.deletions + counts.deletions;
  }
  const tokensByTicket: Telemetry["tokensByTicket"] = [...byTicket]
    .map(([ticket, t]) => ({ ticket, tokens: Math.round(t.tokens), costUsd: t.costUsd }))
    .sort((a, b) => b.tokens - a.tokens || a.ticket.localeCompare(b.ticket));
  const totalRows: Telemetry["totals"] = [...totals.values()]
    .map(({ cacheCreate, ...row }) => {
      const input = Math.round(row.input);
      const cacheRead = Math.round(row.cacheRead);
      return {
        ...row,
        input,
        output: Math.round(row.output),
        cacheRead,
        cacheHitPct: cacheHitPct({ input, cacheRead, cacheCreate: Math.round(cacheCreate) }),
        turns: Math.round(row.turns),
        toolCalls: Math.round(row.toolCalls),
      };
    })
    // A row that rounds to nothing everywhere is a run with no usage, not a figure.
    .filter(
      (r) =>
        r.input +
          r.output +
          r.cacheRead +
          r.turns +
          r.toolCalls +
          (r.additions ?? 0) +
          (r.deletions ?? 0) >
        0,
    )
    .sort(
      (a, b) =>
        ids.indexOf(a.agentId) - ids.indexOf(b.agentId) ||
        (a.model ?? "").localeCompare(b.model ?? ""),
    );

  return {
    today,
    throughput,
    cycleTime,
    quality,
    tokensPerMinute,
    liveMinutes,
    utilisation,
    turnUsage,
    toolLatency,
    subagents,
    quota,
    machine,
    tokensByTicket,
    tokensByStep: tokensByStep.map((row) => ({ ...row, tokens: Math.round(row.tokens) })),
    capcom,
    totals: totalRows,
  };
}
