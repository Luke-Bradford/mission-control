import type {
  CodeHealthFigure,
  CodeHealthOverview,
  CodeHealthPastItem,
  CodeHealthRecommendation,
  CodeHealthWasteAlarmRow,
} from "@mc/core";
import { type ReactNode, type Ref, type RefObject, useLayoutEffect, useRef, useState } from "react";
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
/** Where a proposal comes from, named for the reader; unknown rules read as Repo. */
const FROM: Record<string, string> = {
  "recurring-correction": "Reviews",
  "repeated-rounds": "Reviews",
  collection: "Records",
  "risk-and-tests": "Tests",
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
      return {
        word: "Snoozed",
        date: s.until <= Date.now() ? `Snooze ended ${day(s.until)}` : `Until ${day(s.until)}`,
      };
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
    target = row.target.value ?? null,
    context = row.measure
      ? `${row.measure.unit} · over ${row.measure.window}`
      : "unit not recorded · no measure yet";
  return (
    <div className="as-meas">
      <span className="as-l" title={`${row.target.metric}: ${context}`}>
        {context}
      </span>
      <span className="as-v">
        <span
          className="as-dot"
          role="img"
          aria-label={now === null ? "Not measured yet" : "Measured now"}
        >
          {now === null ? "○" : "●"}
        </span>
        <span className={now === null ? "as-gap" : undefined}>
          {now === null ? "— unknown" : num(now)}
        </span>
        <span aria-hidden="true">→</span>
        <span className={target === null ? "as-gap" : undefined}>
          {target === null ? "no target" : num(target)}
        </span>
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
            {row.measure && (
              <p>
                {row.measure.unit}, over {row.measure.window}. {row.measure.coverage}
              </p>
            )}
          </div>
          <div>
            <h3>Path</h3>
            <ol className="as-steps">
              {STEPS.map((name, i) => (
                <li key={name} aria-current={i === step ? "step" : undefined}>
                  {name}
                </li>
              ))}
            </ol>
            <p>
              Decides: {who(row).head} {who(row).sub}. {stateText(row).word}, {stateText(row).date}.
            </p>
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
      <td className="as-from">{FROM[row.rule] ?? "Repo"}</td>
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
        {row.state.kind === "proposed" ||
        (row.state.kind === "snoozed" && row.state.until <= Date.now()) ? (
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
      <td className="as-from">Alarm</td>
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

/** The next 1, 2, 5 or 10 times a power of ten at or above v: a plain top for the count scale. */
function niceCeiling(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v)),
    f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A day as its number, with the month on the first label and on the first of a month. */
function dayLabel(iso: string, first: boolean): string {
  const [, m, d] = iso.split("-").map(Number);
  return first || d === 1 ? `${d} ${MONTHS[m - 1]}` : String(d);
}

function MergedChart({
  days,
  showDays,
}: {
  days: CodeHealthOverview["build"]["mergedPerDay"];
  showDays: boolean;
}) {
  const totals = days.map((d) => d.noHubReview + d.round1 + d.round2 + d.round3Plus),
    top = niceCeiling(Math.max(1, ...totals)),
    max = top,
    W = 560,
    H = 100,
    bw = days.length ? W / days.length : W,
    step = Math.max(1, Math.ceil(days.length / 14));
  const y = (v: number) => H - (v / max) * H;
  return (
    <>
      <div className="as-chart">
        <div className="as-yscale" aria-hidden="true">
          <span>{top}</span>
          <span>{top / 2}</span>
          <span>0</span>
        </div>
        <div className="as-plot">
          <svg
            role="img"
            aria-label={`Merged PRs per day over ${days.length} days, by highest review round. The scale runs to ${top}.`}
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
          <div
            className="as-axis"
            style={{ gridTemplateColumns: `repeat(${days.length || 1}, 1fr)` }}
            aria-hidden="true"
          >
            {days.map((d, i) => (
              <span key={d.day}>{i % step === 0 ? dayLabel(d.day, i === 0) : ""}</span>
            ))}
          </div>
        </div>
      </div>
      {showDays && (
        <ScrollRegion
          className="as-daylist"
          label={`Merged PRs per day, count by day, over ${days.length} days`}
        >
          <ul>
            {days.map((d, i) => (
              <li key={d.day}>
                {d.day.slice(5)} <b className="as-dn">{totals[i]}</b>
              </li>
            ))}
          </ul>
        </ScrollRegion>
      )}
    </>
  );
}

/** A dot for how much data a figure has: ● all, ◐ some, ○ none. Spoken, not only drawn. */
function StateDot({ state }: { state: CodeHealthFigure["state"] }) {
  const [mark, say] =
    state === "available"
      ? ["●", "Data available"]
      : state === "partial"
        ? ["◐", "Partial data"]
        : ["○", "No data yet"];
  return (
    <span className="as-dot" role="img" aria-label={say}>
      {mark}
    </span>
  );
}

/** One figure on one line; its button shows the unit, window, source and coverage in full. */
/** The short unit beside a label: only where neither the label nor the value already says it. */
function shortUnit(f: CodeHealthFigure): string {
  const carried = f.value !== null && (f.unit.startsWith("%") || f.unit.startsWith("USD"));
  // A long unit such as "USD, median of priced PRs" keeps its first part here; the rest is in 'how'.
  return carried || f.label.toLowerCase().includes(f.unit.toLowerCase())
    ? ""
    : f.unit.split(",")[0];
}

function FigureRow({ f, showWindow }: { f: CodeHealthFigure; showWindow: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <tr className="as-hrow">
      <td>
        <div className="as-fl">
          <span className="as-flab">{f.label}</span>
          <button
            type="button"
            className="as-defbtn"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} how ${f.label} is measured`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide" : "how"}
          </button>
          <span className="as-sub as-fmeta">
            {[shortUnit(f), showWindow ? f.window.label : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {open && (
          <span className="as-sub as-fdef">
            {f.unit} · {f.window.label}. {f.source}. {f.coverage}
          </span>
        )}
      </td>
      <td className="as-r as-m">{figureValue({ ...f, value: f.comparison?.value ?? null })}</td>
      <td className="as-r">{figureValue(f)}</td>
      <td className="as-chgcell" title={`${FIGURE_STATE[f.state]} ${change(f)}`.trim()}>
        {f.state !== "available" && f.value === null ? (
          <span className="as-fstate">{FIGURE_STATE[f.state]}</span>
        ) : (
          <>
            {f.state !== "available" && (
              <span className="as-fstate">{FIGURE_STATE[f.state]} · </span>
            )}
            {change(f)}
          </>
        )}
      </td>
      <td className="as-dotcell">
        <StateDot state={f.state} />
      </td>
    </tr>
  );
}

/** A file path on one line; Enter or Space shows all of it, wrapped, for keyboard and touch users. */
function FilePath({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="as-pathbtn"
      aria-expanded={open}
      aria-label={`${path}, ${open ? "full path shown" : "shortened if long; press to show all"}`}
      title={path}
      onClick={() => setOpen((v) => !v)}
    >
      {path}
    </button>
  );
}

/** A scrolling list the keyboard can reach and a screen reader can name. */
function ScrollRegion({
  className,
  label,
  children,
  innerRef,
}: {
  className: string;
  label: string;
  children: ReactNode;
  innerRef?: Ref<HTMLElement>;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls, so the keyboard must reach it
    <section ref={innerRef} className={className} tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}

/** The one-sentence verdict: a bold lead, then the rest in plain text. Its tone is spoken, not a badge. */
export function Verdict({ verdict }: { verdict: CodeHealthOverview["verdict"] }) {
  const cut = verdict.text.search(/\.\s/),
    lead = cut === -1 ? verdict.text : verdict.text.slice(0, cut + 1),
    rest = cut === -1 ? "" : verdict.text.slice(cut + 1).trim();
  return (
    <p className="as-verdict" data-tone={verdict.tone}>
      <span className="sr-only">
        {verdict.tone === "ok"
          ? "Steady. "
          : verdict.tone === "warn"
            ? "Needs attention. "
            : "Unknown. "}
      </span>
      <b>{lead}</b>
      {rest && ` ${rest}`}
    </p>
  );
}

/**
 * Ends a filling list on a whole row: the list is cut at the bottom of the last row that fits, so no row
 * is sliced through. Only while the list fills its panel and sits at the top; otherwise it is left alone.
 */
function useWholeRows(list: RefObject<HTMLElement | null>, rowSet: unknown) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSet names the rows the effect re-measures
  useLayoutEffect(() => {
    const el = list.current,
      panel = el?.closest<HTMLElement>(".panel");
    if (!el || !panel) return;
    const fit = () => {
      el.style.flex = "";
      el.style.height = "";
      if (getComputedStyle(panel).flexGrow === "0" || el.scrollTop > 0) return;
      const box = el.clientHeight,
        top = el.getBoundingClientRect().top;
      if (el.scrollHeight <= box + 1) return;
      let best = 0;
      for (const tr of el.querySelectorAll<HTMLElement>("tbody > tr")) {
        const bottom = tr.getBoundingClientRect().bottom - top;
        if (bottom <= box + 1 && bottom > best) best = bottom;
      }
      const head = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      if (best > head) {
        el.style.flex = "0 0 auto";
        el.style.height = `${Math.floor(best)}px`;
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(panel);
    watch.observe(el);
    const table = el.querySelector("table");
    if (table) watch.observe(table);
    document.fonts?.ready.then(fit);
    return () => watch.disconnect();
  }, [list, rowSet]);
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
    [open, setOpen] = useState<string | null | undefined>(undefined),
    [showDays, setShowDays] = useState(false),
    [showPast, setShowPast] = useState(false),
    doNextList = useRef<HTMLElement>(null);
  // When every figure covers one window (and one comparison window), the column heads say so once.
  const nows = new Set(overview.figures.map((f) => f.window.label)),
    befores = new Set(overview.figures.flatMap((f) => (f.comparison ? [f.comparison.label] : []))),
    sharedWindow =
      nows.size === 1 && befores.size <= 1
        ? { now: [...nows][0], before: [...befores][0] as string | undefined }
        : null;
  // The eight stages of a proposal's life; one the server does not record reads as a dash.
  const funnelCount = (...kinds: string[]) =>
      overview.past.funnel.filter((f) => kinds.includes(f.kind)).reduce((n, f) => n + f.count, 0),
    measured = overview.past.measured,
    paidOff = funnelCount("paid-off"),
    stages: { name: string; count: number | null }[] = [
      { name: "Proposed", count: funnelCount("proposed") },
      { name: "Challenged", count: null },
      { name: "Accepted", count: funnelCount("accepted") },
      { name: "Ticket", count: null },
      { name: "Measured", count: measured.improved + measured.unchanged + measured.worse },
      { name: "Paid off", count: paidOff },
      { name: "No effect", count: funnelCount("no-effect") },
      { name: "Set aside", count: funnelCount("dismissed", "snoozed") },
    ];
  const rows = overview.rows,
    counts: Record<Who, number> = {
      all: rows.length,
      you: rows.filter((r) => r.decision?.tier === "operator").length,
      flight: rows.filter((r) => r.decision?.tier === "flight").length,
    };
  const shown = rows.filter((r) =>
    filter === "all" ? true : r.decision?.tier === (filter === "you" ? "operator" : "flight"),
  );
  useWholeRows(doNextList, `${shown.length}|${String(open)}|${filter}|${overview.generatedAt}`);
  const openId = open === undefined ? shown[0]?.id : open;
  const alarms = overview.wasteAlarms?.rows ?? [];
  const COLS = 6;
  const outside = overview.outside;
  return (
    <div className="as-cols">
      <div className="as-col">
        <Panel
          className="as-do"
          title="Do next"
          sub={
            <>
              <b className="as-count">{rows.length}</b> ranked
              {alarms.length > 0 && <> · {alarms.length} waste alarms</>}
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
          <ScrollRegion className="as-scroll as-grow" label="Recommendations" innerRef={doNextList}>
            {shown.length === 0 && (filter !== "all" || alarms.length === 0) ? (
              <p className="as-empty">
                {rows.length === 0
                  ? "No open proposal meets the measured triage rules. Missing collection is named in coverage; this is not a healthy-repo verdict."
                  : `No ${WHO_LABEL[filter]} decisions in this list. ${rows.length} proposals are under All.`}
              </p>
            ) : (
              <table>
                <colgroup>
                  <col className="as-c-n" />
                  <col className="as-c-from" />
                  <col />
                  <col className="as-c-meas" />
                  <col className="as-c-dec" />
                  <col className="as-c-act" />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>From</th>
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
          sub={
            <>
              Merged PRs a day ·{" "}
              <button
                type="button"
                className="as-defbtn"
                aria-expanded={showDays}
                onClick={() => setShowDays((v) => !v)}
              >
                Count for each day
              </button>
            </>
          }
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
          <MergedChart days={overview.build.mergedPerDay} showDays={showDays} />
          <ScrollRegion className="as-scroll as-hscroll" label="Health measures">
            <table>
              <colgroup>
                <col />
                <col className="as-c-hwin" />
                <col className="as-c-hwin" />
                <col className="as-c-hchg" />
                <col className="as-c-dotcol" />
              </colgroup>
              <thead>
                <tr>
                  <th>Measure</th>
                  <th className="as-r">
                    {sharedWindow ? (sharedWindow.before ?? "Before") : "Before"}
                  </th>
                  <th className="as-r">{sharedWindow ? sharedWindow.now : "Now"}</th>
                  <th>Change</th>
                  <th>
                    <span className="sr-only">Data state</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.figures.map((f) => (
                  <FigureRow key={f.id} f={f} showWindow={!sharedWindow} />
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
                  <col className="as-c-dotcol" />
                </colgroup>
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="as-r" aria-sort="descending">
                      Findings <span aria-hidden="true">▼</span>
                    </th>
                    <th className="as-r">Touches</th>
                    <th className="as-r">Per touch</th>
                    <th>
                      <span className="sr-only">Data state</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...overview.landing.files]
                    .sort((a, b) => b.findings - a.findings)
                    .map((f) => (
                      <tr key={f.path} className="as-frow">
                        <td className="as-path">
                          <FilePath path={f.path} />
                        </td>
                        <td className="as-r">{f.findings}</td>
                        <td className="as-r">{f.touches}</td>
                        <td
                          className={
                            f.ratio.value !== null && f.ratio.value > 1 ? "as-r as-hot" : "as-r"
                          }
                        >
                          {f.ratio.value === null ? "—" : num(Math.round(f.ratio.value * 10) / 10)}
                        </td>
                        <td className="as-dotcell">
                          <StateDot state={f.ratio.state} />
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
          actions={
            <>
              {paidOff === 0 && <span className="as-loop">Loop never closed</span>}
              {overview.past.items.length > 0 && (
                <button
                  type="button"
                  className="as-defbtn"
                  aria-expanded={showPast}
                  onClick={() => setShowPast((v) => !v)}
                >
                  {showPast ? "Hide results" : `Show ${overview.past.items.length} results`}
                </button>
              )}
            </>
          }
        >
          <div className="as-fun">
            {stages.map((st) => (
              <div key={st.name} className="as-cell">
                <b
                  className="as-fig"
                  title={st.count === null ? "Not recorded by this server" : undefined}
                >
                  {st.count === null ? "—" : st.count}
                </b>
                <span className="as-cap">{st.name}</span>
              </div>
            ))}
          </div>
          {overview.past.items.length === 0 ? (
            <p className="as-empty">
              No proposal has been decided yet, so there is no result to show.
            </p>
          ) : (
            showPast && (
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
            )
          )}
        </Panel>
      </div>
    </div>
  );
}
