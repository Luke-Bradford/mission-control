import { type Crew, type CrewRow, HUD_STATE_LABEL, HUD_STATE_TONE } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { doingLine, hasActiveRun, isLoopInFlight, LOOP_PHASE_LABEL, runElapsed } from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { dur } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink } from "../router.ts";
import { inSession, useSession } from "../shell/session.ts";

const DASH = "—";
export const NO_CREW_RUNS = "No crew runs. Start a seat from a ticket on the Board.";

/** One row of Work in flight; its doing line is the Overview's, with the whole line as hover text. */
function WorkRow({ r, now, tz }: { r: CrewRow; now: number; tz: string | null }) {
  const to = agentPath(r.id);
  const elapsed = r.run ? runElapsed(r.run, now) : null;
  const repoPrs = useReviewPrs(r);
  const doing = doingLine(r, now, tz, repoPrs);
  return (
    <li className="row">
      <a href={to} onClick={(e) => followLink(e, to)}>
        <AgentTag id={r.id} index={r.index} />
      </a>
      <Pill tone={HUD_STATE_TONE[r.hudState]}>{HUD_STATE_LABEL[r.hudState]}</Pill>
      {r.ticket && <TicketRef ticket={r.ticket} />}
      {r.loop && (
        <span
          className={["s", "loopphase", r.loop.phase === "parked" ? "crit-t" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {LOOP_PHASE_LABEL[r.loop.phase]}
        </span>
      )}
      {r.loop?.prNumber != null && (
        <RepoRef repoId={r.repoId} number={r.loop.prNumber} kind="pr" bare />
      )}
      <span className="s">{r.run?.branch ?? DASH}</span>
      <span className="s num">{elapsed === null ? DASH : dur(elapsed)}</span>
      <span className="s fg2 min0 ellip" title={doing}>
        <DoingLine row={r} now={now} tz={tz} repoPrs={repoPrs} />
      </span>
    </li>
  );
}

/**
 * Work in flight (catalogue §2.2): one row per crew seat with an active run, and one per run in a
 * loop that is not done (its phase and PR beside the ticket). Observed loops are not listed here.
 */
export function WorkInFlight() {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const now = useSecond();
  const tz = useTz();
  const [session] = useSession();
  const active = (crew?.rows ?? []).filter(
    (r) =>
      r.kind === "crew" && (hasActiveRun(r) || isLoopInFlight(r)) && inSession(session, r.repoId),
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
