import type { Store } from "../store.ts";

/** Why the engine left a queued review unstarted on its last pass, and the PR it waits on, if any. */
export interface ReviewHold {
  reason: string;
  prNumber: number | null;
}

const key = (reviewId: number): string => `review-hold:${reviewId}`;

/** The hold recorded for a queued review, or null. */
export function reviewHoldOf(store: Store, reviewId: number): ReviewHold | null {
  const raw = store.getSetting(key(reviewId));
  if (raw === null) return null;
  try {
    const hold = JSON.parse(raw) as Partial<ReviewHold>;
    return typeof hold.reason === "string"
      ? { reason: hold.reason, prNumber: typeof hold.prNumber === "number" ? hold.prNumber : null }
      : null;
  } catch {
    return null;
  }
}

/** Records the hold (or clears it with null); it writes only when the hold changed. */
export function setReviewHold(store: Store, reviewId: number, hold: ReviewHold | null): void {
  const next =
    hold === null ? null : JSON.stringify({ reason: hold.reason, prNumber: hold.prNumber });
  if (store.getSetting(key(reviewId)) === next) return;
  if (next === null) store.deleteSetting(key(reviewId));
  else store.setSetting(key(reviewId), next);
}
