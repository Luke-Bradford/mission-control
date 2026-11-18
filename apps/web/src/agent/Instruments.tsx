import type { ConfigView, CrewRow, RunView } from "@mc/core";
import { type ReactNode, useState } from "react";
import { useNow, useTz } from "../clock.ts";
import { stepMarks } from "../crew.ts";
import { RESOURCES, RUNS_LIMIT, useResource } from "../data.ts";
import { cost, dur, kTokens, percent } from "../fmt.ts";
import { Seg } from "../hud/Seg.tsx";
import { contextCapacity } from "../overview/ContextCapacity.tsx";
import { followLink } from "../router.ts";
import { AGENT_FIGURES_KEY, readKey, writeKey } from "../storage.ts";
import { allTime, CONTEXT_HANDOVER_PCT, planProgress } from "./control.ts";
import { usePlan } from "./plan.ts";
import { seatClass } from "./roster.ts";

const DASH = "—";
const NOT_RECORDED = "not recorded";

/** One figure: a label, a value and a definition that shows on hover and on keyboard focus. */
function Figure({
  label,
  value,
  note,
  warn,
  definition,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  /** Past its threshold: amber, and this word says so. */
  warn?: string;
  definition: string;
}) {
  return (
    <div className={`fig${warn ? " warn" : ""}`} title={definition}>
      <button type="button" className="fig-k" aria-label={`${label}: ${definition}`}>
        {label}
      </button>
      <span className="fig-v num">
        {value}
        {warn && <b className="fig-w"> {warn}</b>}
      </span>
      {note && <span className="fig-n">{note}</span>}
      <span className="fig-def" role="tooltip">
        {definition}
      </span>
    </div>
  );
}

/** The context as a ring with the number and the limit printed beside it. */
function ContextRing({ row }: { row: CrewRow }) {
  // The Overview's own reading, so the two pages cannot disagree about a seat.
  const pct = contextCapacity(row).pct;
  const shown = pct === null ? null : Math.min(100, pct);
  const r = 22;
  const c = 2 * Math.PI * r;
  const over = shown !== null && shown >= CONTEXT_HANDOVER_PCT;
  const used = row.digest?.contextTokens ?? null;
  const win = row.contextWindow;
  return (
    <div className="inst ctx">
      <svg
        viewBox="0 0 56 56"
        width="56"
        height="56"
        role="img"
        aria-label={shown === null ? "Context not measured" : `Context ${percent(pct)} used`}
      >
        <circle cx="28" cy="28" r={r} className="ring-bg" />
        {shown !== null && (
          <circle
            cx="28"
            cy="28"
            r={r}
            className={`ring-fg${over ? " warn" : ""}`}
            strokeDasharray={`${(c * shown) / 100} ${c}`}
            transform="rotate(-90 28 28)"
          />
        )}
        <line
          x1="28"
          y1="3"
          x2="28"
          y2="9"
          className="ring-mark"
          transform={`rotate(${(CONTEXT_HANDOVER_PCT / 100) * 360} 28 28)`}
        />
      </svg>
      <div>
        <b className="inst-big num">{pct === null ? DASH : percent(pct)}</b>
        <span className="inst-n">
          {used !== null && win !== null && win > 0
            ? `${kTokens(used)} used of ${kTokens(win)}`
            : "not measured"}
        </span>
        <span className="inst-n">hands over at {percent(CONTEXT_HANDOVER_PCT)}</span>
      </div>
    </div>
  );
}

function LoopBlock({ row, now }: { row: CrewRow; now: number }) {
  const loop = row.loop;
  if (!loop) {
    return (
      <div className="inst loop">
        <span className="inst-h">Loop</span>
        <span className="inst-n">No loop in flight.</span>
      </div>
    );
  }
  const marks = stepMarks(loop, row.hudState);
  const names = (loop.steps?.map((s) => s.name) ?? []).length
    ? (loop.steps ?? []).map((s) => s.name)
    : null;
  return (
    <div className="inst loop">
      <span className="inst-h">Loop</span>
      <ol className="loop-steps" aria-label="Loop steps">
        {marks.map((m, i) => {
          const name = names?.[i] ?? `Step ${i + 1}`;
          return (
            <li
              key={name}
              className={m}
              aria-current={m === "cur" || m === "held" ? "step" : undefined}
            >
              {name}
            </li>
          );
        })}
      </ol>
      <span
        className="inst-n"
        title="Time in the current step is not recorded; this is the seat's time in its state."
      >
        {row.hudState === "running" ? "working" : row.hudState} for{" "}
        {dur(Math.max(0, now - row.stateSince))} (in this state)
      </span>
    </div>
  );
}

function PlanBar({ row }: { row: CrewRow }) {
  const plan = planProgress(usePlan(row));
  if (!plan) return null;
  return (
    <div className="inst plan">
      <span className="inst-h">Plan</span>
      <span className="plan-bar" role="img" aria-label={`${plan.done} of ${plan.total} steps done`}>
        <b style={{ width: `${(100 * plan.done) / plan.total}%` }} />
      </span>
      <span className="inst-n">
        {plan.done} of {plan.total} steps done
      </span>
    </div>
  );
}

