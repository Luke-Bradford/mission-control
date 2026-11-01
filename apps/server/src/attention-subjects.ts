import type { PullRequestView, Run } from "@mc/core";
import type { Store } from "./store.ts";

/** A completed verdict applies only to its recorded head; a missing head cannot prove approval. */
export function pendingRunApproval(store: Store, run: Run, knownPr?: PullRequestView): boolean {
  const loop = run.loop;
  if (!loop) return false;
  const pr = knownPr ?? store.pullRequests(run.repoId).find((p) => p.number === loop.prNumber);
  // Display obsolescence only: the stored verdicts and actual merge gates remain intact.
  if (pr && pr.state !== "open") return false;
  if (loop.mergeHold) return true;
  const head = pr?.headSha ?? store.newestRunCommit(run.id)?.sha ?? null;
  if (
    loop.controllerCheckRequired &&
    (!loop.controllerCheck?.pass || head === null || loop.controllerCheck.sha !== head)
  )
    return true;
  if (loop.controllerCheck && !loop.controllerCheck.pass) return true;
  return loop.uat != null && (!loop.uat.accepted || head === null || loop.uat.sha !== head);
}

/** Confirmation is written when a resumed turn starts; only blockers older than the attempt itself are retired. */
export function confirmedResumeAfter(store: Store, run: Run, at: number): boolean {
  const prefix = `${run.id}:resume-confirmed:`;
  return store.loopEventsOfRun(run.id).some((e) => {
    if (!e.key.startsWith(prefix)) return false;
    const startedAt = Number(e.key.slice(prefix.length));
    return Number.isFinite(startedAt) && startedAt > at;
  });
}
