import {
  type Crew,
  type CrewRow,
  FIX_STEP,
  type FlightLedgerEntry,
  type FlightLedgerView,
  type RunLoopView,
} from "@mc/core";
import { heldStep } from "../agent/loopView.ts";
import { useSecond, useTz } from "../clock.ts";
import {
  doingLine,
  hasActiveRun,
  isLoopInFlight,
  loopSteps,
  runElapsed,
  type StepMark,
  seatStatus,
  stepMarks,
} from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { dur } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";

const DASH = "—";
export const NO_CREW_RUNS = "No crew runs. Start a seat from a ticket on the Board.";

/** The step bar's classes (hud.css): done, current and held. */
const MARK_CLASS: Record<StepMark, string | undefined> = {
  done: "d",
  cur: "c",
  held: "w",
  todo: undefined,
};

/**
 * A run's loop step by step, as the Agent page's stepper has it: a cell per step with its name,
 * "×N" from the second try. The counts come from the run's tries and wait until they load.
 */
function StepCells({ r }: { r: CrewRow }) {
  const tries = useResource<RunLoopView>(r.run ? RESOURCES.runLoop(r.run.id) : null).data?.tries;
  const loop = r.loop;
  if (!loop) return null;
  const steps = loopSteps(loop);
  const fixStep = steps.findIndex((s) => s.name === FIX_STEP);
  const marks = stepMarks(
    loop,
    r.hudState,
    loop.phase === "parked" ? (heldStep(tries ?? []) ?? undefined) : undefined,
  );
  return (
    <span className="wsteps">
      {steps.map((step, i) => {
        const mark = marks[i] as StepMark;
        const label = step.name;
        // Fix tries carry their preceding phase unless the template has a dedicated fix step.
        // Catalogue §2.2, L218 counts fix tries in ×N; the Agent page doesn't yet.
        const n =
          tries?.filter((t) => (t.fix && fixStep >= 0 ? i === fixStep : t.step === step.phase))
            .length ?? 0;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: Profile step order is fixed; names may repeat.
            key={`${i}:${step.name}`}
            className={["wstep", MARK_CLASS[mark]].filter(Boolean).join(" ")}
            title={n > 0 ? `${label} · ${n} ${n === 1 ? "try" : "tries"}` : undefined}
            aria-current={mark === "cur" || mark === "held" ? "step" : undefined}
          >
            {label}
            {n > 1 && <span className="titer">×{n}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** One row of Work in flight; its doing line is the Overview's, with the whole line as hover text. */
function ticketNumber(ticket: string | null): string | null {
  return ticket?.match(/#\d+$/)?.[0] ?? null;
}

function ledgerWork(row: CrewRow, entries: readonly FlightLedgerEntry[]): FlightLedgerEntry | null {
  const ticket = ticketNumber(row.ticket);
  const work = entries.filter((entry) => entry.kind === "work");
  return (
    (ticket
      ? work.find((entry) =>
          entry.refs.some((ref) => !ref.startsWith("PR ") && ref.endsWith(ticket)),
        )
      : undefined) ??
    work.find((entry) => entry.owner === row.id) ??
    null
  );
}

function WorkRow({
  r,
  now,
  tz,
  entry,
}: {
  r: CrewRow;
  now: number;
  tz: string | null;
  entry: FlightLedgerEntry | null;
}) {
  const to = agentPath(r.id);
  const elapsed = r.run ? runElapsed(r.run, now) : null;
  const repoPrs = useReviewPrs(r);
  const doing = doingLine(r, now, tz, repoPrs);
  return (
    <li>
      <div className="row wif-row">
        <div className="wif-seat">
          <a className="agent-link" href={to} onClick={(e) => followLink(e, to)}>
            <AgentTag id={r.id} index={r.index} bare />
          </a>
          <span title={seatStatus(r).reason ?? seatStatus(r).label}>
            <Pill tone={seatStatus(r).tone}>{seatStatus(r).label}</Pill>
          </span>
        </div>
        <div className="wif-work min0">
          <span>
            {r.ticket && <TicketRef ticket={r.ticket} />}
            {r.ticketTitle && (
              <b className="min0 ellip" title={r.ticketTitle}>
                {r.ticketTitle}
              </b>
            )}
          </span>
          <span className="wif-doing s fg2 min0 ellip" title={doing}>
            <DoingLine row={r} now={now} tz={tz} repoPrs={repoPrs} />
          </span>
        </div>
        <div className="wif-stage min0">
          <StepCells r={r} />
          {r.loop?.prNumber != null && (
            <RepoRef repoId={r.repoId} number={r.loop.prNumber} kind="pr" bare />
          )}
        </div>
        <span className="wif-next min0" title={entry?.next ?? "No next action recorded"}>
          <span className="s ellip">{entry?.next ?? "No next action recorded"}</span>
          <span className={`s ${entry?.due == null ? "warn-t" : "fg2"}`}>
            {entry?.due == null || tz === null
              ? "No checkpoint"
              : entry.due <= now
                ? `Checkpoint overdue ${dur(now - entry.due)}`
                : `Checkpoint in ${dur(entry.due - now)}`}
          </span>
        </span>
        <span className="wif-elapsed s num">{elapsed === null ? DASH : dur(elapsed)}</span>
      </div>
    </li>
  );
}

/**
 * Work in flight (catalogue §2.2): one row per crew seat with an active run and a ticket, and one
 * per run in a loop that is not done (its steps and PR beside the ticket). Observed loops are not
 * listed here.
 */
export function activeCrewRows(
  crew: Crew | undefined,
  matchesSession: (row: Pick<CrewRow, "sessionId" | "repoId">) => boolean,
): CrewRow[] {
  return (crew?.rows ?? []).filter(
    (r) =>
      r.kind === "crew" &&
      r.ticket !== null &&
      (hasActiveRun(r) || isLoopInFlight(r)) &&
      matchesSession(r),
  );
}

export function WorkInFlight() {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen).data;
  const now = useSecond();
  const tz = useTz();
  const { inView: matchesSession } = useSessionScope();
  const active = activeCrewRows(crew, matchesSession);
  if (active.length === 0) return <p className="pb note">{crew ? NO_CREW_RUNS : DASH}</p>;
  return (
    <div className="wif-table">
      <div className="wif-table-head" aria-hidden="true">
        <span>Owner</span>
        <span>Workstream</span>
        <span>Delivery path</span>
        <span>Next / checkpoint</span>
        <span>Age</span>
      </div>
      <ul className="pb tlist" aria-label="Crew runs">
        {active.map((r) => (
          <WorkRow
            key={r.id}
            r={r}
            now={now}
            tz={tz}
            entry={ledger?.session === r.sessionId ? ledgerWork(r, ledger.entries ?? []) : null}
          />
        ))}
      </ul>
    </div>
  );
}
