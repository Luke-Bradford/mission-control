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
import { median } from "./telemetry.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MINUTES = 30;
const CARD_LIMIT = 6;
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
  seatIds: readonly string[];
  pipelineRepoIds?: readonly string[];
  timezone: string;
  /** The same derived open items served by /attention, including acknowledged items. */
  attention: readonly AttentionItem[];
}

/** Store-only aggregation; the caller supplies configuration and the derived attention view. */
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
  for (const run of runs) {
    for (const [at, n] of digests.get(run.id)?.minuteTokens ?? []) {
      const i = Math.floor((at - since) / MINUTE_MS);
      if (i >= 0 && i < MINUTES) tokens[i] = (tokens[i] ?? 0) + n;
    }
    const costs = runSpend(run, digests.get(run.id), midnight, now, HOUR_MS);
    for (let i = 0; i < spend.length; i++) spend[i] = (spend[i] ?? 0) + (costs[i] ?? 0);
  }

  const working = zeros();
  let workingNow = 0;
  const events = store.overviewAgentEvents(scope.seatIds, since, now);
  for (const id of scope.seatIds) {
    const changes = events.filter((e) => e.agentId === id);
    const minutes = new Set<number>();
    for (let j = 0; j < changes.length; j++) {
      const event = changes[j];
      if (event?.to !== "running") continue;
      const until = changes[j + 1]?.at ?? now;
      for (let i = 0; i < MINUTES; i++) {
        const at = since + i * MINUTE_MS;
        if (event.at < at + MINUTE_MS && until > at) minutes.add(i);
      }
    }
    for (const i of minutes) working[i] = (working[i] ?? 0) + 1;
    if (changes.at(-1)?.to === "running") workingNow++;
  }

  const prs = scope.repoIds.flatMap((id) => store.overviewPullRequests(id, midnight));
  const linked = prs.filter((p) => p.ticket !== null || (p.closingIssues?.length ?? 0) > 0);
  const pipelineRepos = new Set(scope.pipelineRepoIds ?? scope.repoIds);
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
  const merged = prs.filter(
    (p) => p.mergedAt !== null && p.mergedAt >= midnight && p.mergedAt <= now,
  );
  const perHour = hourly();
  for (const pr of merged) {
    const i = Math.floor(((pr.mergedAt as number) - midnight) / HOUR_MS);
    if (i < perHour.length) perHour[i] = (perHour[i] ?? 0) + 1;
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
  const inFlight = pipeline.filter((p) => p.stage !== "merged" && p.stage !== "ready");
  const oldest = inFlight.flatMap((p) => (p.oldestAt === null ? [] : [p.oldestAt]));
  const ci = scope.repoIds
    .flatMap((id) => store.loopEvents(now - DAY_MS, id))
    .filter((e) => e.at <= now);
  const passed = ci.filter((e) => e.text.startsWith(CI_PASSED_EVENT_PREFIX)).length;
  const failed = ci.filter((e) => isCiFailureEvent(e.text)).length;
  const flow = store
    .flowIssues(now - 14 * DAY_MS)
    .filter(
      (i) =>
        repos.has(i.repoId) &&
        i.doneAt !== null &&
        i.doneAt <= now &&
        i.startAt !== null &&
        i.startAt <= i.doneAt,
    );
  const cycles = flow.map((i) => (i.doneAt as number) - (i.startAt as number));
  const today = flow
    .filter((i) => (i.doneAt as number) >= midnight)
    .map((i) => (i.doneAt as number) - (i.startAt as number));
  const needs = scope.attention.filter(
    (i) =>
      (i.owner ?? OWNER_OPERATOR) === OWNER_OPERATOR &&
      (i.repoId === null || repos.has(i.repoId)) &&
      i.at <= now,
  );
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
      working: { now: workingNow, of: scope.seatIds.length, series: working },
      tokensPerMin: { now: tokens.at(-1) ?? 0, series: tokens },
      spendToday: { usd: spend.reduce((sum, n) => sum + n, 0), perHour: spend },
      inFlight: {
        count: inFlight.reduce((n, p) => n + p.count, 0),
        oldestAt: oldest.length ? Math.min(...oldest) : null,
      },
      mergedToday: { count: merged.length, perHour },
      ciPassRate24h: {
        pct: passed + failed === 0 ? null : (100 * passed) / (passed + failed),
        runs: passed + failed,
        redNow: linked.filter((p) => p.state === "open" && p.ci === "failing").length,
      },
      cycleTime: {
        medianMs: median(today),
        n: today.length,
        avg14dMs: cycles.length ? cycles.reduce((sum, ms) => sum + ms, 0) / cycles.length : null,
      },
      needsYou: { count: needs.length, overHour: needs.filter((i) => now - i.at > HOUR_MS).length },
    },
    pipeline,
    machine: { cpu, mem, diskFreeGb: disk === null ? null : disk / 1024 ** 3 },
  };
}
