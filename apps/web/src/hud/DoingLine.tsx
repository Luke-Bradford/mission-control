import type { CrewRow, PullRequestView } from "@mc/core";
import { doingLine, reviewParts, seatReview } from "../crew.ts";
import { RepoRef } from "./RepoRef.tsx";

/**
 * A row's doing line (see doingLine). A seat waiting on review has its PR linked through RepoRef,
 * then its title (or its last words); every other line is text. `repoPrs` is where the title is.
 */
export function DoingLine({
  row,
  now,
  tz,
  repoPrs,
}: {
  row: CrewRow;
  now: number;
  tz: string | null;
  repoPrs?: readonly PullRequestView[];
}) {
  const review = seatReview(row, now, repoPrs);
  if (!review) return <>{doingLine(row, now, tz, repoPrs)}</>;
  const { before, after } = reviewParts(review);
  return (
    <>
      {before}
      <RepoRef repoId={row.repoId} number={review.prNumber} kind="pr" bare />
      {after}
    </>
  );
}
