import {
  FLOW_DAYS,
  GUARD_RULES,
  type GuardHitsView,
  type GuardRule,
  type QaFlowView,
  type Telemetry,
} from "@mc/core";
import { useRef } from "react";
import { ListScrollCue } from "../agent/ListScrollCue.tsx";
import { useTz } from "../clock.ts";
import { hub, RESOURCES, type Resource, useResource } from "../data.ts";
import { dayMonth, percent, plural } from "../fmt.ts";
import { HBar } from "../hud/charts/HBar.tsx";
import { Panel } from "../hud/Panel.tsx";
import { PAGE_PATHS, ticketPath } from "../router.ts";
import { DASH } from "./common.ts";
import { DailyRateChart } from "./DailyRateChart.tsx";
import { GUARD_DRAWER_HREF } from "./guardCopy.ts";
import {
  collectedFrom,
  type DailyCount,
  ROLLING_DAYS,
  readQuality14,
  rollingRate,
} from "./quality.ts";
import { Cell, Stat, type StatSpec } from "./Stat.tsx";

/** Quality's daily counts are fixed to the same fourteen-day window as its summary. */
export const QUALITY_RANGE = "7d";
const WINDOW = `${FLOW_DAYS}d`;

export const QUALITY_SUMMARY_COUNT = 6;

const one = (n: number | null | undefined): string => (n == null ? DASH : n.toFixed(1));

