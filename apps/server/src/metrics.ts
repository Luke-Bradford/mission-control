import {
  CYCLE_TIME_DAYS,
  MERGED_WINDOW_MS,
  type MetricsView,
  percentile,
  startOfLocalDay,
} from "@mc/core";
import { inProgressOf, pipelineStages } from "./overview.ts";
import { runSpend } from "./spend.ts";
import type { Store } from "./store.ts";

const DAY_MS = 24 * 60 * 60_000;

export interface MetricsScope {
  /** The repos in view: the session's repo, else every configured repo. */
  repoIds: readonly string[];
  /** The repos the pipeline reads boards from: the session's repo, else the crew sessions' repos. */
  pipelineRepoIds: readonly string[];
  timezone: string;
}

/**
 * The registry figures the server measures (`METRICS` in @mc/core defines each one). The Overview
 * summary reads In progress from the same `pipelineStages`, so the two never disagree.
 */
export function metricsView(store: Store, now: number, scope: MetricsScope): MetricsView {
  const repos = new Set(scope.repoIds);
  const midnight = startOfLocalDay(now, scope.timezone);
  const from = Math.min(midnight, now - MERGED_WINDOW_MS);
  const runs = store.runsOverlapping(from, now + 1).filter((r) => repos.has(r.repoId));
  const prs = scope.repoIds.flatMap((id) => store.overviewPullRequests(id, from));
  const pipeline = pipelineStages(store, now, {
    runs,
    prs,
    pipelineRepos: new Set(scope.pipelineRepoIds),
    midnight,
  });

  const merged = prs.filter(
    (p) => p.mergedAt !== null && p.mergedAt > now - MERGED_WINDOW_MS && p.mergedAt <= now,
  ).length;

  const cycles: number[] = [];
  let excluded = 0;
  for (const i of store.flowIssues(now - CYCLE_TIME_DAYS * DAY_MS)) {
    if (!repos.has(i.repoId) || i.doneAt === null || i.doneAt > now) continue;
    if (i.startAt === null || i.startAt > i.doneAt) excluded += 1;
    else cycles.push(i.doneAt - i.startAt);
  }

  const digests = store.digests(runs.map((r) => r.id));
  const usd = runs.reduce(
    (sum, run) => sum + (runSpend(run, digests.get(run.id), midnight, now)[0] ?? 0),
    0,
  );

  return {
    at: now,
    inProgress: inProgressOf(pipeline),
    merged: { count: merged },
    cycleTime: {
      p50Ms: percentile(cycles, 50),
      p85Ms: percentile(cycles, 85),
      n: cycles.length,
      excluded,
    },
    cost: { usd },
  };
}
