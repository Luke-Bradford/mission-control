import { carriedFrom, fixKey, type Run, reviewFor, seatIsPaused } from "@mc/core";
import { readCrewPause } from "../crew-pause.ts";
import type { Store } from "../store.ts";

/**
 * Whether a run set aside in CI or review is due back on its seat: the loop flagged it
 * (`aside.wake`), CI is failing on its pushed sha after its one re-run while it is in `ci`, or
 * its current review (this epoch, the pushed sha) has reported blocking findings whose fix line
 * is not yet claimed. The later readings keep rework ahead of a new ticket in the gap between the
 * poll or RETRO recording the failure and the run's next engine pass setting the flag.
 */
export function asideWakeDue(store: Store, run: Run): boolean {
  const aside = run.loop?.aside;
  if (!aside || run.endedAt !== null || run.loop?.phase === "done") return false;
  if (aside.wake) return true;
  const pushed = store.runPush(run.id);
  if (pushed === null || run.loop === null || run.loop === undefined) return false;
  if (run.loop.phase === "ci") {
    const prNumber = run.loop.prNumber;
    const pr = store.pullRequests(run.repoId).find((p) => p.number === prNumber);
    // the loop's rule: the first failure on a sha is re-run, not sent; it is due after that re-run
    const rerun = run.loop.rerun;
    return (
      pr !== undefined &&
      pr.headSha === pushed.sha &&
      pr.ci === "failing" &&
      (run.loop.ciFailedSha === pushed.sha ||
        (rerun?.sha === pushed.sha &&
          (store.pullRequestReadAt(run.repoId, pr.number) ?? 0) > rerun.at))
    );
  }
  const cur = reviewFor(
    store.reviewsOfRun(run.id),
    run.loop.epoch,
    pushed.sha,
    carriedFrom(run.loop.carry, run.loop.reviewWaivedSha, pushed.sha),
  );
  return (
    cur !== null &&
    cur.state === "reported" &&
    cur.blocking > 0 &&
    !(fixKey(run.id, run.loop.epoch, cur.id) in store.claimedKeys(run.id))
  );
}

/** A run set aside while it was still being built (never pushed), to make way for rework. */
const isDisplaced = (store: Store, run: Run): boolean =>
  run.loop?.phase === "working" && store.runPush(run.id) === null;

/** Only a run eligible under its own pause state may displace or hold up another run. */
function unpausedAsideRuns(store: Store, seatId: string): Run[] {
  const pause = readCrewPause(store);
  return store
    .asideRuns()
    .filter((run) => run.agentId === seatId && !seatIsPaused(pause, seatId, run.id));
}

/**
 * The seat's aside run that is due back, if any: rework on a run with a PR first, oldest first;
 * a run displaced mid-build comes back after all of that.
 */
export function wakeDueAsideRun(store: Store, seatId: string): Run | undefined {
  const due = unpausedAsideRuns(store, seatId).filter((r) => asideWakeDue(store, r));
  return due.find((r) => !isDisplaced(store, r)) ?? due[0];
}

/** Whether another run of the seat has rework due, so the run being built gives way to it. */
export function reworkDueBesides(store: Store, run: Run): boolean {
  return unpausedAsideRuns(store, run.agentId).some(
    (r) => r.id !== run.id && !isDisplaced(store, r) && asideWakeDue(store, r),
  );
}
