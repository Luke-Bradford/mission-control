import {
  type PullRequestView,
  type ReviewCheckState,
  type ReviewRow,
  reviewCheckOf,
} from "@mc/core";
import type { Store } from "./store.ts";

/**
 * A PR's review state for the API: the repo's queued reviews are read once, then each open PR is
 * looked up by its own review rows and its author run's loop. Null for a PR that is not open.
 * Pass `queued` when the caller already holds the queued reviews.
 */
export function reviewCheckFor(
  store: Store,
  repoId: string,
  _now: number,
  queued?: readonly ReviewRow[],
): (pr: PullRequestView) => ReviewCheckState | null {
  const waiting = (queued ?? store.reviewsIn(["queued"]))
    .filter((r) => r.repoId === repoId && r.state === "queued")
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  return (pr) => {
    if (pr.state !== "open") return null;
    const rows = store.reviewsOfPr(repoId, pr.number);
    const last = rows.findLast((r) => r.state !== "superseded");
    if (last === undefined) return null;
    // each review seat serves its own oldest queued row: the queue is the seat's, not the repo's
    const ahead = waiting
      .filter((r) => r.seatId === last.seatId)
      .findIndex((r) => r.id === last.id);
    return reviewCheckOf(rows, Math.max(0, ahead), store.run(last.authorRunId)?.loop ?? null);
  };
}