/** The Quality summary row: review and CI figures over the last 14 days. */
export function QualitySummaryRow({
  t,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const q = t?.quality;
  const audit = {
    kind: "link",
    href: PAGE_PATHS.audit,
    target: "the Audit page, review tab",
  } as const;
  const pct = (v: number | null | undefined): string => (v == null ? DASH : percent(v));
  /** Why a figure is missing: still loading, not sent, or nothing in the window to count. */
  const why = (v: number | null | undefined, none: string): string | undefined =>
    v != null
      ? undefined
      : !t
        ? "Loading."
        : !q
          ? "Not collected: the server sent no quality figures."
          : `No ${none} in the last ${FLOW_DAYS} days.`;
  const stats: StatSpec[] = [
    {
      id: "ci",
      label: "CI first push",
      value: pct(q?.ciGreenFirstPushPct),
      unit: "% of merged PRs",
      window: WINDOW,
      reason: why(q?.ciGreenFirstPushPct, "merged PRs with a known first-push CI result"),
      definition: "Share of merged PRs whose checks were green on the first push.",
      drill: { kind: "needs-route", target: "the merged PRs behind this share" },
    },
    {
      id: "fp",
      label: "First-pass review",
      value: pct(q?.firstPassReviewPct),
      unit: "% of reviewed PRs",
      window: WINDOW,
      reason: why(q?.firstPassReviewPct, "reviewed PRs"),
      definition: "Share of reviewed PRs with no blocking finding in round 1.",
      drill: { kind: "needs-route", target: "the reviewed PRs behind this share" },
    },
    {
      id: "rounds",
      label: "Review rounds per PR",
      value: one(q?.reviewRoundsPerPr),
      unit: "rounds",
      window: WINDOW,
      reason: why(q?.reviewRoundsPerPr, "reviewed PRs"),
      definition: "Average review rounds before a merged PR with a reported review merged.",
      drill: audit,
    },
    {
      id: "findings",
      label: "RETRO findings per PR",
      value: one(q?.retroFindingsPerPr),
      unit: "findings",
      window: WINDOW,
      reason: why(q?.retroFindingsPerPr, "reviewed PRs"),
      definition: "Average blocking and minor findings a reviewer recorded per reviewed PR.",
      drill: audit,
    },
    {
      id: "wait",
      label: "Human review wait",
      value: q?.humanReviewWaitMs == null ? DASH : String(Math.round(q.humanReviewWaitMs / 60_000)),
      unit: "min median",
      window: WINDOW,
      reason: why(q?.humanReviewWaitMs, "PRs that waited for review"),
      definition: "How long a finished PR waited for your review, median.",
      drill: { kind: "needs-route", target: "the PRs that waited longest" },
    },
    {
      id: "sent",
      label: "PRs sent back",
      value: q?.sentBackPrs == null ? DASH : String(q.sentBackPrs),
      unit: "PRs",
      window: WINDOW,
      reason: why(q?.sentBackPrs, "reviewed PRs"),
      definition: "Reviewed PRs a reviewer sent back at least once.",
      drill: audit,
    },
  ];
  return (
    <section className="summary" aria-label="Quality summary">
      <div className="scope">
        <b>Last {FLOW_DAYS} days</b>
        <span>Fixed window</span>
      </div>
      {stats.map((s) => (
        <Stat key={s.id} stat={s} onNeedsRoute={onNeedsRoute} />
      ))}
    </section>
  );
}

/** The days to plot: from the first collected day, and the note naming the days before it. */
function plotOf(values: (number | null)[], ats: number[], tz: string) {
  const from = collectedFrom(values);
  if (from < 0) return null;
  const before = from > 0 ? dayMonth(ats[from] as number, tz) : null;
  return { from, note: before ? `Not collected before ${before}.` : null };
}

function RatePanel({
  id,
  title,
  barName,
  measure,
  t,
  review,
}: {
  id: string;
  title: string;
  barName: string;
  measure: "ci" | "firstPass";
  t: Telemetry | undefined;
  review: boolean;
}) {
  const tz = useTz() ?? "UTC";
  const points = readQuality14(t?.quality14);
  const values =
    points?.map((p) =>
      p[measure]?.pass === undefined
        ? null
        : ((p[measure] as DailyCount).pass / (p[measure] as DailyCount).total) * 100,
    ) ?? [];
  const plot = plotOf(values, points?.map((p) => p.at) ?? [], tz);
  const sub = `% of ${review ? "reviewed" : "merged"} PRs · last ${FLOW_DAYS} days`;
  if (!plot || !points)
    return (
      <Panel id={id} title={title} sub={sub}>
        <p className="pb s muted">
          {t ? "Daily quality is not collected for this window." : "Loading…"}
        </p>
      </Panel>
    );
  const counts = points.map((p) => p[measure]);
  const rolled = rollingRate(counts).slice(plot.from);
  const days = points.slice(plot.from).map((p) => {
    const count = p[measure];
    return {
      at: p.at,
      v: count ? (count.pass / count.total) * 100 : null,
      detail: count ? `${count.pass} of ${count.total} PRs` : null,
    };
  });
  return (
    <Panel id={id} title={title} sub={sub}>
      <div className="pbody qchart">
        <DailyRateChart
          label={title}
          days={days}
          rolling={rolled}
          rollingName={`${ROLLING_DAYS}-day rolling rate`}
          barName={barName}
          max={100}
          ticks={[0, 50, 100]}
          format={(v) => percent(v)}
          tz={tz}
        />
      </div>
      <p className="pnote">
        Bars are each day's rate; the line pools the trailing {ROLLING_DAYS} days. Days with no PRs
        are gaps.{plot.note ? ` ${plot.note}` : ""}
      </p>
    </Panel>
  );
}

function RoundsPanel({ t }: { t: Telemetry | undefined }) {
  const tz = useTz() ?? "UTC";
  const points = readQuality14(t?.quality14);
  const values = points?.map((p) => (p.rounds ? p.rounds.pass / p.rounds.total : null)) ?? [];
  const plot = plotOf(values, points?.map((p) => p.at) ?? [], tz);
  const sub = `rounds, up to 4 · last ${FLOW_DAYS} days`;
  const gap = <> Test attempts: not collected yet.</>;
  if (!plot || !points)
    return (
      <Panel id="qRounds" title="Rounds per PR" sub={sub}>
        <p className="pb s muted">
          {t ? "Daily review quality is not collected for this window." : "Loading…"}
        </p>
        <p className="pnote">{gap}</p>
      </Panel>
    );
  const peak = Math.max(4, ...values.map((v) => v ?? 0));
  return (
    <Panel id="qRounds" title="Rounds per PR" sub={sub}>
      <div className="pbody qchart">
        <DailyRateChart
          label="Review rounds per PR"
          days={points.slice(plot.from).map((p) => ({
            at: p.at,
            v: p.rounds ? p.rounds.pass / p.rounds.total : null,
            detail: p.rounds ? `${p.rounds.total} reviewed PRs` : null,
          }))}
          barName="Rounds per PR"
          max={Math.ceil(peak)}
          ticks={[0, Math.ceil(peak) / 2, Math.ceil(peak)]}
          format={(v) => v.toFixed(1)}
          tz={tz}
        />
      </div>
      <p className="pnote">
        Mean rounds per reviewed PR, per day.{plot.note ? ` ${plot.note}` : ""}
        {gap}
      </p>
    </Panel>
  );
}

/**
 * What a route's state says beside its panel: nothing while loading or fresh; a failure with a retry
 * when there is no data; a stale note over the last good data when a later read failed.
 */
function ResourceState<T>({ res, path, what }: { res: Resource<T>; path: string; what: string }) {
  if (res.error === null) return null;
  const retry = (
    <button type="button" className="tel-primary" onClick={() => hub.refetch(path)}>
      Try again
    </button>
  );
  return res.data === undefined ? (
    <p className="pb s" role="alert">
      {what} did not load. {retry}
    </p>
  ) : (
    <p className="pnote" role="status">
      Showing the last read of {what.toLowerCase()}; the latest read failed. {retry}
    </p>
  );
}

function GuardPanel({ res }: { res: Resource<GuardHitsView> }) {
  const list = useRef<HTMLDivElement>(null);
  const hits = res.data;
  const rows = hits
    ? (Object.keys(GUARD_RULES) as GuardRule[])
        .map((rule) => ({ rule, count: hits.counts[rule] ?? 0 }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
    : [];
  const top = rows[0]?.count ?? 1;
  return (
    <Panel id="qGuard" title="Guard blocks by rule" sub={`blocks · last ${FLOW_DAYS} days`}>
      <ResourceState res={res} path={RESOURCES.guardHitsFlow.path} what="Guard blocks" />
      {!hits ? (
        res.error ? null : (
          <p className="pb s muted">Loading…</p>
        )
      ) : rows.length === 0 ? (
        <p className="pb s muted">Nothing blocked in the last {FLOW_DAYS} days.</p>
      ) : (
        // Every rule can have a count, so the list scrolls inside its panel; each count is a link, so
        // the keyboard reaches every row and scrolls it into view.
        <div className="pb qlist" ref={list}>
          {rows.map((r) => (
            <HBar
              key={r.rule}
              label={r.rule}
              title={GUARD_RULES[r.rule]}
              pct={(r.count / top) * 100}
              value={
                <Cell
                  text={String(r.count)}
                  label={`${r.rule} blocks`}
                  definition={`${plural(r.count, "block")} by the ${r.rule} rule in the last ${FLOW_DAYS} days. Opens the Guard drawer.`}
                  href={GUARD_DRAWER_HREF}
                />
              }
            />
          ))}
        </div>
      )}
      <ListScrollCue region={list} label="rules" count={rows.length} />
      <p className="pnote">
        A block is a guard rule stopping an action; it is not a failure of the seat.
      </p>
    </Panel>
  );
}

function EscapedTable({ res }: { res: Resource<QaFlowView> }) {
  const tz = useTz() ?? "UTC";
  const flow = res.data;
  const rows = flow?.escapedDefects ?? [];
  return (
    <Panel id="qEscaped" title="Escaped defects" sub={`found after merge · last ${FLOW_DAYS} days`}>
      <ResourceState res={res} path={RESOURCES.qaFlow.path} what="Escaped defects" />
      {!flow ? (
        res.error ? null : (
          <p className="pb s muted">Loading…</p>
        )
      ) : rows.length === 0 ? (
        <p className="pb s muted">No escaped defects in the last {FLOW_DAYS} days.</p>
      ) : (
        <div className="pb tw">
          <table>
            <caption className="sr-only">Escaped defects</caption>
            <thead>
              <tr>
                <th>Defect</th>
                <th>Merged PR</th>
                <th>How found</th>
                <th>Seat</th>
                <th>Model</th>
                <th>Found</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.repoId}#${r.issueNumber}:${r.prNumber}`}>
                  <td>
                    <a href={ticketPath(r.repoId, r.issueNumber)}>
                      {r.repoId}#{r.issueNumber}
                    </a>
                  </td>
                  <td>#{r.prNumber}</td>
                  <td>{r.via}</td>
                  <td>{r.seat ?? DASH}</td>
                  <td>{r.model ?? DASH}</td>
                  <td>{dayMonth(r.filedAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The Quality tab's panels: daily charts and guard blocks as charts, escaped defects as the table. */
export function QualityPanels({
  t,
  view,
  dim,
}: {
  t: Telemetry | undefined;
  view: "charts" | "table";
  dim: boolean;
}) {
  const hits = useResource<GuardHitsView>(RESOURCES.guardHitsFlow);
  const flow = useResource<QaFlowView>(RESOURCES.qaFlow);
  if (view === "table")
    return (
      <div className={`grid${dim ? " dim" : ""}`} data-view="table" data-n="1">
        <EscapedTable res={flow} />
      </div>
    );
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="charts" data-n="4">
      <RatePanel
        id="qCi"
        title="CI green first push"
        barName="Green on first push"
        measure="ci"
        t={t}
        review={false}
      />
      <RatePanel
        id="qFirstPass"
        title="First-pass review"
        barName="No blocking finding"
        measure="firstPass"
        t={t}
        review
      />
      <RoundsPanel t={t} />
      <GuardPanel res={hits} />
    </div>
  );
}