type Scope = "run" | "all";
const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: "run", label: "This run" },
  { value: "all", label: "All time" },
];

function readScope(): Scope {
  return readKey(AGENT_FIGURES_KEY) === "all" ? "all" : "run";
}

function RunFigures({ row }: { row: CrewRow }) {
  const t = row.run?.tokens ?? null;
  return (
    <>
      <Figure
        label="Tokens read"
        value={t ? kTokens(t.input + t.cacheRead + t.cacheCreate) : DASH}
        definition="Tokens the model read in this run, re-reads included. Not the context figure. Source: the run's reported usage."
      />
      <Figure
        label="Tokens written"
        value={t ? kTokens(t.output) : DASH}
        definition="Tokens the model wrote in this run. Source: the run's reported usage."
      />
      <Figure
        label="Commits"
        value={row.work ? row.work.commits : DASH}
        definition="Commits this run has made on its branch. Source: the hub's run record."
      />
      <Figure
        label="Refusals"
        value={row.work ? row.work.denials : DASH}
        definition="Calls the guard refused in this run. Source: the hub's guard record."
      />
    </>
  );
}

function AllFigures({ row }: { row: CrewRow }) {
  const tz = useTz();
  const runs = useResource<RunView[]>(RESOURCES.runs(row.id)).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const codex = config?.accounts.find((a) => a.id === row.accountId)?.vendor === "codex";
  if (!runs) return <span className="inst-n">Loading…</span>;
  const a = allTime(runs);
  // The list is the newest RUNS_LIMIT runs; a full one means older runs exist that these figures miss.
  const capped = runs.length >= RUNS_LIMIT;
  const lastN = `in the last ${RUNS_LIMIT} runs`;
  const cls = seatClass(row);
  const since =
    a.firstRunAt !== null && tz
      ? new Date(a.firstRunAt).toLocaleDateString("en-GB", {
          timeZone: tz,
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;
  return (
    <>
      <Figure
        label="Runs"
        value={capped ? `${a.runs}+` : a.runs}
        note={
          since
            ? capped
              ? `since ${since} (last ${RUNS_LIMIT} runs)`
              : `first ${since}`
            : undefined
        }
        definition={
          capped
            ? `Runs this seat has made. Only its newest ${RUNS_LIMIT} are read, so it has at least this many. Source: the hub's run list.`
            : "Runs this seat has made. Source: the hub's run list."
        }
      />
      <Figure
        label="Tickets"
        value={a.tickets}
        note={capped ? lastN : undefined}
        definition="Different tickets those runs worked. Source: the hub's run list."
      />
      {cls === "developer" || cls === "reviewer" ? (
        <Figure
          label={cls === "developer" ? "Rounds per PR" : "Findings per review"}
          value={NOT_RECORDED}
          definition={
            cls === "developer"
              ? "Review rounds each PR needed, and the share needing 3 or more. Not yet read for this page."
              : "Blocking and minor findings per review. Not yet read for this page."
          }
        />
      ) : (
        <Figure
          label="Hours in runs"
          value={a.hoursInRuns.toFixed(1)}
          note={capped ? lastN : undefined}
          definition="Hours from start to end of those runs. Source: the hub's run list."
        />
      )}
      <Figure
        label="Cost"
        value={codex || a.costUsd === null ? NOT_RECORDED : cost(a.costUsd)}
        note={capped && !codex && a.costUsd !== null ? lastN : undefined}
        definition={
          codex
            ? "Codex runs do not record cost yet, so none is shown."
            : "Recorded cost of those runs. Source: the hub's run list."
        }
      />
    </>
  );
}

/** The instrument row: context ring, the loop, the plan and the figures. */
export function Instruments({ row }: { row: CrewRow }) {
  const now = useNow();
  const [scope, setScopeState] = useState<Scope>(readScope);
  const setScope = (s: Scope) => {
    setScopeState(s);
    writeKey(AGENT_FIGURES_KEY, s);
  };
  return (
    <section className="panel instruments" aria-label="Instruments">
      <ContextRing row={row} />
      <LoopBlock row={row} now={now} />
      <PlanBar row={row} />
      <div className="inst figs">
        <Seg label="Figures" options={SCOPES} value={scope} onChange={setScope} />
        <div className="figs-row">
          {scope === "run" ? <RunFigures row={row} /> : <AllFigures row={row} />}
        </div>
        <a
          className="inst-n"
          href={`/audit?seat=${encodeURIComponent(row.id)}`}
          onClick={(e) => followLink(e, `/audit?seat=${encodeURIComponent(row.id)}`)}
        >
          Open this seat in Audit
        </a>
      </div>
    </section>
  );
}
