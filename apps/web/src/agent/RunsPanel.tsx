import {
  type CrewRow,
  type PullRequestView,
  type RunView,
  runPill,
  startOfLocalDay,
} from "@mc/core";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { MarkdownInline } from "../components/Markdown.tsx";
import { BUILD_LOOP_TEMPLATE, isLoopInFlight, runElapsed, runPrs } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dayMonth, dur, hhmm, kTokens } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { PrChip } from "../hud/PrChip.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { EndAsideButton, LoopSteps } from "./LoopSteps.tsx";

const DASH = "—";

type View = "steps" | "runs";
const VIEWS: readonly { value: View; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "runs", label: "Runs" },
];

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

/**
 * The mockup's Loop panel: where a looped run is (Steps) and the loop's recent runs. It opens on
 * Steps while the loop is in flight; a choice the viewer makes holds until that changes.
 */
export function RunsPanel({ row, now, tz }: { row: CrewRow; now: number; tz: string | null }) {
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
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const runs = useResource<RunView[]>(RESOURCES.runs(row.id));
  const list = runs.data ?? [];
  // A crew run never records its PRs (a seat opens them through mc): they are found by branch.
  const repoPrs = useResource<PullRequestView[]>(
    row.kind === "crew" ? RESOURCES.prs(row.repoId) : null,
  ).data;

  let body: ReactNode;
  if (view === "steps") body = <LoopSteps row={row} />;
  else if (runs.error && !runs.data) {
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
        {list.map((r) => {
          const pill = runPill(r, row);
          const tokens = r.tokens ? kTokens(r.tokens.input + r.tokens.output) : DASH;
          const prs = runPrs(r, repoPrs);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the summary is the keyboard route
            // biome-ignore lint/a11y/noStaticElementInteractions: as above; the row is a container
            <div
              className="runrow s"
              key={r.id}
              onClick={(e) => {
                // a link in the row (a ticket or PR on GitHub) goes where it points
                if (r.summary && !(e.target as Element).closest("a")) toggle(r.id);
              }}
            >
              <span className="num">#{r.seq}</span>
              <span>
                <Pill tone={pill.tone}>{pill.label}</Pill>
              </span>
              <Started ms={r.startedAt} now={now} tz={tz} />
              <span className="num right">{runDur(r, now)}</span>
              <span className="num right">{tokens}</span>
              <span className="num right">{cost(r.costUsd)}</span>
              {r.endedAt === null && r.loop?.aside && r.id !== row.run?.id && (
                // a set-aside run the seat has moved on from; the wrapper keeps the click off the row
                // biome-ignore lint/a11y/useKeyWithClickEvents: the button inside is the keyboard route
                // biome-ignore lint/a11y/noStaticElementInteractions: as above; this only stops bubbling
                <span onClick={(e) => e.stopPropagation()}>
                  <EndAsideButton row={row} runId={r.id} />
                </span>
              )}
              {(r.ticket || prs.length > 0) && (
                <span className="rticket min0 xs">
                  {r.ticket && <TicketRef ticket={r.ticket} bare />}
                  {r.ticketTitle && (
                    <span className="rtitle" title={r.ticketTitle}>
                      {r.ticketTitle}
                    </span>
                  )}
                  {prs.map((pr) => (
                    <PrChip key={`${pr.repoId}#${pr.number}`} pr={pr} bare />
                  ))}
                </span>
              )}
              {r.summary && (
                // A disclosure: the button opens the full text, as a click on the row does. Links
                // in the Markdown render as spans, so nothing interactive sits inside it.
                <button
                  type="button"
                  className={open.has(r.id) ? "rsummary s fg2 open" : "rsummary s fg2"}
                  title={r.summary}
                  aria-expanded={open.has(r.id)}
                  onClick={(e) => {
                    // the row's own click handler would toggle a second time
                    e.stopPropagation();
                    toggle(r.id);
                  }}
                  onKeyDown={noChord}
                  onKeyUp={noChord}
                >
                  <span className="rtext">
                    <MarkdownInline text={r.summary} />
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <Panel
      id="loopP"
      title={view === "steps" ? "Loop" : "Runs"}
      sub={
        view === "runs"
          ? runs.data
            ? `${list.length} recent runs`
            : undefined
          : row.loop
            ? row.run?.tokens
              ? `${BUILD_LOOP_TEMPLATE} · ${kTokens(row.run.tokens.input + row.run.tokens.output)} tokens so far`
              : BUILD_LOOP_TEMPLATE
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
