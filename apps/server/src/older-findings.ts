import { BLOCKING_SEVERITIES, type ReviewRow, type StoredFinding } from "@mc/core";
import type { Store } from "./store.ts";

export interface OlderFinding {
  reviewId: number;
  sha: string;
  finding: StoredFinding;
}

/**
 * The blocking findings still open from reviews of an external review's earlier heads: what its
 * brief lists and what its report may resolve. A clean review since then accepted the work before
 * it, so only reviews after the last clean one count (the previous review of the same subject
 * included); the previous review's own findings are left out, as the brief shows them already.
 */
export function openOlderFindings(
  store: Pick<Store, "reviewsOfPr" | "findingsOf">,
  review: Pick<ReviewRow, "id" | "repoId" | "prNumber" | "sha">,
  prevId: number | null,
): OlderFinding[] {
  const reported = store
    .reviewsOfPr(review.repoId, review.prNumber)
    .filter((r) => r.state === "reported" && r.id < review.id);
  return reported
    .slice(reported.findLastIndex((r) => r.blocking === 0) + 1)
    .filter((r) => r.id !== prevId && r.sha !== review.sha)
    .flatMap((r) =>
      store
        .findingsOf(r.id)
        .filter(
          (f) =>
            BLOCKING_SEVERITIES.includes(f.severity) &&
            f.state === "open" &&
            f.resolution === undefined,
        )
        .map((finding) => ({ reviewId: r.id, sha: r.sha, finding })),
    );
}
