import {
  type AuditAction,
  type AuditChange,
  type AuditView,
  auditActions,
  auditVerdict,
  type ConfigView,
  type WasteReport,
} from "@mc/core";
import { Fragment, useEffect, useMemo, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { cost, elapsed, percent, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";
import { agentPath, tracePath } from "../router.ts";
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
const CHART_BARS = 30;

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
  const res = useResource<AuditData>(RESOURCES.audit(range));
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const wasteRes = useResource<WasteReport>(RESOURCES.waste);
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

  return (
    <div className={res.data === undefined && audit ? "audit-page refetching" : "audit-page"}>
      <div className="audit-verdict">
        <Verdict
          audit={audit}
          actions={actions}
          classified={config !== undefined}
          loading={loading}
          error={res.error && !res.data ? res.error : null}
          configError={configRes.error}
          stale={staleRange ? last?.range : undefined}
          range={range}
        />
        <Seg label="Range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
      </div>
      {audit && (
        <div className="audit-cols">
          <div className="audit-col">
            <DoNext actions={actions} classified={config !== undefined} audit={audit} />
            <NewOutside />
          </div>
          <div className="audit-col">
            <HowWeBuild audit={audit} waste={wasteRes.data} wasteError={wasteRes.error} />
            <WhereFindingsLand audit={audit} />
            <Past changes={audit.changes} />
          </div>
        </div>
      )}
    </div>
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
}: {
  audit: AuditData | undefined;
  actions: AuditAction[];
  classified: boolean;
  loading: boolean;
  error: Error | null;
  configError: Error | null;
  stale: AuditRange | undefined;
  range: AuditRange;
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
      {v.count === 0 ? (
        <b>Nothing in the last {range} is past a limit.</b>
      ) : (
        <>
          <b>
            {plural(v.count, "change")} to make in the last {range}.
          </b>{" "}
          {v.you} wait{v.you === 1 ? "s" : ""} on you, {v.flight} on FLIGHT. First: {v.first}.
        </>
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
}: {
  actions: AuditAction[];
  classified: boolean;
  audit: AuditData;
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
        {shown.length === 0 ? (
          <p className="s fg2 audit-empty">
            {!classified
              ? "Waiting for the crew list."
              : actions.length === 0
                ? "No change is called for in this range."
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
                          title={a.title}
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
                        <span>{a.deciderNote}</span>
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

const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** Merged PRs per bucket across the range, oldest first; the hub keeps the newest 50. */
function mergedBuckets(audit: AuditData): { start: number; merged: number }[] {
  const days = Math.max(1, Math.ceil((audit.range.until - audit.range.since) / DAY_MS));
  const size = Math.ceil(days / CHART_BARS);
  const end = dayStart(audit.range.until);
  const bars = Math.ceil(days / size);
  const out = Array.from({ length: bars }, (_, i) => ({
    start: end - (bars - 1 - i) * size * DAY_MS,
    merged: 0,
  }));
  const first = out[0]?.start ?? 0;
  for (const pr of audit.prSizes.prs) {
    if (pr.mergedAt < first) continue;
    const bar = out[Math.min(bars - 1, Math.floor((pr.mergedAt - first) / (size * DAY_MS)))];
    if (bar) bar.merged += 1;
  }
  return out;
}

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
  const buckets = mergedBuckets(audit);
  const max = Math.max(1, ...buckets.map((b) => b.merged));
  const merged = audit.prSizes.prs.length;
  const cut = audit.capped?.["prSizes.prs"];
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
    { label: "Merged PRs", value: String(merged), sub: cut ? `newest of ${cut}` : "in range" },
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
    <Panel title="How we build" sub="merged PRs per day" className="audit-health">
      <div className="audit-plot">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Merged PRs per ${buckets.length > 1 && audit.range.until - audit.range.since > CHART_BARS * DAY_MS ? "bucket" : "day"}, most ${max}`}
        >
          {buckets.map((b, i) => (
            <rect
              key={b.start}
              x={i * bw + bw * 0.1}
              y={h - (b.merged / max) * h}
              width={bw * 0.8}
              height={(b.merged / max) * h}
            />
          ))}
        </svg>
      </div>
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
  const late = audit.reviewRounds?.late ?? [];
  return (
    <Panel
      title="Where findings land"
      sub="blocking findings by reviewer; findings per file are not collected"
      className="audit-files"
    >
      <div className="audit-scroll audit-fscroll">
        {late.length === 0 ? (
          <p className="s fg2 audit-empty">No reviewed findings in this range.</p>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Model</th>
                <th className="num">Findings</th>
                <th className="num">Late</th>
              </tr>
            </thead>
            <tbody>
              {late.map((r) => (
                <tr key={`${r.seatId}:${r.model}`} className="hrow">
                  <td className="lab">
                    <a href={agentPath(r.seatId)}>{r.seatId}</a>
                  </td>
                  <td className="lab">{r.model ?? "–"}</td>
                  <td className="num">{r.findings}</td>
                  <td className="num">{r.late}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function Past({ changes }: { changes: AuditChange[] }) {
  const pct = (r: number | null) => percent(r == null ? null : r * 100);
  return (
    <Panel
      title="What past recommendations achieved"
      sub="prompt and model changes, the week before and after"
      className="audit-past"
    >
      <div className="audit-scroll audit-fscroll">
        {changes.length === 0 ? (
          <p className="s fg2 audit-empty">
            No prompt or model change in this range. Proposals are not stored, so no decided
            recommendation has a result to show.
          </p>
        ) : (
          <table className="audit-table">
            <tbody>
              {changes.map((x) => (
                <tr key={`${x.agentId}:${x.at}:${x.kind}`} className="hrow audit-change">
                  <td className="lab">
                    <b>{new Date(x.at).toLocaleDateString("en-GB")}</b> ·{" "}
                    {x.kind === "prompt" ? "Prompt" : "Model"} change · {x.from ?? "none"} → {x.to}{" "}
                    · {x.agentId}
                  </td>
                  <td className="sub">
                    merged {x.before.merged} → {x.after.merged} · review fail{" "}
                    {pct(x.before.reviewFailRate)} → {pct(x.after.reviewFailRate)} · median cost{" "}
                    {cost(x.before.medianCostPerMergedTicket)} →{" "}
                    {cost(x.after.medianCostPerMergedTicket)} · rework {x.before.reworkRounds} →{" "}
                    {x.after.reworkRounds}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
