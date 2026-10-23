import {
  type Crew,
  type CrewRow,
  FIX_STEP,
  HUD_STATE_LABEL,
  HUD_STATE_TONE,
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
function WorkRow({ r, now, tz }: { r: CrewRow; now: number; tz: string | null }) {
  const to = agentPath(r.id);
  const elapsed = r.run ? runElapsed(r.run, now) : null;
  const repoPrs = useReviewPrs(r);
  const doing = doingLine(r, now, tz, repoPrs);
  return (
    <li>
      <div className="row">
        <a className="agent-link" href={to} onClick={(e) => followLink(e, to)}>
          <AgentTag id={r.id} index={r.index} />
        </a>
        <Pill tone={HUD_STATE_TONE[r.hudState]}>{HUD_STATE_LABEL[r.hudState]}</Pill>
        {r.ticket && <TicketRef ticket={r.ticket} />}
        {r.ticketTitle && (
          <span className="s min0 ellip" title={r.ticketTitle}>
            {r.ticketTitle}
          </span>
        )}
        <StepCells r={r} />
        {r.loop?.prNumber != null && (
          <RepoRef repoId={r.repoId} number={r.loop.prNumber} kind="pr" bare />
        )}
        <span className="s">{r.run?.branch ?? DASH}</span>
        <span className="s num">{elapsed === null ? DASH : dur(elapsed)}</span>
        <span className="s fg2 min0 ellip" title={doing}>
          <DoingLine row={r} now={now} tz={tz} repoPrs={repoPrs} />
        </span>
      </div>
    </li>
  );
}

/**
 * Work in flight (catalogue §2.2): one row per crew seat with an active run and a ticket, and one
 * per run in a loop that is not done (its steps and PR beside the ticket). Observed loops are not
 * listed here.
 */
export function WorkInFlight() {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const now = useSecond();
  const tz = useTz();
  const { inView: matchesSession } = useSessionScope();
  const active = (crew?.rows ?? []).filter(
    (r) =>
      r.kind === "crew" &&
      r.ticket !== null &&
      (hasActiveRun(r) || isLoopInFlight(r)) &&
      matchesSession(r),
  );
  if (active.length === 0) return <p className="pb note">{crew ? NO_CREW_RUNS : DASH}</p>;
  return (
    <ul className="pb tlist" aria-label="Crew runs">
      {active.map((r) => (
        <WorkRow key={r.id} r={r} now={now} tz={tz} />
      ))}
    </ul>
  );
}
