import type {
  CodeHealthFigure,
  CodeHealthOverview,
  CodeHealthPastItem,
  CodeHealthRecommendation,
  CodeHealthWasteAlarmRow,
} from "@mc/core";
import { type ReactNode, useState } from "react";
import { percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";
import type { Action } from "./dialogs.tsx";
import { day, label } from "./format.ts";
import "./audit-summary.css";

type Who = "all" | "you" | "flight";
const WHO_LABEL: Record<Who, string> = { all: "All", you: "You", flight: "FLIGHT" };
const OUTCOME_LABEL: Record<CodeHealthPastItem["outcome"], string> = {
  worked: "Paid off",
  "no-effect": "No effect",
  worse: "Worse",
  unchanged: "Unchanged",
  unmeasured: "Not measured",
  waiting: "Waiting",
};
const OUTCOME_SHAPE: Record<CodeHealthPastItem["outcome"], string> = {
  worked: "as-lamp as-l-ok",
  "no-effect": "as-lamp as-l-warn",
  worse: "as-lamp as-l-warn",
  unchanged: "as-lamp as-l-warn",
  unmeasured: "as-lamp as-l-off",
  waiting: "as-lamp as-l-off",
};
const FIGURE_STATE: Record<CodeHealthFigure["state"], string> = {
  available: "",
  partial: "partial",
  unknown: "unknown",
  "not-collected": "not collected",
  "not-available": "not available",
};
const STEPS = ["Proposed", "Accepted", "Work linked", "Measured"] as const;

export const num = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "—"
    : Number.isInteger(value)
      ? value.toLocaleString("en-GB")
      : value.toLocaleString("en-GB", { maximumFractionDigits: 1 });

/** Where a row's state sits on the path from proposal to measured result; -1 when it left the path. */
export function stepOf(row: CodeHealthRecommendation): number {
  switch (row.state.kind) {
    case "proposed":
      return 0;
    case "accepted":
      return row.state.linkedWork ? 2 : 1;
    case "paid-off":
    case "no-effect":
      return 3;
    default:
      return -1;
  }
}

function stateText(row: CodeHealthRecommendation): { word: string; date: string } {
  const s = row.state;
  switch (s.kind) {
    case "proposed":
      return { word: "Proposed", date: "Review date unset" };
    case "accepted":
      return { word: "Accepted", date: `Review ${day(s.reviewAt)}` };
    case "snoozed":
      return { word: "Snoozed", date: `Until ${day(s.until)}` };
    case "dismissed":
      return { word: "Dismissed", date: "No review date" };
    default:
      return { word: label(s.kind), date: `Assessed ${day(s.assessedAt)}` };
  }
}

function who(row: CodeHealthRecommendation): { tier: Who; head: string; sub: string } {
  if (!row.decision) return { tier: "all", head: "Unknown", sub: "decider not recorded" };
  return row.decision.tier === "operator"
    ? { tier: "you", head: "You", sub: row.decision.owner }
    : { tier: "flight", head: "FLIGHT", sub: row.decision.owner };
}

function Measure({ row }: { row: CodeHealthRecommendation }) {
  const now = row.measure ? row.measure.current : null,
    target = row.target.value ?? null;
  return (
    <div className="as-meas">
      <span className="as-l">{row.target.metric}</span>
      <span className="as-v">
        <span>{now === null ? "unknown" : num(now)}</span>
        <span aria-hidden="true">→</span>
        <span>{target === null ? "target not set" : num(target)}</span>
        <span className="as-unit">{row.measure?.unit}</span>
      </span>
    </div>
  );
}

function Detail({
  row,
  cols,
  onInspect,
}: {
  row: CodeHealthRecommendation;
  cols: number;
  onInspect: (row: CodeHealthRecommendation) => void;
}) {
  const step = stepOf(row);
  return (
    <tr className="as-more">
      <td colSpan={cols}>
        <div className="as-mg">
          <div>
            <h3>Why believe it</h3>
            <p>{row.observation}</p>
            <button type="button" className="as-btn" onClick={() => onInspect(row)}>
              Inspect evidence
            </button>
          </div>
          <div>
            <h3>What could be wrong</h3>
            <p>{row.uncertainty}</p>
          </div>
          <div>
            <h3>Ranked and measured</h3>
            <p>{row.rankingReason}</p>
            <p>
              {row.target.direction === "increase" ? "Raise" : "Lower"} {row.target.metric}
              {row.target.baseline === null
                ? "; no accepted baseline yet."
                : `; accepted baseline ${num(row.target.baseline)}.`}
            </p>
            {row.measure && <p>{row.measure.coverage}</p>}
          </div>
          <div>
            <h3>State path</h3>
            <ol className="as-steps">
              {STEPS.map((name, i) => (
                <li key={name} aria-current={i === step ? "step" : undefined}>
                  {name}
                </li>
              ))}
            </ol>
            <p>
              {step === -1
                ? `Set aside: ${label(row.state.kind)}.`
                : row.decision?.tier === "operator"
                  ? "You approve this one."
                  : "FLIGHT approves this one."}
            </p>
          </div>
        </div>
      </td>
    </tr>
  );
}

function RecRow({
  row,
  n,
  open,
  blocked,
  onToggle,
  onDecide,
  onHistory,
}: {
  row: CodeHealthRecommendation;
  n: number;
  open: boolean;
  blocked: boolean;
  onToggle: () => void;
  onDecide: (row: CodeHealthRecommendation, kind: Action) => void;
  onHistory: () => void;
}) {
  const title = row.title ?? row.proposal,
    decides = who(row),
    state = stateText(row);
  return (
    <tr className={open ? "as-rec as-open" : "as-rec"} data-who={decides.tier}>
      <td className="as-n">{n}</td>
      <td>
        <button
          type="button"
          id={`as-t-${row.id}`}
          className="as-rt"
          aria-expanded={open}
          onClick={onToggle}
        >
          <i aria-hidden="true">{open ? "▾" : "▸"}</i>
          {title}
        </button>
        <div className="as-why">
          <span className="as-src">{label(row.rule)}</span> · {row.observation}
        </div>
      </td>
      <td>
        <Measure row={row} />
      </td>
      <td className="as-dec">
        <div>
          <b className={decides.tier === "you" ? "as-you" : undefined}>{decides.head}</b>{" "}
          <span>{decides.sub}</span>
        </div>
        <div>
          <b>{state.word}</b> <span>{state.date}</span>
        </div>
      </td>
      <td>
        {row.state.kind === "proposed" ? (
          <div className="as-acts">
            {(["accept", "dismiss", "snooze"] as const).map((kind) => (
              <button
                type="button"
                key={kind}
                className={kind === "accept" ? "as-btn as-pri" : "as-btn"}
                disabled={blocked}
                aria-describedby={`as-t-${row.id}`}
                onClick={() => onDecide(row, kind)}
              >
                {kind[0].toUpperCase() + kind.slice(1)}
              </button>
            ))}
          </div>
        ) : (
          <div className="as-done">
            <span>Decision recorded</span>
            <button type="button" onClick={onHistory}>
              History
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function WasteRow({ row, n }: { row: CodeHealthWasteAlarmRow; n: number }) {
  return (
    <tr className="as-rec as-waste">
      <td className="as-n">{n}</td>
      <td>
        <div className="as-rt-static">{row.title}</div>
        <div className="as-why">
          <span className="as-src">Waste alarm</span> · {row.evidence}
        </div>
      </td>
      <td>
        <div className="as-meas">
          <span className="as-l">{row.threshold}</span>
          <span className="as-v">
            {num(row.measure.value)} <span className="as-unit">{row.measure.unit}</span>
          </span>
        </div>
      </td>
      <td className="as-dec">
        <div>
          <b>{row.owner}</b> <span>{row.scope.ticket ?? row.scope.repoId ?? "alarm"}</span>
        </div>
        <div>
          <b>Open</b> <span>since {day(row.openedAt)}</span>
        </div>
      </td>
      <td>
        <div className="as-done">
          <span>Not decided here</span>
        </div>
      </td>
    </tr>
  );
}

function change(f: CodeHealthFigure): string {
  const before = f.comparison?.value ?? null;
  if (f.value === null || before === null) return "no comparison";
  const d = f.value - before;
  if (d === 0) return "no change";
  const pts = f.unit.startsWith("%") ? " pts" : "";
  return `${d > 0 ? "▲ up" : "▼ down"} ${num(Math.abs(d))}${pts}`;
}

const figureValue = (f: CodeHealthFigure | undefined): string =>
  !f || f.value === null
    ? "—"
    : f.unit.startsWith("%")
      ? percent(f.value, 1)
      : f.unit.startsWith("USD")
        ? `$${f.value.toFixed(2)}`
        : num(f.value);

function MergedChart({ days }: { days: CodeHealthOverview["build"]["mergedPerDay"] }) {
  const totals = days.map((d) => d.noHubReview + d.round1 + d.round2 + d.round3Plus),
    max = Math.max(1, ...totals),
    W = 560,
    H = 100,
    bw = days.length ? W / days.length : W;
  const y = (v: number) => H - (v / max) * H;
  return (
    <div className="as-plot">
      <svg
        role="img"
        aria-label={`Merged PRs per day over ${days.length} days, by highest review round. Most days: ${max} merged at most.`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
      >
        {days.map((d, i) => {
          const x = i * bw + 2,
            w = Math.max(1, bw - 4);
          let acc = 0;
          const seg = (v: number, cls: string) => {
            if (!v) return null;
            const top = y(acc + v),
              bar = (
                <rect
                  key={cls}
                  className={cls}
                  x={x}
                  y={top}
                  width={w}
                  height={y(acc) - top}
                  vectorEffect="non-scaling-stroke"
                />
              );
            acc += v;
            return bar;
          };
          return (
            <g key={d.day}>
              <title>
                {d.day}: {totals[i]} merged, {d.noHubReview} with no hub review
              </title>
              {seg(d.round1, "as-b1")}
              {seg(d.round2, "as-b2")}
              {seg(d.round3Plus, "as-b3")}
              {seg(d.noHubReview, "as-b0")}
            </g>
          );
        })}
      </svg>
      <div className="as-axis">
        <span>{days[0]?.day}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
    </div>
  );
}

/** A scrolling list the keyboard can reach and a screen reader can name. */
function ScrollRegion({
  className,
  label,
  children,
}: {
  className: string;
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls, so the keyboard must reach it
    <section className={className} tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}

/** The Audit first screen: one stored summary, shown. It reads nothing and decides nothing itself. */
export function AuditSummary({
  overview,
  blocked,
  onDecide,
  onInspect,
  onHistory,
}: {
  overview: CodeHealthOverview;
  blocked: boolean;
  onDecide: (row: CodeHealthRecommendation, kind: Action) => void;
  onInspect: (row: CodeHealthRecommendation) => void;
  onHistory: () => void;
}) {
  const [filter, setFilter] = useState<Who>("all"),
    [open, setOpen] = useState<string | null | undefined>(undefined);
  const rows = overview.rows,
    counts: Record<Who, number> = {
      all: rows.length,
      you: rows.filter((r) => r.decision?.tier === "operator").length,
      flight: rows.filter((r) => r.decision?.tier === "flight").length,
    };
  const shown = rows.filter((r) =>
    filter === "all" ? true : r.decision?.tier === (filter === "you" ? "operator" : "flight"),
  );
  const openId = open === undefined ? shown[0]?.id : open;
  const alarms = overview.wasteAlarms?.rows ?? [];
  const COLS = 5;
  const tone = overview.verdict.tone;
  const outside = overview.outside;
  return (
    <>
      <p className="as-verdict" data-tone={tone}>
        <span className="as-tone">
          {tone === "ok" ? "Healthy" : tone === "warn" ? "Needs attention" : "Unknown"}
        </span>
        <b>{overview.verdict.text}</b>
      </p>
      <div className="as-cols">
        <div className="as-col">
          <Panel
            className="as-do"
            title="Do next"
            sub={
              <>
                <b className="as-count">{rows.length}</b> ranked
                {alarms.length > 0 && <> · {alarms.length} waste alarms</>} · what blocks the
                evidence first, then measured size
              </>
            }
            actions={
              <>
                <Seg
                  label="Who decides"
                  value={filter}
                  onChange={(next) => {
                    setFilter(next);
                    setOpen(undefined);
                  }}
                  options={(Object.keys(WHO_LABEL) as Who[]).map((k) => ({
                    value: k,
                    label: `${WHO_LABEL[k]} ${counts[k]}`,
                  }))}
                />
                <button type="button" className="as-link" onClick={onHistory}>
                  Recommendation history
                </button>
              </>
            }
          >
            <ScrollRegion className="as-scroll as-grow" label="Recommendations">
              {shown.length === 0 && alarms.length === 0 ? (
                <p className="as-empty">
                  {rows.length === 0
                    ? "No open proposal meets the measured triage rules. Missing collection is named in coverage; this is not a healthy-repo verdict."
                    : `No ${WHO_LABEL[filter]} decisions in this list. ${rows.length} proposals are under All.`}
                </p>
              ) : (
                <table>
                  <colgroup>
                    <col className="as-c-n" />
                    <col />
                    <col className="as-c-meas" />
                    <col className="as-c-dec" />
                    <col className="as-c-act" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>What to change, and why</th>
                      <th>Measure · now → target</th>
                      <th>Decides · state</th>
                      <th className="as-r">Decide</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.flatMap((row, i) => {
                      const isOpen = row.id === openId;
                      return [
                        <RecRow
                          key={row.id}
                          row={row}
                          n={i + 1}
                          open={isOpen}
                          blocked={blocked}
                          onToggle={() => setOpen(isOpen ? null : row.id)}
                          onDecide={onDecide}
                          onHistory={onHistory}
                        />,
                        isOpen && (
                          <Detail
                            key={`${row.id}-more`}
                            row={row}
                            cols={COLS}
                            onInspect={onInspect}
                          />
                        ),
                      ];
                    })}
                    {filter === "all" &&
                      alarms.map((a, i) => <WasteRow key={a.id} row={a} n={rows.length + i + 1} />)}
                  </tbody>
                </table>
              )}
            </ScrollRegion>
            {!overview.wasteAlarms && (
              <p className="as-foot">Waste alarms: not yet supplied by this server.</p>
            )}
          </Panel>
          <Panel
            className="as-outside"
            title="New outside"
            sub={
              <>
                <b>{outside.items.length}</b> items ·{" "}
                {outside.state === "available" ? "collected" : "not collected yet"}
              </>
            }
          >
            {outside.state === "not-collected" && outside.items.length === 0 ? (
              <p className="as-empty">Not collected yet. {outside.note}</p>
            ) : (
              <ScrollRegion className="as-scroll as-out" label="External items">
                <table>
                  <colgroup>
                    <col className="as-c-so" />
                    <col />
                    <col className="as-c-date" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>What changed</th>
                      <th className="as-r">Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outside.items.map((o) => (
                      <tr key={`${o.source}-${o.recordedAt}`}>
                        <td className="as-so">{o.source}</td>
                        <td>{o.summary}</td>
                        <td className="as-r">{day(o.recordedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </Panel>
        </div>
        <div className="as-col">
          <Panel
            className="as-build"
            title="How we build"
            sub="Merged PRs a day, by highest review round"
            actions={
              <span className="as-lg">
                <span>
                  <i className="as-k0" />
                  no hub review
                </span>
                <span>
                  <i className="as-k1" />
                  round 1
                </span>
                <span>
                  <i className="as-k2" />
                  round 2
                </span>
                <span>
                  <i className="as-k3" />
                  round 3+
                </span>
              </span>
            }
          >
            <MergedChart days={overview.build.mergedPerDay} />
            <ScrollRegion className="as-scroll as-hscroll" label="Health measures">
              <table>
                <colgroup>
                  <col />
                  <col className="as-c-fig" />
                  <col className="as-c-fig" />
                  <col className="as-c-chg" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th className="as-r">Before</th>
                    <th className="as-r">Now</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.figures.map((f) => (
                    <tr key={f.id} className="as-hrow">
                      <td title={`${f.source}. ${f.coverage}`}>{f.label}</td>
                      <td className="as-r as-m">
                        {figureValue({ ...f, value: f.comparison?.value ?? null })}
                      </td>
                      <td className="as-r">{figureValue(f)}</td>
                      <td>
                        {f.state !== "available" && (
                          <span className="as-fstate">{FIGURE_STATE[f.state]} · </span>
                        )}
                        {change(f)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </Panel>
          <Panel
            className="as-files"
            title="Where findings land"
            sub={
              <>
                <b>{overview.landing.files.reduce((n, f) => n + f.findings, 0)}</b> findings in{" "}
                {overview.landing.files.length} files
              </>
            }
          >
            {overview.landing.files.length === 0 ? (
              <p className="as-empty">
                No review findings are recorded against a file in this window.
              </p>
            ) : (
              <ScrollRegion className="as-scroll as-grow" label="Files by findings">
                <table>
                  <colgroup>
                    <col />
                    <col className="as-c-fig" />
                    <col className="as-c-fig" />
                    <col className="as-c-fig" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th className="as-r">Findings</th>
                      <th className="as-r">Touches</th>
                      <th className="as-r">Per touch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.landing.files.map((f) => (
                      <tr key={f.path} className="as-frow">
                        <td className="as-path">{f.path}</td>
                        <td className="as-r">{f.findings}</td>
                        <td className="as-r">{f.touches}</td>
                        <td className="as-r">
                          {f.ratio.value === null ? "—" : num(Math.round(f.ratio.value * 10) / 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </Panel>
          <Panel
            className="as-past"
            title="What past recommendations achieved"
            sub={`${overview.past.measured.improved} paid off · ${overview.past.measured.unchanged} unchanged · ${overview.past.measured.worse} worse · ${overview.past.measured.unmeasured} not measured`}
          >
            <div className="as-fun">
              {overview.past.funnel.map((f) => (
                <div key={f.kind} className="as-cell">
                  <b className="as-fig">{f.count}</b>
                  <span className="as-cap">{label(f.kind)}</span>
                </div>
              ))}
            </div>
            {overview.past.items.length === 0 ? (
              <p className="as-empty">
                No proposal has been decided yet, so there is no result to show.
              </p>
            ) : (
              <ScrollRegion className="as-scroll as-pastrows" label="Past results">
                <table>
                  <colgroup>
                    <col className="as-c-date" />
                    <col />
                    <col className="as-c-chg" />
                    <col className="as-c-out" />
                  </colgroup>
                  <tbody>
                    {overview.past.items.map((p) => (
                      <tr key={p.id} className="as-prow">
                        <td className="as-m">{day(p.decidedAt)}</td>
                        <td>
                          {p.title}
                          <span className="as-sub"> · {p.metric}</span>
                        </td>
                        <td className="as-r">
                          {p.after
                            ? p.after.change
                            : p.baseline === null
                              ? "no baseline"
                              : `from ${num(p.baseline)}`}
                        </td>
                        <td>
                          <span className="as-vd">
                            <i className={OUTCOME_SHAPE[p.outcome]} aria-hidden="true" />
                            {OUTCOME_LABEL[p.outcome]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
