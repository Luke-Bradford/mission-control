import {
  type CrewRow,
  type PullRequestView,
  type RunLoopView,
  type RunView,
  runPill,
  startOfLocalDay,
} from "@mc/core";
import { type KeyboardEvent, memo, type ReactNode, useEffect, useState } from "react";
import { useSecond } from "../clock.ts";
import { Clamp } from "../components/Expandable.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { BUILD_LOOP_TEMPLATE, isLoopInFlight, runElapsed, runPrs } from "../crew.ts";
import { RESOURCES, type Resource, useResource } from "../data.ts";
import { cost, dayMonth, dur, hhmm, kTokens } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { PrChip } from "../hud/PrChip.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { navigate, useSearch } from "../router.ts";
import { EndAsideButton, LoopSteps } from "./LoopSteps.tsx";
import { LoopTimeline } from "./LoopTimeline.tsx";
import { type LoopLimits, runLimits } from "./loopView.ts";

const DASH = "—";

type View = "steps" | "timeline" | "runs";
const VIEWS: readonly { value: View; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "timeline", label: "Timeline" },
  { value: "runs", label: "Runs" },
];

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

const Bar = ({ pct }: { pct: number }) => (
  <span className="mbar">
    <i style={{ width: `${clampPct(pct)}%` }} />
  </span>
);

/** The run's budgets above Steps and Timeline: tokens used of the run's budget, review rounds of its limit. */
function Budget({
  view,
  tokens,
  limits,
}: {
  view: RunLoopView;
  tokens: { input: number; output: number } | null | undefined;
  limits: LoopLimits;
}) {
  const used = tokens ? tokens.input + tokens.output : 0;
  const round = Math.min(view.round ?? 1, limits.rounds);
  return (
    <div className="budget s">
      <span>
        Tokens <b>{kTokens(used)}</b>
        {view.budget !== null && ` of ${kTokens(view.budget)}`}
      </span>
      {view.budget === null ? <span /> : <Bar pct={(used * 100) / view.budget} />}
      <span>
        Round <b>{round}</b> of {limits.rounds}
      </span>
      <Bar pct={(round * 100) / limits.rounds} />
    </div>
  );
}

/**
 * `14:05` today, `17 Oct` on another day (operator timezone), so the column stays narrow enough
 * for the side panel; the title always carries the date and time.
 */
function Started({ ms, now, tz }: { ms: number; now: number; tz: string | null }) {
  if (!tz) return <span className="num fg2">{DASH}</span>;
  const today = startOfLocalDay(now, tz) === startOfLocalDay(ms, tz);
  return (
    <span className="num fg2" title={`${dayMonth(ms, tz)} ${hhmm(ms, tz)}`}>
      {today ? hhmm(ms, tz) : dayMonth(ms, tz)}
    </span>
  );
}

/**
 * Enter or Space with Ctrl or Meta held is a browser or OS shortcut, not the button's: it does
 * nothing here (a native button activates on Enter's keydown and Space's keyup).
 */
const noChord = (e: KeyboardEvent<HTMLElement>) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === " ")) e.preventDefault();
};

const runDur = (r: RunView, now: number): string => {
  const ms = runElapsed(r, now);
  return ms === null ? DASH : dur(ms);
};

function TimedLoopBody({
  kind,
  row,
  view,
  prs,
  limits,
  loopView,
}: {
  kind: "steps" | "timeline";
  row: CrewRow;
  view?: RunLoopView;
  prs?: PullRequestView[];
  limits?: LoopLimits;
  loopView?: Resource<RunLoopView>;
}) {
  const now = useSecond();
  return kind === "steps" ? (
    <LoopSteps row={row} view={view} prs={prs} limits={limits as LoopLimits} now={now} />
  ) : (
    <LoopTimeline row={row} loopView={loopView as Resource<RunLoopView>} now={now} />
  );
}

export const RunRow = memo(function RunRow({
  row,
  run,
  tz,
  prs,
  open,
  onToggle,
  onRender,
}: {
  row: CrewRow;
  run: RunView;
  tz: string | null;
  prs: ReturnType<typeof runPrs>;
  open: boolean;
  onToggle: (id: string) => void;
  /** Test instrumentation for the static row boundary. */
  onRender?: () => void;
}) {
  onRender?.();
  const pill = runPill(run, row);
  const tokens = run.tokens ? kTokens(run.tokens.input + run.tokens.output) : DASH;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the summary is the keyboard route
    // biome-ignore lint/a11y/noStaticElementInteractions: as above; the row is a container
    <div
      className="runrow s"
      onClick={(e) => {
        if (run.summary && !(e.target as Element).closest("a")) onToggle(run.id);
      }}
    >
      <span className="num">#{run.seq}</span>
      <span>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </span>
      <RunTimes run={run} tz={tz} />
      <span className="num right">{tokens}</span>
      <span className="num right">{cost(run.costUsd)}</span>
      {run.endedAt === null && run.loop?.aside && run.id !== row.run?.id && (
        // a set-aside run the seat has moved on from; the wrapper keeps the click off the row
        // biome-ignore lint/a11y/useKeyWithClickEvents: the button inside is the keyboard route
        // biome-ignore lint/a11y/noStaticElementInteractions: as above; this only stops bubbling
        <span onClick={(e) => e.stopPropagation()}>
          <EndAsideButton row={row} runId={run.id} />
        </span>
      )}
      {(run.ticket || prs.length > 0) && (
        <span className="rticket min0 xs">
          {run.ticket && <TicketRef ticket={run.ticket} bare />}
          {run.ticketTitle && (
            <span className="rtitle" title={run.ticketTitle}>
              {run.ticketTitle}
            </span>
          )}
          {prs.map((pr) => (
            <PrChip key={`${pr.repoId}#${pr.number}`} pr={pr} bare />
          ))}
        </span>
      )}
      {run.summary && (
        <button
          type="button"
          className={open ? "rsummary s fg2 open" : "rsummary s fg2"}
          title={run.summary}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(run.id);
          }}
          onKeyDown={noChord}
          onKeyUp={noChord}
        >
          <Clamp className="rtext" lines={2} open={open}>
            <MarkdownInline text={run.summary} />
          </Clamp>
        </button>
      )}
    </div>
  );
});

