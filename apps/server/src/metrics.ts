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
  /** The repos in view: the session's repo, else every configured repo (cycle time, cost). */
  repoIds: readonly string[];
  /** The session's repo, else the crew sessions' repos (in progress, merged). */
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

  // Merged counts the crew sessions' repos; the observed loops' own repos are a separate figure.
  const crewRepos = new Set(scope.pipelineRepoIds);
  const merged = { count: 0, loops: 0 };
  for (const p of prs) {
    if (p.mergedAt === null || p.mergedAt <= now - MERGED_WINDOW_MS || p.mergedAt > now) continue;
    if (crewRepos.has(p.repoId)) merged.count += 1;
    else merged.loops += 1;
  }

  const cycles: number[] = [];
  let excluded = 0;
  for (const i of store.flowIssues(now - CYCLE_TIME_DAYS * DAY_MS)) {
    if (!repos.has(i.repoId) || i.doneAt === null || i.doneAt > now) continue;
    if (i.startAt === null || i.startAt > i.doneAt) excluded += 1;
    else cycles.push(i.doneAt - i.startAt);
  }

  const digests = store.digests(runs.map((r) => r.id));
  // Unknown, not $0, when no run in scope reported a cost.
  let usd: number | null = null;
  for (const run of runs) {
    if (run.costUsd === null) continue;
    usd = (usd ?? 0) + (runSpend(run, digests.get(run.id), midnight, now)[0] ?? 0);
  }

  return {
    at: now,
    inProgress: inProgressOf(pipeline),
    merged,
    cycleTime: {
      p50Ms: percentile(cycles, 50),
      p85Ms: percentile(cycles, 85),
      n: cycles.length,
      excluded,
    },
    cost: { usd },
  };
}
