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
    const ahead = waiting.findIndex((r) => r.id === last.id);
    return reviewCheckOf(
      rows,
      ahead < 0 ? waiting.length : ahead,
      store.run(last.authorRunId)?.loop ?? null,
    );
  };
}
