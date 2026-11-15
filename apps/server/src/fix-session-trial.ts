/**
 * The fix-session trial's receipts (#1643): one row per trial run, and each arm's medians and
 * totals over its merged runs. Read-only; the assignment lives in the engine.
 */
import {
  FIX_TRIAL_MAX_ASSIGNED,
  FIX_TRIAL_TARGET,
  type FixSessionArm,
  type FixTrialArm,
  type FixTrialFigures,
  type FixTrialRun,
  type FixTrialStatus,
  type FixTrialTokens,
  type FixTrialView,
  fixTrialStratum,
  type Run,
  type RunTokenAudit,
} from "@mc/core";
import type { CcConfig } from "./config.ts";
import { issueOf } from "./mcp/tools.ts";
import type { Store } from "./store.ts";

/** Whether the run's PR on its branch merged (or the merge step recorded it). */
export function fixTrialMerged(store: Store, run: Run): boolean {
  if ((run.loop?.merging?.done ?? []).includes("merge")) return true;
  const number = run.loop?.prNumber ?? null;
  return store
    .pullRequests(run.repoId)
    .some(
      (p) =>
        p.state === "merged" &&
        (number !== null ? p.number === number : run.branch !== null && p.branch === run.branch),
    );
}

/** The Size label of the run's ticket on the board, or null. */
export function fixTrialSize(store: Store, run: Run): string | null {
  const issue = issueOf(run);
  return issue === null ? null : (store.boardItem(run.repoId, issue)?.size ?? null);
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
};
const sum = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);

function tokensOf(run: Run, audit: RunTokenAudit | undefined): FixTrialTokens | null {
  if (audit === undefined) return null;
  const fresh = audit.sessions?.find((s) => s.fresh);
  return {
    calls: audit.calls,
    peakContext: audit.peakContext,
    medianContext: audit.medianContext,
    fixStartContext: fresh?.startContext ?? null,
    cacheRead: audit.cacheRead,
    readAfterReport: audit.readAfterReport,
    readAfterReportShare:
      audit.readAfterReport === null || audit.cacheRead === 0
        ? null
        : audit.readAfterReport / audit.cacheRead,
    cacheWrite: audit.cacheWrite,
    output: audit.output,
    rewrites: audit.rewrites,
    reread: sum(Object.values(audit.bySource).map((c) => c.reread)),
    costUsd: run.costUsd,
  };
}

function figures(runs: readonly FixTrialRun[], reduce: (v: number[]) => number): FixTrialFigures {
  const of = (pick: (r: FixTrialRun) => number): number => reduce(runs.map(pick));
  const tok = (pick: (t: FixTrialTokens) => number | null): number =>
    reduce(
      runs.flatMap((r) => {
        const v = r.tokens === null ? null : pick(r.tokens);
        return v === null ? [] : [v];
      }),
    );
  return {
    runs: runs.length,
    ciFailures: of((r) => r.ciFailures),
    reviewRounds: of((r) => r.reviewRounds),
    blockingRounds: of((r) => r.blockingRounds),
    fixWakes: of((r) => r.fixWakes),
    calls: tok((t) => t.calls),
    peakContext: tok((t) => t.peakContext),
    medianContext: tok((t) => t.medianContext),
    fixStartContext: tok((t) => t.fixStartContext),
    cacheRead: tok((t) => t.cacheRead),
    readAfterReport: tok((t) => t.readAfterReport),
    cacheWrite: tok((t) => t.cacheWrite),
    output: tok((t) => t.output),
    rewrites: tok((t) => t.rewrites),
    reread: tok((t) => t.reread),
    costUsd: tok((t) => t.costUsd),
  };
}

/** `GET /api/audit/fix-sessions`. */
export function fixSessionTrialView(store: Store, config: CcConfig): FixTrialView {
  const trial = store.fixTrialRuns();
  const since = trial.reduce((m, r) => Math.min(m, r.startedAt), Number.MAX_SAFE_INTEGER);
  const audits = new Map(
    trial.length === 0 ? [] : store.runTokenAudits(since).map((a) => [a.run.id, a.audit]),
  );
  const runs: FixTrialRun[] = trial.map((run) => {
    const loop = run.loop;
    const size = fixTrialSize(store, run);
    const claimed = Object.keys(store.claimedKeys(run.id));
    const reported = store.reviewsOfRun(run.id).filter((r) => r.state === "reported");
    let status: FixTrialStatus;
    let reason: string | null = null;
    if (run.endedAt === null) {
      const held = loop?.parked != null || loop?.mergeHold != null;
      status = held ? "held" : "open";
      reason = loop?.mergeHold?.reason ?? loop?.parked?.reason ?? null;
    } else {
      status = fixTrialMerged(store, run) ? "merged" : "ended-unmerged";
      if (status === "ended-unmerged") reason = `ended ${run.status}`;
    }
    return {
      runId: run.id,
      ticket: run.ticket ?? run.id,
      agentId: run.agentId,
      stratum: fixTrialStratum(size),
      size,
      arm: loop?.fixArm ?? "continue",
      status,
      reason,
      fixWakes: store.loopEventsOfRun(run.id).filter((e) => e.key.startsWith(`${run.id}:woken:`))
        .length,
      freshSessions: loop?.fixSessions?.length ?? 0,
      fallbacks: loop?.fixFallbacks?.length ?? 0,
      ciFailures: claimed.filter((k) => k.startsWith(`ci:${run.id}:`)).length,
      reviewRounds: reported.length,
      blockingRounds: reported.filter((r) => r.blocking > 0).length,
      tokens: tokensOf(run, audits.get(run.id)),
    };
  });
  const arm = (a: FixSessionArm): FixTrialArm => {
    const mine = runs.filter((r) => r.arm === a);
    const merged = mine.filter((r) => r.status === "merged");
    return {
      assigned: mine.length,
      merged: merged.length,
      incomplete: mine
        .filter((r) => r.status !== "merged")
        .map((r) => ({ runId: r.runId, ticket: r.ticket, status: r.status, reason: r.reason })),
      median: figures(merged, median),
      total: figures(merged, sum),
    };
  };
  return {
    enabled: config.crew?.fixSessionTrial === true,
    target: FIX_TRIAL_TARGET,
    maxAssigned: FIX_TRIAL_MAX_ASSIGNED,
    runs,
    arms: { continue: arm("continue"), fresh: arm("fresh") },
  };
}
