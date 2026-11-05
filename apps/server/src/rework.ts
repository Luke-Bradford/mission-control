import type { PullRequestView, ReviewRow } from "@mc/core";
import type { Store } from "./store.ts";

/**
 * The newest review of an open PR when it reported blocking findings on the PR's current head:
 * the ticket is in rework (a developer owes a fix), not waiting on a review. Null otherwise,
 * including once a push has moved the head past the reviewed sha.
 */
export function reworkReview(store: Store, pr: PullRequestView): ReviewRow | null {
  if (pr.state !== "open") return null;
  const latest = store.reviewsOfPr(pr.repoId, pr.number).at(-1);
  return latest !== undefined &&
    latest.state === "reported" &&
    latest.blocking > 0 &&
    (pr.headSha === null || pr.headSha === latest.sha)
    ? latest
    : null;
}
