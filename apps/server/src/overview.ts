import {
  type AttentionItem,
  CI_PASSED_EVENT_PREFIX,
  hudColumnOf,
  isCiFailureEvent,
  type OverviewSummary,
  OWNER_OPERATOR,
  type PipelineCard,
  type PipelineStage,
  type PullRequestView,
  type Run,
  startOfLocalDay,
} from "@mc/core";
import { parseTicket } from "./runview.ts";
import { runSpend } from "./spend.ts";
import type { Store } from "./store.ts";
import { endOf } from "./views.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MINUTES = 30;
const CARD_LIMIT = 8;
const STAGES: PipelineStage["stage"][] = [
  "ready",
  "building",
  "checks",
  "review",
  "merging",
  "merged",
];
const CI: Record<NonNullable<PullRequestView["ci"]>, PipelineCard["ci"][number]> = {
  passing: "pass",
  failing: "fail",
  pending: "pending",
};

export interface OverviewScope {
  repoIds: readonly string[];
  pipelineRepoIds?: readonly string[];
  timezone: string;
  /** The same derived open items served by /attention, including acknowledged items. */
  attention: readonly AttentionItem[];
}

/** Aggregates store data and retains derived attention episodes for minute history. */
export function overviewSummary(store: Store, now: number, scope: OverviewScope): OverviewSummary {
  const repos = new Set(scope.repoIds);
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const since = end - MINUTES * MINUTE_MS;
  const midnight = startOfLocalDay(now, scope.timezone);
  const zeros = () => Array<number>(MINUTES).fill(0);
  const hourly = () => Array<number>(Math.floor((now - midnight) / HOUR_MS) + 1).fill(0);
  const runs = store
    .runsOverlapping(Math.min(midnight, since), now + 1)
    .filter((r) => repos.has(r.repoId));
  const digests = store.digests(runs.map((r) => r.id));
  const tokens = zeros();
  const spend = hourly();
  const minuteSpend = zeros();
  for (const run of runs) {
    for (const [at, n] of digests.get(run.id)?.minuteTokens ?? []) {
      const i = Math.floor((at - since) / MINUTE_MS);
      if (i >= 0 && i < MINUTES) tokens[i] = (tokens[i] ?? 0) + n;
    }
    const minutes = runSpend(run, digests.get(run.id), since, now, MINUTE_MS);
    for (let i = 0; i < MINUTES; i++) minuteSpend[i] = (minuteSpend[i] ?? 0) + (minutes[i] ?? 0);
    const costs = runSpend(run, digests.get(run.id), midnight, now, HOUR_MS);
    for (let i = 0; i < spend.length; i++) spend[i] = (spend[i] ?? 0) + (costs[i] ?? 0);
  }

  const prs = scope.repoIds.flatMap((id) =>
    store.overviewPullRequests(id, Math.min(midnight, since)),
  );
  const linked = prs.filter(isLinked);
  const pipelineRepos = new Set(scope.pipelineRepoIds ?? scope.repoIds);
  const pipeline = pipelineStages(store, now, { runs, prs, pipelineRepos, midnight });
  const inFlight = inProgressOf(pipeline);
  const ci = scope.repoIds
    .flatMap((id) => store.loopEvents(since - DAY_MS, id))
    .filter((e) => e.at <= now);
  const passed = ci.filter(
    (e) => e.at >= now - DAY_MS && e.text.startsWith(CI_PASSED_EVENT_PREFIX),
  ).length;
  const failed = ci.filter((e) => e.at >= now - DAY_MS && isCiFailureEvent(e.text)).length;
  // The registry's Needs you is the operator's whole inbox (web `needsYouItems`): one per key, and
  // no session filter narrows it, so its history is one series whatever the scope.
  const seen = new Set<string>();
  const needs = scope.attention.filter((i) => {
    if ((i.owner ?? OWNER_OPERATOR) !== OWNER_OPERATOR || i.at > now || seen.has(i.key))
      return false;
    seen.add(i.key);
    return true;
  });
  const minuteEnds = Array.from({ length: MINUTES }, (_, i) => since + (i + 1) * MINUTE_MS);
  const moves = store.boardMoves(0).filter((m) => m.state === "done");
  const boards = [...pipelineRepos].flatMap((repoId) => store.board(repoId));
  const flightSeries = minuteEnds.map((end) => {
    const at = end - 1;
    const tickets = new Set<string>();
    for (const run of runs) {
      if (!pipelineRepos.has(run.repoId) || run.ticket === null || run.reviewId != null) continue;
      const item = boards.find((b) => `${b.repoId}#${b.issueNumber}` === run.ticket);
      if (item?.closed && item.updatedAt <= at) continue;
      if (
        run.startedAt <= at &&
        endOf(run, now) > at &&
        ((run.loop?.merging && run.loop.phase !== "done") ||
          ["working", "parked", "ci", "review"].includes(run.loop?.phase ?? ""))
      )
        tickets.add(run.ticket);
    }
    for (const item of boards) {
      if (item.createdAt > at || (item.closed && item.updatedAt <= at)) continue;
      const move = moves.findLast(
        (m) => m.repoId === item.repoId && m.issue === item.issueNumber && m.at <= at,
      );
      const column = move?.column ?? (item.updatedAt <= at ? hudColumnOf(item) : null);
      if (column === "In review") tickets.add(`${item.repoId}#${item.issueNumber}`);
    }
    return tickets.size;
  });
  const ciSeries = minuteEnds.map((at) => {
    const outcomes = ci.filter((e) => e.at >= at - DAY_MS && e.at < at);
    const pass = outcomes.filter((e) => e.text.startsWith(CI_PASSED_EVENT_PREFIX)).length;
    const fail = outcomes.filter((e) => isCiFailureEvent(e.text)).length;
    return pass + fail ? (100 * pass) / (pass + fail) : null;
  });
  // Keep episodes after disappearance so resolving a need cannot rewrite prior minutes.
  // Derived items have no common resolution event; absence is observed at this request time.
  type NeedEpisode = { key: string; openedAt: number; resolvedAt: number | null };
  const historyKey = "overview:needs";
  const episodes: NeedEpisode[] = JSON.parse(store.getSetting(historyKey) ?? "[]");
  const open = new Map(episodes.filter((e) => e.resolvedAt === null).map((e) => [e.key, e]));
  const present = new Set(needs.map((i) => i.key));
  for (const episode of open.values()) {
    if (!present.has(episode.key)) {
      const question = /^ask:(\d+)$/.exec(episode.key);
      episode.resolvedAt = question
        ? (store.question(Number(question[1]))?.answeredAt ?? now)
        : now;
    }
  }
  for (const item of needs) {
    if (!open.has(item.key)) episodes.push({ key: item.key, openedAt: item.at, resolvedAt: null });
  }
  const retained = episodes.filter((e) => e.resolvedAt === null || e.resolvedAt > since);
  store.setSetting(historyKey, JSON.stringify(retained));
  const needSeries = minuteEnds.map(
    (at) =>
      retained.filter((e) => e.openedAt < at && (e.resolvedAt === null || e.resolvedAt > at))
        .length,
  );
  const diskSeries = Array<number | null>(MINUTES).fill(null);
  const diskCounts = zeros();
  for (const sample of store.machineSamples(since)) {
    if (sample.at >= end || sample.diskFreeBytes === null) continue;
    const i = Math.floor((sample.at - since) / MINUTE_MS);
    diskSeries[i] = (diskSeries[i] ?? 0) + sample.diskFreeBytes / 1024 ** 3;
    diskCounts[i] = (diskCounts[i] ?? 0) + 1;
  }
  for (let i = 0; i < MINUTES; i++) {
    if (diskCounts[i]) diskSeries[i] = (diskSeries[i] as number) / (diskCounts[i] as number);
  }
  const cpu = Array<number | null>(MINUTES).fill(null);
  const mem = Array<number | null>(MINUTES).fill(null);
  for (const sample of store.machineBuckets(since, end - 1, MINUTE_MS, MINUTES)) {
    const i = Math.floor((sample.at - since) / MINUTE_MS);
    cpu[i] = sample.cpuPct;
    mem[i] = sample.memPct;
  }
  const disk = store.latestMachineSample(now)?.diskFreeBytes ?? null;
  return {
    at: now,
    kpis: {
      tokensPerMin: { now: tokens.at(-1) ?? 0, series: tokens },
      spendToday: {
        usd: spend.reduce((sum, n) => sum + n, 0),
        perHour: spend,
        series: minuteSpend,
      },
      inFlight: {
        series: flightSeries,
        count: inFlight.count,
        oldestAt: inFlight.oldestAt,
      },
      ciPassRate24h: {
        series: ciSeries,
        pct: passed + failed === 0 ? null : (100 * passed) / (passed + failed),
        runs: passed + failed,
        redNow: linked.filter((p) => p.state === "open" && p.ci === "failing").length,
      },
      needsYou: {
        series: needSeries,
        count: needs.length,
        overHour: needs.filter((i) => now - i.at > HOUR_MS).length,
      },
    },
    pipeline,
    machine: { cpu, mem, disk: diskSeries, diskFreeGb: disk === null ? null : disk / 1024 ** 3 },
  };
}

