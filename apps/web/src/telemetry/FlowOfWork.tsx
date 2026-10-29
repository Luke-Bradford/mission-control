import { CYCLE_TIME_MIN_FOR_P85, FLOW_DAYS, formatHours, NO_SIZE, type Telemetry } from "@mc/core";
import { dayLabel, dur, narrowDay } from "../fmt.ts";
import { HBar } from "../hud/charts/HBar.tsx";
import { VBars } from "../hud/charts/VBars.tsx";
import { MetricName } from "../hud/MetricName.tsx";
import { Panel } from "../hud/Panel.tsx";
import { metricTitle, sessionTag, useMetrics } from "../metrics.ts";
import { useSeatName } from "../seatName.ts";
import { chartAnnotations } from "./annotations.ts";
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
  const nameOf = useSeatName();
  const wait = <p className="pb s muted">{scope.wait}</p>;
  const metrics = useMetrics();
  const overall = metrics.readings.cycleTime;
  const tag = sessionTag(metrics.session);
  // A size with no tickets has no p50, whatever the number says: no bar, and no say in the scale.
  const p50 = (r: { p50Ms: number | null; tickets: number }): number | null =>
    r.tickets === 0 ? null : r.p50Ms;
  const longest = Math.max(1, ...(t?.cycleTime.rows.map((r) => p50(r) ?? 0) ?? []));
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
      <Panel id="tThru" title="Throughput" sub="PRs merged per day · last 14 days">
        {!t ? (
          wait
        ) : t.throughput.length === 0 ? (
          <p className="pb s muted">No days to show yet.</p>
        ) : (
          <div className="pb">
            <VBars
              label="PRs merged per day"
              every={2}
              accentLast
              times={t.throughput.map((d) => Date.parse(`${d.day}T12:00:00Z`))}
              annotations={chartAnnotations(t.series?.annotations ?? [])}
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
      {/* Cycle time starts at the ticket's first move into Ready (METRICS.cycleTime). */}
      <Panel
        id="tCycle"
        title="Cycle time"
        sub={`Ready to Done, p50 and p85 hours by size · last ${FLOW_DAYS} days`}
      >
        {!t ? (
          wait
        ) : (
          <div className="pb">
            <p
              className="tcycle-all s"
              title={`${metricTitle(metrics, "cycleTime")}${tag ? `\nOn Telemetry this follows the header's session filter (${tag}); the per-size rows do not.` : ""}`}
            >
              <span className="fg2">
                <MetricName id="cycleTime" tag={tag} />
              </span>{" "}
              <b className="num" data-metric="cycleTime">
                {overall?.value ?? DASH}
              </b>{" "}
              <span className="muted">{overall?.detail ?? ""}</span>
            </p>
            {t.cycleTime.rows.map((r) => {
              const ms = p50(r);
              return (
                <HBar
                  key={r.size}
                  label={r.size === NO_SIZE ? "no size" : r.size}
                  title={r.size === NO_SIZE ? "no size" : r.size}
                  pct={((ms ?? 0) / longest) * 100}
                  value={ms === null ? DASH : formatHours(ms)}
                  extra={
                    r.tickets < CYCLE_TIME_MIN_FOR_P85 || r.p85Ms === null
                      ? tickets(r.tickets)
                      : `p85 ${formatHours(r.p85Ms)} · ${tickets(r.tickets)}`
                  }
                />
              );
            })}
            <p className="note xs tnote">
              Measured from the board: when a ticket entered Ready to when it reached Done. Sizes
              cover every repo; the p50 line above follows the header's session filter.{" "}
              {t.cycleTime.excluded} done tickets left out because they have no Ready entry or their
              timestamps are out of order.
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
              Longest wait today: {nameOf(capcom.longest.agentId)}'s question,{" "}
              {dur(capcom.longest.ms)}. Agent time spent waiting on you today:{" "}
              {dur(capcom.agentWaitMs)}.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
