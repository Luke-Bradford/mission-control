import {
  type AuditAction,
  type AuditChange,
  type AuditReport,
  type AuditReportView,
  type AuditView,
  auditActions,
  auditNoteText,
  auditVerdict,
  type ConfigView,
  MC_AUDIT_NO_REPORT,
  type WasteReport,
} from "@mc/core";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocale, useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { cost, elapsed, percent, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";
import { agentPath, tracePath } from "../router.ts";
import { ModelPanels } from "./ModelTable.tsx";
import "./audit.css";

const RANGES = ["7d", "30d", "90d", "365d"] as const;
type AuditRange = (typeof RANGES)[number];
const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: value }));

const DECIDER_FILTERS = ["all", "you", "flight"] as const;
type DeciderFilter = (typeof DECIDER_FILTERS)[number];
const FILTER_OPTIONS = DECIDER_FILTERS.map((value) => ({
  value,
  label: value === "all" ? "All" : value === "you" ? "You" : "FLIGHT",
}));

const DAY_MS = 86_400_000;
/** Enough bars for a 30-day range's 31 UTC dates to keep one bar each. */
const CHART_BARS = 31;

/** `actionable` is supplied by newer Audit responses; old servers omit it. */
type AuditData = Omit<AuditView, "longRunners"> & {
  longRunners: (AuditView["longRunners"][number] & { actionable?: boolean })[];
};

/** Operator audit: one screen answering what should change next, who decides, and what earlier changes did. */
export function Audit() {
  return (
    <section id="page-audit">
      <h1 className="sr-only">Audit</h1>
      <AuditDashboard />
    </section>
  );
}

function AuditDashboard() {
  const [range, setRange] = useState<AuditRange>("30d");
  const [models, setModels] = useState(false);
  const res = useResource<AuditData>(RESOURCES.audit(range));
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const wasteRes = useResource<WasteReport>(RESOURCES.waste);
  const reportRes = useResource<AuditReportView>(RESOURCES.auditReport);
  const report = reportRes.data?.report ?? null;
  const reportLoaded = reportRes.data !== undefined || reportRes.error !== null;
  const [last, setLast] = useState<{ range: AuditRange; data: AuditData }>();
  useEffect(() => {
    if (res.data) setLast({ range, data: res.data });
  }, [range, res.data]);
  const audit = res.data ?? last?.data;
  const loading = res.loading && audit === undefined;
  const staleRange = res.data === undefined && last?.range !== undefined && last.range !== range;
  const config = configRes.data;

  // Seats the page does not hold to account: observed loops and FLIGHT's watch seat.
  const excluded = useMemo(
    () =>
      new Set([
        ...(config?.loops.map((loop) => loop.id) ?? []),
        ...(config?.crew?.sessions.flatMap((session) =>
          session.seats.filter((seat) => seat.loop === "watch").map((seat) => seat.id),
        ) ?? []),
      ]),
    [config],
  );
  const actions = useMemo(
    () => (audit && config ? auditActions(audit, wasteRes.data?.alarms ?? [], excluded) : []),
    [audit, config, wasteRes.data, excluded],
  );
  // A missing waste read is not "no alarms": the list and verdict say they may be incomplete.
  const waste: WasteState = wasteRes.data
    ? { kind: "ok" }
    : wasteRes.error
      ? { kind: "error", message: wasteRes.error.message }
      : { kind: "loading" };

  return (
    <div className={res.data === undefined && audit ? "audit-page refetching" : "audit-page"}>
      <div className="audit-verdict">
        {report ? (
          <ReportVerdict report={report} nextDueAt={reportRes.data?.nextDueAt ?? null} />
        ) : (
          <Verdict
            audit={audit}
            actions={actions}
            classified={config !== undefined}
            loading={loading}
            error={res.error && !res.data ? res.error : null}
            configError={configRes.error}
            stale={staleRange ? last?.range : undefined}
            range={range}
            waste={waste}
          />
        )}
        <button
          type="button"
          className="audit-retry"
          aria-expanded={models}
          onClick={() => setModels(!models)}
        >
          {models ? "Back to Do next" : "Rework and cost by model"}
        </button>
        <Seg label="Range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
      </div>
      {(audit || report) && !models && (
        <div className="audit-cols">
          <div className="audit-col">
            {report ? (
              <ReportNext report={report} />
            ) : audit ? (
              <>
                {reportLoaded && <p className="s fg2 audit-foot">{MC_AUDIT_NO_REPORT}</p>}
                <DoNext
                  actions={actions}
                  classified={config !== undefined}
                  audit={audit}
                  waste={waste}
                />
              </>
            ) : null}
            <NewOutside />
          </div>
          <div className="audit-col">
            {audit ? (
              <>
                <HowWeBuild audit={audit} waste={wasteRes.data} wasteError={wasteRes.error} />
                <WhereFindingsLand audit={audit} />
                <Past changes={audit.changes} range={range} />
              </>
            ) : (
              <LegacyAuditUnavailable error={res.error} range={range} />
            )}
          </div>
        </div>
      )}
      {models && (
        <div className="audit-models">
          <ModelPanels range={range} />
        </div>
      )}
    </div>
  );
}