function RunTimes({ run, tz }: { run: RunView; tz: string | null }) {
  const now = useSecond();
  return (
    <>
      <Started ms={run.startedAt} now={now} tz={tz} />
      <span className="num right">{runDur(run, now)}</span>
    </>
  );
}

/**
 * The mockup's Loop panel: where a looped run is (Steps) and the loop's recent runs. It opens on
 * Steps while the loop is in flight; a choice the viewer makes holds until that changes.
 */
export function RunsPanel({ row, tz }: { row: CrewRow; tz: string | null }) {
  const inFlight = isLoopInFlight(row);
  const runId = row.run?.id ?? null;
  // A pick lasts for the loop it was made on: a new run or a change in flight forgets it.
  const [picked, setPicked] = useState<{
    view: View;
    inFlight: boolean;
    runId: string | null;
  } | null>(null);
  const view: View =
    picked && picked.inFlight === inFlight && picked.runId === runId
      ? picked.view
      : inFlight
        ? "steps"
        : "runs";
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const requestedRun = new URLSearchParams(useSearch()).get("run");
  useEffect(() => {
    if (requestedRun) {
      setPicked({ view: "runs", inFlight, runId });
      setOpen(new Set([requestedRun]));
      // Consume the deep link so later loops keep their normal default view.
      const url = new URL(window.location.href);
      url.searchParams.delete("run");
      navigate(url.pathname + url.search + url.hash, { replace: true });
    }
  }, [requestedRun, inFlight, runId]);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const runs = useResource<RunView[]>(RESOURCES.runs(row.id));
  const list = runs.data ?? [];
  // A crew run never records its PRs (a seat opens them through mc): they are found by branch.
  // The loop's CI check reads them too, so a looped observed loop fetches them as well.
  const repoPrs = useResource<PullRequestView[]>(
    row.kind === "crew" || row.loop !== null ? RESOURCES.prs(row.repoId) : null,
  ).data;
  const loopView = useResource<RunLoopView>(
    row.loop && row.run ? RESOURCES.runLoop(row.run.id) : null,
  );
  const limits = runLimits(list.find((r) => r.id === row.run?.id));
  const budget = loopView.data?.loop && loopView.data.round != null && (
    <Budget view={loopView.data} tokens={row.run?.tokens} limits={limits} />
  );

  let body: ReactNode;
  if (view === "steps") {
    body = (
      <>
        {budget}
        <TimedLoopBody row={row} view={loopView.data} prs={repoPrs} limits={limits} kind="steps" />
      </>
    );
  } else if (view === "timeline") {
    body = (
      <>
        {budget}
        <TimedLoopBody row={row} loopView={loopView} kind="timeline" />
      </>
    );
  } else if (runs.error && !runs.data) {
    body = <p className="s crit-t">Could not load the runs: {runs.error.message}</p>;
  } else if (!runs.data) body = <p className="s muted">Loading…</p>;
  else if (list.length === 0) body = <p className="s muted">No runs yet.</p>;
  else {
    body = (
      <>
        <div className="runrow head xs muted">
          <span>Run</span>
          <span>Status</span>
          <span>Started</span>
          <span className="right">Took</span>
          <span className="right">Tokens</span>
          <span className="right">~Cost</span>
        </div>
        {list.map((run) => (
          <RunRow
            key={run.id}
            row={row}
            run={run}
            tz={tz}
            prs={runPrs(run, row.kind === "crew" ? repoPrs : undefined)}
            open={open.has(run.id)}
            onToggle={toggle}
          />
        ))}
      </>
    );
  }

  return (
    <Panel
      id="loopP"
      title={view === "runs" ? "Runs" : "Loop"}
      sub={
        view === "runs"
          ? runs.data
            ? `${list.length} recent runs`
            : undefined
          : row.loop
            ? row.run?.tokens
              ? `${row.loop.profile ?? BUILD_LOOP_TEMPLATE} · ${kTokens(row.run.tokens.input + row.run.tokens.output)} tokens so far`
              : (row.loop.profile ?? BUILD_LOOP_TEMPLATE)
            : undefined
      }
      actions={
        <Seg
          label="Runs view"
          options={VIEWS}
          value={view}
          onChange={(v) => setPicked({ view: v, inFlight, runId })}
        />
      }
    >
      <div className="pb scroll" id="loopBody">
        {body}
      </div>
    </Panel>
  );
}
