import type { CodeHealthReviewQuality } from "@mc/core";
import { percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { label } from "./format.ts";
export function Comparison() {
  return (
    <div className="ch-gap">
      <h3>Previous-window comparison unavailable</h3>
      <p>
        Comparable earlier cohorts have not been collected. No trend or health score is inferred.
      </p>
    </div>
  );
}
export function ReviewRounds({
  review,
  onInspect,
}: {
  review: CodeHealthReviewQuality;
  onInspect: () => void;
}) {
  const max = Math.max(1, ...review.rounds.map((r) => r.prs)),
    rate = review.rework;
  return (
    <Panel title="Observed review rework" sub="Distinct reviewed PRs · maximum reported round">
      <div className="pb ch-stack">
        <p>
          <strong className="ch-value">{percent(rate.percent, 1)}</strong> {rate.numerator} of{" "}
          {rate.denominator} reviewed PRs reached round 2 or later.
        </p>
        {!review.reviewedPrs ? (
          <p>
            No reported reviews were observed in this repo/window. Pending and failed attempts are
            excluded.
          </p>
        ) : (
          <div className="ch-bars">
            {review.rounds.map((r) => (
              <div className="ch-bar-row" key={r.round}>
                <span>Round {r.round === 4 ? "4+" : r.round}</span>
                <span className="ch-track" aria-hidden="true">
                  <span style={{ width: `${(r.prs / max) * 100}%` }} />
                </span>
                <span className="ch-number">{r.prs}</span>
              </div>
            ))}
            <div className="ch-axis">
              <span />
              <span>
                <span>0</span>
                <span>{max} PRs</span>
              </span>
              <span />
            </div>
          </div>
        )}
        <p className="ch-secondary">
          One reported round is not proof of a defect-free change. Recent PRs may receive another
          round.
        </p>
        <button type="button" onClick={onInspect}>
          Inspect reviewed cohort
        </button>
      </div>
    </Panel>
  );
}
export function Categories({
  review,
  onInspect,
}: {
  review: CodeHealthReviewQuality;
  onInspect: () => void;
}) {
  const rows = [...review.categories]
      .sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category))
      .slice(0, 6),
    max = Math.max(1, ...rows.map((r) => r.findings));
  const other =
    review.categories.reduce((sum, row) => sum + row.findings, 0) -
    rows.reduce((sum, row) => sum + row.findings, 0);
  return (
    <Panel
      title="Recurring correction categories"
      sub="Distinct finding identities; resolution and carry remain separate"
    >
      <div className="pb ch-stack">
        {!rows.length ? (
          <p>No categorised findings were observed. Missing categories are counted separately.</p>
        ) : (
          <div className="ch-bars">
            {rows.map((r) => (
              <div className="ch-bar-row" key={r.category}>
                <span>{label(r.category)}</span>
                <span className="ch-track" aria-hidden="true">
                  <span style={{ width: `${(r.findings / max) * 100}%` }} />
                </span>
                <span className="ch-number">{r.findings}</span>
              </div>
            ))}
            <div className="ch-axis">
              <span />
              <span>
                <span>0</span>
                <span>{max} findings</span>
              </span>
              <span />
            </div>
          </div>
        )}
        <p>
          {review.uncategorised.numerator} of {review.uncategorised.denominator} findings are
          uncategorised
          {review.uncategorised.percent === null
            ? ""
            : ` (${percent(review.uncategorised.percent, 1)})`}
          . Counts do not establish per-file incidence.
        </p>
        {other > 0 && (
          <p className="ch-secondary">
            {other} other categorised findings are outside the six displayed categories.
          </p>
        )}
        <button type="button" onClick={onInspect}>
          Inspect finding evidence
        </button>
      </div>
    </Panel>
  );
}
