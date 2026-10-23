import { NO_SIZE, seatCallSign, type Telemetry } from "@mc/core";
import { dayLabel, dur, narrowDay } from "../fmt.ts";
import { HBar } from "../hud/charts/HBar.tsx";
import { VBars } from "../hud/charts/VBars.tsx";
import { Panel } from "../hud/Panel.tsx";
import { DASH, NOT_TRACKED, NOT_TRACKED_TITLE, type Scope } from "./common.ts";

function Stat({
  value,
  label,
  title,
  nt,
}: {
  value: string;
  label: string;
  title?: string;
  /** The figure is not stored: small and muted. */
  nt?: boolean;
}) {
  return (
    <div className="stat2">
      <b className={nt ? "nt" : undefined} title={title}>
        {value}
      </b>
      <span>{label}</span>
    </div>
  );
}

const tickets = (n: number): string => `${n} ${n === 1 ? "ticket" : "tickets"}`;

/** Flow of work (catalogue 2.6.3): throughput, cycle time, quality and review, You as CAPCOM. */
export function FlowOfWork({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const wait = <p className="pb s muted">{scope.wait}</p>;
  // A size with no tickets has no median, whatever the number says: no bar, and no say in the scale.
  const median = (r: { medianDays: number | null; tickets: number }): number | null =>
    r.tickets === 0 ? null : r.medianDays;
  const longest = Math.max(1, ...(t?.cycleTime.rows.map((r) => median(r) ?? 0) ?? []));
  const ci = t?.quality.ciGreenFirstPushPct ?? null;
  const reviewed = `${t?.quality.reviewedPrs ?? 0} merged PRs with a review`;
  const noReviewed = "No merged PRs with a review in the last 14 days.";
  // A review figure the hub does not send is not tracked; one it sends as null has no PRs to show.
  const reviewStat = (
    value: number | null | undefined,
    show: (n: number) => string,
  ): { value: string; title: string; nt?: boolean } =>
    !t
      ? { value: DASH, title: scope.wait }
      : value === undefined
        ? { value: NOT_TRACKED, title: NOT_TRACKED_TITLE, nt: true }
        : value === null
          ? { value: DASH, title: noReviewed }
          : { value: show(value), title: reviewed };
  const rounds = reviewStat(t?.quality.reviewRoundsPerPr, (n) => n.toFixed(1));
  const findings = reviewStat(t?.quality.retroFindingsPerPr, (n) => n.toFixed(1));
  const sentBack = reviewStat(t?.quality.sentBackPrs, String);
  if (t?.quality.sentBackPrs !== undefined && t.quality.firstPassReviewPct != null)
    sentBack.title = `${Math.round(t.quality.firstPassReviewPct)}% passed the first review round`;
  const humanWait = reviewStat(t?.quality.humanReviewWaitMs, dur);
  // It measures the hub's "ready" and "review" notes, not merged PRs: its own titles.
  if (t?.quality.humanReviewWaitMs !== undefined)
    humanWait.title =
      t.quality.humanReviewWaitMs === null
        ? "No finished PR waited for your review in the last 14 days."
        : "How long a finished PR waited for your review, median, last 14 days.";
  const capcomStat = (value: number | null | undefined, show: (n: number) => string) => {
    const stat = reviewStat(value, show);
    if (t?.capcom && value !== undefined) stat.title = "today";
    return stat;
  };
  const capcom = t?.capcom;
  const notTracked = { value: NOT_TRACKED, title: NOT_TRACKED_TITLE, nt: true };

  return (
    <div className="tgrid">
      <Panel id="tThru" title="Throughput" sub="tickets merged per day · last 14 days">
        {!t ? (
          wait
        ) : t.throughput.length === 0 ? (
          <p className="pb s muted">No days to show yet.</p>
        ) : (
          <div className="pb">
            <VBars
              label="Tickets merged per day"
              every={2}
              accentLast
              bars={t.throughput.map((d) => ({
                key: d.day,
                label: narrowDay(d.day),
                tip: `${dayLabel(d.day)}: ${d.merged} merged`,
                segments: [{ name: "merged", value: d.merged }],
              }))}
            />
          </div>
        )}
      </Panel>
      {/* Decision (Task 6): work starts at Ready or, when a ticket skipped it, In progress. */}
      <Panel
        id="tCycle"
        title="Cycle time"
        sub="Ready (or In progress) to Done, median days by size"
      >
        {!t ? (
          wait
        ) : (
          <div className="pb">
            {t.cycleTime.rows.map((r) => {
              const days = median(r);
              return (
                <HBar
                  key={r.size}
                  label={r.size === NO_SIZE ? "no size" : r.size}
                  pct={((days ?? 0) / longest) * 100}
                  value={days === null ? DASH : `${days.toFixed(1)} d`}
                  extra={tickets(r.tickets)}
                />
              );
            })}
            <p className="note xs tnote">
              Measured from the board: from the first move into Ready, In progress, In review or
              Ready for QA to when the ticket reached Done. {t.cycleTime.excluded} done tickets went
              straight to Done.
            </p>
          </div>
        )}
      </Panel>
      <Panel id="tQual" title="Quality and review" sub="last 14 days">
        <div className="pb">
          <div className="stats">
            <Stat {...notTracked} label="verify passed first try" />
            <Stat {...rounds} label="review rounds per PR" />
            <Stat {...findings} label="RETRO findings per PR" />
            <Stat {...humanWait} label="median wait for a human review" />
            <Stat {...sentBack} label="PRs sent back by reviewers" />
            <Stat
              value={ci === null ? DASH : `${Math.round(ci)}%`}
              label="CI green on first push"
              title={
                !t
                  ? scope.wait
                  : ci === null
                    ? "No merged PRs with a known first-push CI result in the last 14 days."
                    : `${t.quality.prs} merged PRs with a known first-push CI result`
              }
            />
          </div>
        </div>
      </Panel>
      <Panel id="tCapcom" title="You as CAPCOM" sub="how long work waits on you">
        <div className="pb">
          <div className="stats">
            <Stat {...capcomStat(capcom?.answered, String)} label="decisions today" />
            <Stat {...capcomStat(capcom?.medianMs, dur)} label="median response" />
            <Stat {...capcomStat(capcom?.p90Ms, dur)} label="slowest 10%" />
            <Stat {...capcomStat(capcom?.stopped, String)} label="runs you stopped" />
          </div>
          {capcom?.longest && (
            <p className="note xs tnote">
              Longest wait today: {seatCallSign(capcom.longest.agentId)}'s question,{" "}
              {dur(capcom.longest.ms)}. Agent time spent waiting on you today:{" "}
              {dur(capcom.agentWaitMs)}.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
