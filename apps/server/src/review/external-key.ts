import type { ReviewRow } from "@mc/core";

/** A review subject identity, deliberately not the id of a stored build run. */
export const externalReviewKey = (repo: string, pr: number): string => `external-pr:${repo}#${pr}`;
export const isExternalReview = (row: ReviewRow): boolean =>
  row.authorRunId === externalReviewKey(row.repoId, row.prNumber);
