/**
 * What a hub owns. An automatic GitHub write (a card move, a branch delete, a PR body edit, a
 * review status) happens only for work tied to a run in this hub's own store, or a PR someone
 * asked this hub to review. A second hub on the same repo, even under the same GitHub login, has
 * runs this store cannot see, so what has no run here is not ours. Reading and showing is never
 * limited.
 */
import type { PullRequestView, RepoId } from "@mc/core";
import { externalReviewAsked } from "./external-pr-control.ts";
import type { Store } from "./store.ts";

/** A build run in this store has the branch. An ended run counts; a review run does not. */
export function ownsBranch(store: Store, repoId: RepoId, branch: string): boolean {
  return store.runsOnBranch(repoId, branch).some((r) => r.reviewId == null);
}

/** The PR's branch is owned, or someone asked this hub to review the PR. */
export function ownsPr(
  store: Store,
  repoId: RepoId,
  pr: Pick<PullRequestView, "number" | "branch">,
): boolean {
  return ownsBranch(store, repoId, pr.branch) || externalReviewAsked(store, repoId, pr.number);
}

/** A build run has the ticket, or a real run in this store moved the card. */
export function ownsCard(store: Store, repoId: RepoId, issue: number): boolean {
  return (
    store.runsOnTicket(repoId, `${repoId}#${issue}`).length > 0 || store.runMovedCard(repoId, issue)
  );
}