const isLinked = (p: PullRequestView): boolean =>
  p.ticket !== null || (p.closingIssues?.length ?? 0) > 0;

/**
 * The delivery pipeline: each open ticket's stage from its live run, PR and board column, plus
 * tickets merged since `midnight`. `runs` must include every open run; `prs` every open PR and
 * those merged since `midnight`.
 */
export function pipelineStages(
  store: Store,
  now: number,
  {
    runs,
    prs,
    pipelineRepos,
    midnight,
  }: {
    runs: readonly Run[];
    prs: readonly PullRequestView[];
    pipelineRepos: ReadonlySet<string>;
    midnight: number;
  },
): PipelineStage[] {
  const linked = prs.filter(isLinked);
  const byTicket = new Map<string, PullRequestView>();
  const byNumber = new Map<string, PullRequestView>();
  const order = new Map(linked.map((p, i) => [p, i]));
  for (const pr of linked) {
    if (pr.state !== "open") continue;
    byNumber.set(`${pr.repoId}#${pr.number}`, pr);
    const refs = [
      ...(pr.ticket ? [pr.ticket] : []),
      ...(pr.closingIssues ?? []).map((n) => `${pr.repoId}#${n}`),
    ];
    for (const ref of refs) if (!byTicket.has(ref)) byTicket.set(ref, pr);
  }
  const cards = new Map(STAGES.map((stage) => [stage, [] as PipelineCard[]]));
  const live = new Map<string, Run>();
  for (const run of runs) {
    if (
      run.ticket !== null &&
      run.endedAt === null &&
      run.status === "running" &&
      run.reviewId == null &&
      !live.has(run.ticket)
    )
      live.set(run.ticket, run);
  }
  const checks = (pr: PullRequestView | undefined): PipelineCard["ci"] =>
    pr?.checks?.length ? pr.checks.map((c) => CI[c.state]) : pr?.ci ? [CI[pr.ci]] : [];
  for (const repoId of pipelineRepos) {
    const readyMoves = store.overviewReadyMoves(repoId);
    const board = store.board(repoId);
    const items = board.map((item) => ({ ...item, column: hudColumnOf(item) }));
    const missing = [...live.values()].flatMap((run) => {
      const ticket = run.ticket === null ? null : parseTicket(run.ticket);
      if (
        run.repoId !== repoId ||
        !ticket ||
        board.some((item) => item.issueNumber === ticket.number)
      )
        return [];
      return [
        {
          issueNumber: ticket.number,
          title: run.ticketTitle ?? run.ticket ?? "",
          closed: false,
          updatedAt: run.startedAt,
          column: null,
        },
      ];
    });
    for (const item of [...items, ...missing]) {
      if (item.closed) continue;
      const ref = `${repoId}#${item.issueNumber}`;
      const run = live.get(ref);
      const candidates = [
        byTicket.get(ref),
        byNumber.get(`${repoId}#${run?.loop?.prNumber}`),
      ].filter((p): p is PullRequestView => p !== undefined);
      const pr = candidates.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
      const phase = run?.loop?.phase;
      const column = item.column;
      const stage =
        run?.loop?.merging && phase !== "done"
          ? "merging"
          : phase === "working" || (phase === "parked" && column !== "In review")
            ? "building"
            : phase === "ci"
              ? "checks"
              : phase === "review" || column === "In review"
                ? "review"
                : column === "Ready" && !run
                  ? "ready"
                  : null;
      if (!stage) continue;
      cards.get(stage)?.push({
        repoId,
        ticket: item.issueNumber,
        title: item.title,
        pr: pr?.number ?? run?.loop?.prNumber ?? null,
        ci: checks(pr),
        since:
          stage === "ready"
            ? (readyMoves.get(item.issueNumber) ?? item.updatedAt)
            : (run?.loop?.pushStartedAt ?? run?.startedAt ?? item.updatedAt),
        who: run?.agentId ?? null,
      });
    }
  }
  for (const pr of linked) {
    if (!pipelineRepos.has(pr.repoId)) continue;
    if (pr.mergedAt === null || pr.mergedAt < midnight || pr.mergedAt > now) continue;
    const ticket = pr.ticket === null ? pr.closingIssues?.[0] : parseTicket(pr.ticket)?.number;
    if (ticket === undefined) continue;
    cards.get("merged")?.push({
      repoId: pr.repoId,
      ticket,
      title: pr.title,
      pr: pr.number,
      ci: checks(pr),
      since: pr.mergedAt,
      who: null,
    });
  }
  const pipeline = STAGES.map((stage): PipelineStage => {
    const all = cards.get(stage) ?? [];
    all.sort(
      (a, b) => a.since - b.since || a.repoId.localeCompare(b.repoId) || a.ticket - b.ticket,
    );
    const oldestAt = all[0]?.since ?? null;
    if (stage === "merged") all.reverse();
    return { stage, count: all.length, oldestAt, cards: all.slice(0, CARD_LIMIT) };
  });
  return pipeline;
}

/**
 * The registry's In progress (`METRICS.inProgress`): tickets building, in checks, in review or
 * merging, and when the oldest of them entered its stage.
 */
export function inProgressOf(pipeline: readonly PipelineStage[]): {
  count: number;
  oldestAt: number | null;
} {
  const stages = pipeline.filter((p) => p.stage !== "merged" && p.stage !== "ready");
  const oldest = stages.flatMap((p) => (p.oldestAt === null ? [] : [p.oldestAt]));
  return {
    count: stages.reduce((n, p) => n + p.count, 0),
    oldestAt: oldest.length ? Math.min(...oldest) : null,
  };
}
