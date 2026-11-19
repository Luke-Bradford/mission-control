import { carriedFrom, fixKey, type Run, reviewFor, seatIsPaused } from "@mc/core";
import { readCrewPause } from "../config/crew-pause.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";

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
  // a run on its seat is not waiting for one: a restart between its wake and the loop clearing
  // `aside` leaves the flag set, and it must not set the seat's next run aside, over and over
  const row = store.seatSession(run.agentId);
  if (row?.runId === run.id && ACTIVE_SEAT_STATES.includes(row.state)) return false;
  if (aside.wake) return true;
  // parked on the operator's question: not due back until it is answered (the loop then wakes it)
  if (aside.ask !== undefined) return false;
  return fixDueReason(store, run) !== null;
}

/**
 * What a run set aside is owed a fix for, read from the store: "ci" when CI is failing on its
 * pushed sha after its one re-run, "review" when its current review has reported blocking
 * findings whose fix line is not yet claimed; else null.
 */
function fixDueReason(store: Store, run: Run): "ci" | "review" | null {
  const pushed = store.runPush(run.id);
  if (pushed === null || run.loop === null || run.loop === undefined) return null;
  if (run.loop.phase === "ci") {
    const prNumber = run.loop.prNumber;
    const pr = store.pullRequests(run.repoId).find((p) => p.number === prNumber);
    // the loop's rule: the first failure on a sha is re-run, not sent; it is due after that re-run
    const rerun = run.loop.rerun;
    return pr !== undefined &&
      pr.headSha === pushed.sha &&
      pr.ci === "failing" &&
      (run.loop.ciFailedSha === pushed.sha ||
        (rerun?.sha === pushed.sha &&
          (store.pullRequestReadAt(run.repoId, pr.number) ?? 0) > rerun.at))
      ? "ci"
      : null;
  }
  const cur = reviewFor(
    store.reviewsOfRun(run.id),
    run.loop.epoch,
    pushed.sha,
    carriedFrom(run.loop.carry, run.loop.reviewWaivedSha, pushed.sha),
  );
  return cur !== null &&
    cur.state === "reported" &&
    cur.blocking > 0 &&
    !(fixKey(run.id, run.loop.epoch, cur.id) in store.claimedKeys(run.id))
    ? "review"
    : null;
}

/** Only a run eligible under its own pause state may displace or hold up another run. */
function unpausedAsideRuns(store: Store, seatId: string): Run[] {
  const pause = readCrewPause(store);
  return store
    .asideRuns()
    .filter((run) => run.agentId === seatId && !seatIsPaused(pause, seatId, run.id));
}

/** The seat's aside run that is due back, if any, oldest first. */
export function wakeDueAsideRun(store: Store, seatId: string): Run | undefined {
  return unpausedAsideRuns(store, seatId).find((r) => asideWakeDue(store, r));
}
