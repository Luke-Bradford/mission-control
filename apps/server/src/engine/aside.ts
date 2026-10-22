import { currentReview, fixKey, type Run } from "@mc/core";
import type { Store } from "../store.ts";

/**
 * Whether a run set aside in review is due back on its seat: the loop flagged it (`aside.wake`),
 * or its current review (this epoch, the pushed sha) has reported blocking findings whose fix line
 * is not yet claimed. The second reading is what keeps rework ahead of a new ticket in the gap
 * between RETRO recording findings and the author run's next engine pass setting the flag.
 */
export function asideWakeDue(store: Store, run: Run): boolean {
  const aside = run.loop?.aside;
  if (!aside || run.endedAt !== null) return false;
  if (aside.wake) return true;
  const pushed = store.runPush(run.id);
  if (pushed === null || run.loop === null || run.loop === undefined) return false;
  const cur = currentReview(store.reviewsOfRun(run.id), run.loop.epoch, pushed.sha);
  return (
    cur !== null &&
    cur.state === "reported" &&
    cur.blocking > 0 &&
    !(fixKey(run.id, run.loop.epoch, cur.id) in store.claimedKeys(run.id))
  );
}

/** The seat's aside run that is due back, oldest first, if any. */
export function wakeDueAsideRun(store: Store, seatId: string): Run | undefined {
  return store.asideRuns().find((r) => r.agentId === seatId && asideWakeDue(store, r));
}
