import { createHash } from "node:crypto";
import type { ReviewRow } from "@mc/core";

/** A pruned/reused native row ID must never make an old permalink open another review. */
export function qaNativeIdentity(
  review: Pick<
    ReviewRow,
    | "id"
    | "repoId"
    | "prNumber"
    | "sha"
    | "seatId"
    | "runId"
    | "authorRunId"
    | "createdAt"
    | "epoch"
    | "attempt"
    | "round"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        review.id,
        review.repoId,
        review.prNumber,
        review.sha,
        review.seatId,
        review.runId,
        review.authorRunId,
        review.createdAt,
        review.epoch,
        review.attempt,
        review.round,
      ]),
    )
    .digest("hex");
}