type WasteState = { kind: "ok" } | { kind: "loading" } | { kind: "error"; message: string };

function LegacyAuditUnavailable({ error, range }: { error: Error | null; range: AuditRange }) {
  return (
    <Panel title="Hub checks">
      <div className="pb">
        <p>{error ? `Could not load hub checks: ${error.message}.` : "Hub checks are loading."}</p>
        {error && (
          <button
            type="button"
            className="audit-retry"
            onClick={() => hub.refetch(RESOURCES.audit(range).path)}
          >
            Retry hub checks
          </button>
        )}
      </div>
    </Panel>
  );
}

const wasteNotice = (w: WasteState): string | null =>
  w.kind === "ok"
    ? null
    : w.kind === "loading"
      ? "Waste alarms are still loading, so this list may be incomplete."
      : `Could not load waste alarms: ${w.message}. This list may be incomplete.`;

function WasteRetry({ waste }: { waste: WasteState }) {
  if (waste.kind !== "error") return null;
  return (
    <button type="button" className="audit-retry" onClick={() => hub.refetch(RESOURCES.waste.path)}>
      Retry
    </button>
  );
}

function Verdict({
  audit,
  actions,
  classified,
  loading,
  error,
  configError,
  stale,
  range,
  waste,
}: {
  audit: AuditData | undefined;
  actions: AuditAction[];
  classified: boolean;
  loading: boolean;
  error: Error | null;
  configError: Error | null;
  stale: AuditRange | undefined;
  range: AuditRange;
  waste: WasteState;
}) {
  if (loading) return <p className="audit-verdict-text">Loading audit…</p>;
  if (error)
    return <p className="audit-verdict-text crit-t">Could not load audit: {error.message}</p>;
  if (!audit) return <p className="audit-verdict-text" />;
  if (!classified)
    return (
      <p className="audit-verdict-text">
        {configError
          ? `Could not load crew classification: ${configError.message}`
          : "Loading crew classification…"}
      </p>
    );
  const v = auditVerdict(actions);
  return (
    <p className="audit-verdict-text">
      {v.count === 0 && waste.kind === "ok" ? (
        <b>Nothing in the last {range} is past a limit.</b>
      ) : v.count === 0 ? (
        <b>No other change is called for in the last {range}.</b>
      ) : (
        <>
          <b>
            {plural(v.count, "change")} to make in the last {range}.
          </b>{" "}
          {v.you} wait{v.you === 1 ? "s" : ""} on you, {v.flight} on FLIGHT. First: {v.first}.
        </>
      )}
      {wasteNotice(waste) && (
        <span className="warn-t">
          {" "}
          {wasteNotice(waste)} <WasteRetry waste={waste} />
        </span>
      )}
      {stale && (
        <span className="warn-t">
          {" "}
          Showing {stale} data while {range} is unavailable.
        </span>
      )}
    </p>
  );
}

