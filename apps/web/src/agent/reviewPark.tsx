import type { RunLoop } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";
import { shortSha } from "../fmt.ts";
import { Reason } from "./Reason.tsx";
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

export const reviewParkSha = (park: ReviewPark): string => shortSha(park.sha);

export const reviewParkConfirm = (park: ReviewPark): string =>
  `Waive RETRO's findings on ${reviewParkSha(park)} and resume this run? This accepts: ${park.reason}`;

/** An intentional waiver is separate from the normal message/rework route. */
export function WaiveReviewFindings({
  runId,
  park,
  compact = false,
  findings = true,
}: {
  runId: string;
  park: ReviewPark;
  /** One line for a table cell: a short button whose full name and the findings sit in its title. */
  compact?: boolean;
  /** False where the page already shows the findings (the current step's details). */
  findings?: boolean;
}) {
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
  const name = `Waive findings on ${reviewParkSha(park)} and resume`;
  if (compact)
    return (
      <span className="waive-compact">
        <button
          type="button"
          className="sm warn"
          disabled={busy}
          aria-label={name}
          title={`Findings on ${reviewParkSha(park)}: ${park.reason}. ${name}.`}
          onClick={() => {
            if (window.confirm(reviewParkConfirm(park))) void waive();
          }}
        >
          Waive
        </button>
        {error && (
          <span className="ellip crit-t s" role="alert" title={error}>
            {error}
          </span>
        )}
      </span>
    );
  return (
    <div className="s">
      {findings && (
        <Reason
          className="vnow xs muted"
          line={`Findings on ${reviewParkSha(park)}`}
          full={park.reason}
        />
      )}
      <button
        type="button"
        className="sm warn"
        disabled={busy}
        onClick={() => {
          if (window.confirm(reviewParkConfirm(park))) void waive();
        }}
      >
        {name}
      </button>
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Several review-parked runs on one seat: one menu in a table cell, an action per run. */
export function WaiveReviewMenu({ parks }: { parks: { runId: string; park: ReviewPark }[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (runId: string) => {
    const found = parks.find((p) => p.runId === runId);
    if (!found || !window.confirm(reviewParkConfirm(found.park))) return;
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
    <span className="waive-compact">
      <select
        className="sm warn"
        value=""
        disabled={busy}
        aria-label={`Waive review findings: ${parks.length} parked runs`}
        onChange={(e) => void pick(e.target.value)}
      >
        <option value="">Waive ({parks.length})…</option>
        {parks.map(({ runId, park }) => (
          <option key={runId} value={runId} title={park.reason}>
            Waive {reviewParkSha(park)}
          </option>
        ))}
      </select>
      {error && (
        <span className="ellip crit-t s" role="alert" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
