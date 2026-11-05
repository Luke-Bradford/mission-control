import { carriedFrom, type PullRequestView, type ReviewRow, reviewFor } from "@mc/core";
import type { Store } from "./store.ts";

/**
 * The review of an open PR's current head when it reported blocking findings the loop still
 * counts: the ticket is in rework (a developer owes a fix), not waiting on a review. Judged as the
 * loop judges it, by the author run's epoch, waiver and carried review. A superseded re-review is
 * skipped, so it does not hide the blocking one. Null otherwise, including once a push has moved
 * the head past the reviewed sha.
 */
export function reworkReview(store: Store, pr: PullRequestView): ReviewRow | null {
  if (pr.state !== "open") return null;
  const rows = store.reviewsOfPr(pr.repoId, pr.number);
  const newest = rows.findLast((r) => r.state !== "superseded");
  if (newest === undefined) return null;
  const head = pr.headSha ?? newest.sha;
  const loop = store.run(newest.authorRunId)?.loop;
  if (loop?.reviewWaivedSha === head) return null;
  const authored = rows.filter((r) => r.authorRunId === newest.authorRunId);
  const current =
    loop == null
      ? newest.sha === head
        ? newest
        : null
      : reviewFor(authored, loop.epoch, head, carriedFrom(loop.carry, loop.reviewWaivedSha, head));
  const row = current === null ? null : (authored.find((r) => r.id === current.id) ?? null);
  return row !== null && row.state === "reported" && row.blocking > 0 ? row : null;
}