const whenLabel = (at: number, tz: string | null, locale: string): string =>
  tz === null
    ? "—"
    : new Intl.DateTimeFormat(locale, {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(at));

/** The AUDIT seat's verdict, and when it was written and when the next is due. */
function ReportVerdict({ report, nextDueAt }: { report: AuditReport; nextDueAt: number | null }) {
  const tz = useTz();
  const locale = useLocale();
  return (
    <p className="audit-verdict-text">
      <b>{report.verdict}</b>{" "}
      <span className="fg2">
        {auditNoteText(
          whenLabel(report.at, tz, locale),
          nextDueAt === null ? "the next timer tick" : whenLabel(nextDueAt, tz, locale),
        )}
      </span>
    </p>
  );
}

/** Do next from the AUDIT report: findings ranked, with who acts; the detail carries the proof. */
function ReportNext({ report }: { report: AuditReport }) {
  const [filter, setFilter] = useState<DeciderFilter>("all");
  // Collapsed on first open, so the first five ranked rows stay on screen whatever a finding's length.
  const [open, setOpen] = useState<number | null>(null);
  const ranked = [...report.findings].sort((a, b) => a.rank - b.rank);
  const shown = ranked.filter(
    (f) => filter === "all" || (filter === "you" ? f.owner === "operator" : f.owner === "flight"),
  );
  return (
    <Panel
      title="Do next"
      sub={`${plural(report.findings.length, "finding")} · ranked by AUDIT`}
      className="audit-next"
      actions={<Seg label="Decider" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />}
    >
      <div className="audit-scroll">
        {shown.length === 0 ? (
          <p className="s fg2 audit-empty">No finding for this decider.</p>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th className="n">#</th>
                <th>Problem</th>
                <th className="src">Area</th>
                <th className="dec">Decides</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const isOpen = f.rank === open;
                const you = f.owner === "operator";
                return (
                  <Fragment key={f.rank}>
                    <tr className={isOpen ? "rec open" : "rec"}>
                      <td className="n">{f.rank}</td>
                      <td>
                        <button
                          type="button"
                          className="audit-rt"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : f.rank)}
                        >
                          <i aria-hidden="true">{isOpen ? "▾" : "▸"}</i>
                          {f.problem}
                        </button>
                      </td>
                      <td className="src">{f.area}</td>
                      <td className="dec">
                        <b className={you ? "you" : undefined}>{you ? "You" : "FLIGHT"}</b>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="more">
                        <td colSpan={4}>
                          <div className="audit-mg">
                            <div>
                              <h3>Problem</h3>
                              <p>{f.problem}</p>
                            </div>
                            <div>
                              <h3>Evidence</h3>
                              <p>{f.evidence}</p>
                            </div>
                            <div>
                              <h3>Likely cause</h3>
                              <p>{f.cause}</p>
                            </div>
                            <div>
                              <h3>Look at</h3>
                              <p className="audit-links">
                                {f.links.length === 0
                                  ? "No link."
                                  : f.links.map((l) => (
                                      <a key={l.href} href={l.href}>
                                        {l.label}
                                      </a>
                                    ))}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function rowLinks(a: AuditAction) {
  return a.links.map((l) => (
    <a
      key={`${l.agentId}:${l.runId}:${l.label}`}
      href={l.runId ? tracePath(l.agentId, l.runId) : agentPath(l.agentId)}
    >
      {l.label}
    </a>
  ));
}

function DoNext({
  actions,
  classified,
  audit,
  waste,
}: {
  actions: AuditAction[];
  classified: boolean;
  audit: AuditData;
  waste: WasteState;
}) {
  const [filter, setFilter] = useState<DeciderFilter>("all");
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const shown = actions.filter((a) => filter === "all" || a.decider.toLowerCase() === filter);
  // The first row is open until the reader opens or closes one.
  const openId = open === undefined ? shown[0]?.id : open;
  return (
    <Panel
      title="Do next"
      sub={
        classified
          ? `${plural(actions.length, "row")} · ranked: spend alarms, stuck runs, review, guards, merges, messages`
          : undefined
      }
      className="audit-next"
      actions={<Seg label="Decider" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />}
    >
      <div className="audit-scroll">
        {waste.kind === "error" && shown.length > 0 && (
          <p className="s warn-t audit-foot">
            {wasteNotice(waste)} <WasteRetry waste={waste} />
          </p>
        )}
        {shown.length === 0 ? (
          <p className="s fg2 audit-empty">
            {!classified
              ? "Waiting for the crew list."
              : actions.length === 0
                ? waste.kind === "ok"
                  ? "No change is called for in this range."
                  : "No other change is called for. Waste alarms are not loaded, so there may be more."
                : "No row for this decider."}
          </p>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th className="n">#</th>
                <th>Change</th>
                <th className="src">Source</th>
                <th className="meas">Measure now → target</th>
                <th className="dec">Decides</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => {
                const isOpen = a.id === openId;
                return (
                  <Fragment key={a.id}>
                    <tr className={isOpen ? "rec open" : "rec"}>
                      <td className="n">{a.rank}</td>
                      <td>
                        <button
                          type="button"
                          className="audit-rt"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : a.id)}
                        >
                          <i aria-hidden="true">{isOpen ? "▾" : "▸"}</i>
                          {a.title}
                        </button>
                        <div className="audit-why">{a.why}</div>
                      </td>
                      <td className="src">{a.source}</td>
                      <td className="meas">
                        <span className="l">{a.measure.label}</span>
                        <span className="v">
                          {a.measure.atLeast ? "≥" : ""}
                          {a.measure.now} → {a.measure.target} {a.measure.unit}
                        </span>
                      </td>
                      <td className="dec">
                        <b className={a.decider === "You" ? "you" : undefined}>{a.decider}</b>
                        <span title={a.deciderNote}>{a.deciderNote}</span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="more">
                        <td colSpan={5}>
                          <div className="audit-mg">
                            <div>
                              <h3>Evidence</h3>
                              {a.evidence.length === 0 ? (
                                <p>{a.why}</p>
                              ) : (
                                a.evidence.map((line) => <p key={line}>{line}</p>)
                              )}
                            </div>
                            <div>
                              <h3>Target</h3>
                              <p>
                                {a.measure.target} {a.measure.unit}: {a.measure.targetSource}.
                              </p>
                              <p>
                                Decides: {a.decider}, {a.deciderNote}.
                              </p>
                              <p>
                                State: proposed. Nothing is stored for it, so it has no review date.
                              </p>
                            </div>
                            <div>
                              <h3>What this does not show</h3>
                              <p>{a.caveat}</p>
                            </div>
                            <div>
                              <h3>Look at</h3>
                              <p className="audit-links">
                                {a.links.length === 0 ? "No seat or run to open." : rowLinks(a)}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {audit.capped && (
          <p className="s fg2 audit-foot">
            Counts marked ≥ come from a list the hub cut to its first 50.
          </p>
        )}
        {shown.length > 0 && (
          <p className="s fg2 audit-foot audit-end">End of list: {plural(shown.length, "row")}.</p>
        )}
      </div>
    </Panel>
  );
}

function NewOutside() {
  return (
    <Panel
      title="New outside"
      sub="releases and advisories for what we run"
      className="audit-outside"
    >
      <p className="s fg2 audit-empty">
        Nothing is collected from outside sources yet, so there is no dated item or proposed change
        to show.
      </p>
    </Panel>
  );
}

/** The review-round cohorts of a merged PR, bottom to top of a bar. */
const COHORTS = [
  { key: "noReview", cls: "c-none", label: "No hub review" },
  { key: "round1", cls: "c-r1", label: "Round 1" },
  { key: "round2", cls: "c-r2", label: "Round 2" },
  { key: "round3", cls: "c-r3", label: "Round 3+" },
] as const;

const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** Merged PRs per bucket across the range, oldest first, from the hub's uncut per-day counts. */
function mergedBuckets(audit: AuditData): {
  buckets: {
    start: number;
    merged: number;
    noReview: number;
    round1: number;
    round2: number;
    round3: number;
  }[];
  days: number;
} {
  // Whole UTC dates from the one the range starts on to the one it ends on: a range that starts
  // mid-day has partial first and last dates, and each keeps its own bar.
  const first = dayStart(audit.range.since);
  const days = Math.max(1, Math.round((dayStart(audit.range.until) - first) / DAY_MS) + 1);
  const size = Math.ceil(days / CHART_BARS);
  const bars = Math.ceil(days / size);
  const buckets = Array.from({ length: bars }, (_, i) => ({
    start: first + i * size * DAY_MS,
    merged: 0,
    noReview: 0,
    round1: 0,
    round2: 0,
    round3: 0,
  }));
  for (const d of audit.mergedPerDay ?? []) {
    const bar =
      buckets[Math.max(0, Math.min(bars - 1, Math.floor((d.day - first) / (size * DAY_MS))))];
    if (!bar) continue;
    bar.merged += d.merged;
    bar.noReview += d.noReview;
    bar.round1 += d.round1;
    bar.round2 += d.round2;
    bar.round3 += d.round3;
  }
  return { buckets, days: size };
}

const axisDate = (ms: number, locale: string): string =>
  new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function HowWeBuild({
  audit,
  waste,
  wasteError,
}: {
  audit: AuditData;
  waste: WasteReport | undefined;
  wasteError: Error | null;
}) {
  const locale = useLocale();
  const { buckets, days: bucketDays } = mergedBuckets(audit);
  const max = Math.max(1, ...buckets.map((b) => b.merged));
  const served = audit.mergedPerDay !== undefined;
  const totals = buckets.reduce(
    (t, b) => ({
      noReview: t.noReview + b.noReview,
      round1: t.round1 + b.round1,
      round2: t.round2 + b.round2,
      round3: t.round3 + b.round3,
    }),
    { noReview: 0, round1: 0, round2: 0, round3: 0 },
  );
  const merged = (audit.mergedPerDay ?? []).reduce((n, d) => n + d.merged, 0);
  const rounds = audit.reviewRounds?.prs ?? [];
  const reviewed = rounds.reduce((n, r) => n + r.count, 0);
  const past1 = rounds.filter((r) => r.rounds >= 2).reduce((n, r) => n + r.count, 0);
  const refusals = audit.refusalsByRule.reduce((n, r) => n + r.count, 0);
  const unanswered = (audit.questions?.asked ?? 0) - (audit.questions?.answered ?? 0);
  const costs = audit.costPerMergedTicket.flatMap((c) => (c.costUsd === null ? [] : [c.costUsd]));
  const day = waste?.spend.find((s) => s.window === "day");
  const week = waste?.spend.find((s) => s.window === "week");
  const wasteNote = wasteError ? "not loaded" : "loading";
  const rows: { label: string; value: string; sub: string }[] = [
    {
      label: "Merged PRs",
      value: served ? String(merged) : "–",
      sub: served ? "all merges in range" : "not served by this hub",
    },
    {
      label: "Reviewed PRs past round 1",
      value: reviewed === 0 ? "–" : percent((past1 / reviewed) * 100),
      sub: reviewed === 0 ? "no reviewed PR" : `${past1} of ${reviewed}`,
    },
    {
      label: "Unanswered questions",
      value: String(unanswered),
      sub: `of ${audit.questions?.asked ?? 0} asked`,
    },
    {
      label: "Wait for an answer",
      value: elapsed(audit.questions?.answerMs),
      sub: "mean, answered",
    },
    { label: "Guard refusals", value: String(refusals), sub: "in range" },
    {
      label: "Median cost per merged ticket",
      value: cost(median(costs)),
      sub: costs.length === 0 ? "no cost recorded" : `${costs.length} tickets with a cost`,
    },
    {
      label: "Spend per merged change",
      value: waste ? `${cost(day?.perMergeUsd)} day · ${cost(week?.perMergeUsd)} week` : "–",
      sub: waste ? "runs that recorded a cost" : wasteNote,
    },
    {
      label: "Share spent on building",
      value: waste
        ? `${percent(day?.buildingShareUsd == null ? null : day.buildingShareUsd * 100)} day · ${percent(week?.buildingShareUsd == null ? null : week.buildingShareUsd * 100)} week`
        : "–",
      sub: waste ? "developer runs, of recorded cost" : wasteNote,
    },
  ];
  const w = 100;
  const h = 40;
  const bw = w / buckets.length;
  return (
    <Panel
      title="How we build"
      sub={
        served
          ? `merged PRs, first and last dates partial, one bar per ${bucketDays === 1 ? "day" : `${bucketDays} days`} · ${merged} in ${audit.range.until - audit.range.since >= DAY_MS ? Math.round((audit.range.until - audit.range.since) / DAY_MS) : 1} days, all counted`
          : "merged PRs per day are not served by this hub"
      }
      className="audit-health"
    >
      <div className="audit-plot">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Merged PRs, one bar per ${bucketDays === 1 ? "day" : `${bucketDays} days`}, ${merged} in all, most ${max} in one bar. By highest review round: ${totals.noReview} with no hub review, ${totals.round1} round 1, ${totals.round2} round 2, ${totals.round3} round 3 or later`}
        >
          {buckets.map((b, i) => {
            let top = h;
            return COHORTS.map(({ key, cls }) => {
              const bh = (b[key] / max) * h;
              top -= bh;
              return bh === 0 ? null : (
                <rect
                  key={`${b.start}:${key}`}
                  className={cls}
                  x={i * bw + bw * 0.1}
                  y={top}
                  width={bw * 0.8}
                  height={bh}
                />
              );
            });
          })}
        </svg>
        <div className="audit-axis">
          <span>{axisDate(buckets[0]?.start ?? 0, locale)}</span>
          <span>most {served ? max : "–"} in a bar</span>
          <span>{axisDate(buckets[buckets.length - 1]?.start ?? 0, locale)}</span>
        </div>
      </div>
      <ul className="audit-legend" aria-label="Review rounds, highest reported per merged PR">
        {COHORTS.map(({ key, cls, label }) => (
          <li key={key} className={cls}>
            <i aria-hidden="true" />
            {label} {totals[key]}
          </li>
        ))}
      </ul>
      <div className="audit-scroll audit-hscroll">
        <table className="audit-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="hrow">
                <td className="lab">{r.label}</td>
                <td className="num">{r.value}</td>
                <td className="sub">{r.sub}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function WhereFindingsLand({ audit }: { audit: AuditData }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const files = audit.findingFiles ?? [];
  // Most findings per touch first; a file with no recorded touch has no ratio and sorts after.
  const ranked = [...files].sort((a, b) => {
    const ra = a.touches > 0 ? a.findings / a.touches : -1;
    const rb = b.touches > 0 ? b.findings / b.touches : -1;
    return rb - ra || b.findings - a.findings || a.file.localeCompare(b.file);
  });
  return (
    <Panel
      title="Where findings land"
      sub="files with blocking findings, by findings per touch; generated files left out"
      className="audit-files"
    >
      <div className="audit-scroll audit-fscroll">
        {ranked.length === 0 ? (
          <p className="s fg2 audit-empty">No blocking findings on files in this range.</p>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>File</th>
                <th className="num n3">Findings</th>
                <th className="num n3">Touches</th>
                <th className="num n3">Per touch</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => {
                const isOpen = openFile === r.file;
                return (
                  <Fragment key={r.file}>
                    <tr className="hrow">
                      <td className="lab">
                        <button
                          type="button"
                          className="audit-path"
                          title={r.file}
                          aria-expanded={isOpen}
                          onClick={() => setOpenFile(isOpen ? null : r.file)}
                        >
                          {r.file}
                        </button>
                      </td>
                      <td className="num">{r.findings}</td>
                      <td className="num">{r.touches === 0 ? "–" : r.touches}</td>
                      <td className="num">
                        {r.touches === 0 ? "–" : (r.findings / r.touches).toFixed(2)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="audit-file-detail">
                        <td colSpan={4}>
                          <code className="audit-file-fullpath">{r.file}</code>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="audit-sub">
        Touches are merged PRs in range whose stored diff names the file; a dash means none is
        stored, so the ratio is undefined.
      </p>
    </Panel>
  );
}

const CHANGE_WINDOW_MS = 7 * DAY_MS;

/** A comparison window in words; shorter than a week means the range edge cut it. */
function windowText(ms: number): string {
  const hours = Math.max(1, Math.round(ms / (DAY_MS / 24)));
  const span = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
  return ms < CHANGE_WINDOW_MS
    ? `${span} each side, partial: the range ends there`
    : `${span} each side`;
}

function Past({ changes, range }: { changes: AuditChange[]; range: AuditRange }) {
  const tz = useTz();
  const locale = useLocale();
  const pct = (r: number | null) => percent(r == null ? null : r * 100);
  return (
    <Panel
      title="What past recommendations achieved"
      sub="proposals and their outcomes are not collected"
      className="audit-past"
    >
      <div className="audit-scroll audit-fscroll">
        <p className="s fg2 audit-empty">
          No proposal is stored, so no recommendation has a result to show.
        </p>
        {changes.length > 0 && (
          <>
            <h3 className="audit-sub">
              Prompt and model changes in the last {range}: the window before and after each is on
              its row, up to a week, and shorter where the range edge cuts it. These are not
              recommendation results and do not show what caused a change.
            </h3>
            <table className="audit-table">
              <tbody>
                {changes.map((x) => (
                  <tr key={`${x.agentId}:${x.at}:${x.kind}`} className="hrow audit-change">
                    <td className="lab">
                      <b>
                        {tz === null
                          ? "—"
                          : new Date(x.at).toLocaleDateString(locale, { timeZone: tz })}
                      </b>{" "}
                      {" · "}
                      {x.kind === "prompt" ? "Prompt" : "Model"} change · {x.from ?? "none"} →{" "}
                      {x.to} · {x.agentId}
                    </td>
                    <td className="sub">
                      <span className="audit-window">{windowText(x.windowMs)}</span> · merged{" "}
                      {x.before.merged} → {x.after.merged} · review fail{" "}
                      {pct(x.before.reviewFailRate)} → {pct(x.after.reviewFailRate)} · median cost{" "}
                      {cost(x.before.medianCostPerMergedTicket)} →{" "}
                      {cost(x.after.medianCostPerMergedTicket)} · rework {x.before.reworkRounds} →{" "}
                      {x.after.reworkRounds}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Panel>
  );
}
