import type { RunLoop } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";
import { seatError } from "./seat.ts";

const REVIEW_PARK_KINDS = new Set(["review", "review-ruling"]);

export interface ReviewPark {
  sha: string;
  reason: string;
}

/** The only parks whose Resume action waives the findings on the reviewed head. */
export function reviewPark(loop: RunLoop | null | undefined): ReviewPark | null {
  if (!loop?.parked || !REVIEW_PARK_KINDS.has(loop.parked.kind) || !loop.pushFor) return null;
  return { sha: loop.pushFor, reason: loop.parked.reason };
}

export const reviewParkSha = (park: ReviewPark): string => park.sha.slice(0, 7);

export const reviewParkConfirm = (park: ReviewPark): string =>
  `Waive RETRO's findings on ${reviewParkSha(park)} and resume this run? This accepts: ${park.reason}`;

/** An intentional waiver is separate from the normal message/rework route. */
export function WaiveReviewFindings({ runId, park }: { runId: string; park: ReviewPark }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waive = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.runResume(runId), {});
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="s">
      <div className="xs muted">
        Findings on {reviewParkSha(park)}: {park.reason}
      </div>
      <button
        type="button"
        className="sm warn"
        disabled={busy}
        onClick={() => {
          if (window.confirm(reviewParkConfirm(park))) void waive();
        }}
      >
        Waive findings on {reviewParkSha(park)} and resume
      </button>
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
