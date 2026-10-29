import {
  type Crew,
  type CrewRow,
  FIX_STEP,
  FLIGHT_LEDGER_OPEN,
  type FlightLedgerEntry,
  type FlightLedgerView,
  type FlightView,
  type RunLoopView,
  type TestLockState,
} from "@mc/core";
import { heldStep } from "../agent/loopView.ts";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import {
  doingLine,
  lockSince,
  loopSteps,
  type StepMark,
  seatStatus,
  stepMarks,
  waitText,
} from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { dur } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { parseTicket, RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";

const DASH = "—";
export const NO_SEATS = "No seats are configured.";

/** The step bar's classes (overview.css): done, current and held. */
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
export function StepCells({ r }: { r: CrewRow }) {
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
            {n > 1 && <sup className="titer">×{n}</sup>}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A ledger ref as a ticket: `#N` names an issue in the ledger's session repo (FLIGHT's refs carry
 * no repo); a `repo#N` ref names its own repo. PR refs are not tickets.
 */
function refTicket(ref: string, sessionRepo: string): { repoId: string; number: number } | null {
  if (ref.startsWith("PR ")) return null;
  if (ref.startsWith("#")) {
    const number = Number(ref.slice(1));
    return Number.isInteger(number) && number > 0 ? { repoId: sessionRepo, number } : null;
  }
  return parseTicket(ref);
}

/**
 * The open ledger `work` entry for a row: the one whose ticket ref is the row's ticket (same repo
 * and number). Only when none names it does the owner's entry stand in, and only if the owner has
 * exactly one open work entry and that entry names no ticket; otherwise another ticket's next
 * action or checkpoint would show against this one.
 */
export function ledgerWork(
  row: Pick<CrewRow, "id" | "repoId" | "ticket">,
  entries: readonly FlightLedgerEntry[],
): FlightLedgerEntry | null {
  const work = entries.filter(
    (entry) => entry.kind === "work" && FLIGHT_LEDGER_OPEN.includes(entry.status),
  );
  const tickets = (entry: FlightLedgerEntry) =>
    entry.refs.flatMap((ref) => refTicket(ref, row.repoId) ?? []);
  const ticket = row.ticket === null ? null : parseTicket(row.ticket);
  const exact =
    ticket === null
      ? undefined
      : work.find((entry) =>
          tickets(entry).some((t) => t.repoId === ticket.repoId && t.number === ticket.number),
        );
  if (exact) return exact;
  const owned = work.filter((entry) => entry.owner === row.id);
  return owned.length === 1 && tickets(owned[0] as FlightLedgerEntry).length === 0
    ? (owned[0] as FlightLedgerEntry)
    : null;
}

/**
 * FLIGHT's recorded next action and checkpoint for a workstream. Missing ones are a data-quality
 * gap in FLIGHT's ledger, marked quietly once rather than flagged on every row; no ETA is guessed.
 */
export function NextAction({ entry, now }: { entry: FlightLedgerEntry | null; now: number }) {
  const next = entry?.next ?? null;
  const due = entry?.due ?? null;
  if (next === null && due === null) {
    return (
      <td className="wif-next min0">
        <span className="flight-gap" title="FLIGHT has not recorded a next action or checkpoint">
          Not recorded
        </span>
      </td>
    );
  }
  return (
    <td className="wif-next min0" title={next ?? undefined}>
      {next === null ? (
        <span className="flight-gap">No next action</span>
      ) : (
        <span className="wif-next-text">{next}</span>
      )}
      {due === null ? (
        <span className="flight-gap">No checkpoint</span>
      ) : (
        <span className={`wif-checkpoint${due <= now ? " crit-t" : ""}`}>
          {due <= now ? `Checkpoint overdue ${dur(now - due)}` : `Checkpoint in ${dur(due - now)}`}
        </span>
      )}
    </td>
  );
}

/** FLIGHT's last message to a seat: the newest decision of kind `message` about it. */
export function lastInstruction(view: FlightView | undefined, seatId: string) {
  return (view?.decisions ?? [])
    .filter((d) => d.kind === "message" && d.seatId === seatId)
    .sort((a, b) => b.at - a.at)[0];
}

/**
 * What stops a seat and since when: its pause, its park or block reason, or what its run waits on.
 * Null for a seat that is working or free.
 */
export function stuckLine(
  row: CrewRow,
  lock: TestLockState | undefined,
  now: number,
): { text: string; since: number } | null {
  if (row.crewPause) return { text: `paused: ${row.crewPause.reason}`, since: row.crewPause.at };
  const wait = row.loop ? waitText(row.loop, row.id, lockSince(lock, row.run?.id), now) : null;
  if (wait !== null) return { text: wait, since: row.stateSince };
  const status = seatStatus(row);
  if (["blocked", "parked", "error"].includes(row.hudState))
    return { text: status.reason ?? status.label.toLowerCase(), since: row.stateSince };
  if (row.hudState === "stalled") return { text: "stalled", since: row.stateSince };
  return null;
}

function WorkRow({
  r,
  now,
  tz,
  entry,
  lock,
  view,
}: {
  r: CrewRow;
  now: number;
  tz: string | null;
  entry: FlightLedgerEntry | null;
  lock: TestLockState | undefined;
  view: FlightView | undefined;
}) {
  const to = agentPath(r.id);
  const repoPrs = useReviewPrs(r);
  const doing = doingLine(r, now, tz, repoPrs);
  const stuck = stuckLine(r, lock, now);
  const said = lastInstruction(view, r.id);
  return (
    <tr className="row wif-row" data-testid="seat-row">
      <td className="wif-seat">
        <a className="agent-link" href={to} onClick={(e) => followLink(e, to)}>
          <AgentTag id={r.id} index={r.index} bare />
        </a>
        <span title={seatStatus(r).reason ?? seatStatus(r).label}>
          <Pill tone={seatStatus(r).tone}>{seatStatus(r).label}</Pill>
        </span>
        {r.kind === "loop" && <Pill tone="plain">observed loop</Pill>}
      </td>
      <td className="wif-work min0">
        {r.ticketTitle && (
          <b className="wif-title min0 ellip" title={r.ticketTitle}>
            {r.ticketTitle}
          </b>
        )}
        <span className="wif-meta min0">
          {r.ticket && <TicketRef ticket={r.ticket} />}
          <span className="wif-doing min0 ellip" title={doing}>
            <DoingLine row={r} now={now} tz={tz} repoPrs={repoPrs} />
          </span>
        </span>
        {r.run?.branch && (
          <span className="wif-branch min0 ellip" title={r.run.branch}>
            {r.run.branch}
          </span>
        )}
      </td>
      <td className="wif-stage min0">
        {r.loop ? <StepCells r={r} /> : DASH}
        {r.loop?.prNumber != null && (
          <RepoRef repoId={r.repoId} number={r.loop.prNumber} kind="pr" bare />
        )}
      </td>
      <td className="wif-stuck min0">
        {stuck === null ? (
          DASH
        ) : (
          <>
            <span className="crit-t">{stuck.text}</span>
            <span className="s">{` · since ${dur(Math.max(0, now - stuck.since))} ago`}</span>
          </>
        )}
      </td>
      <NextAction entry={entry} now={now} />
      <td className="wif-said min0" title={said?.decision}>
        {said ? <MarkdownInline text={said.decision} max={90} /> : DASH}
      </td>
    </tr>
  );
}

/**
 * Seats (catalogue §2.2): one row per seat in the session, observed loops included, with its
 * ticket, stage, what stops it and since when, FLIGHT's recorded next action and its last
 * instruction to the seat.
 */
export function WorkInFlight() {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const view = useResource<FlightView>(RESOURCES.flight).data;
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen).data;
  const lock = useResource<TestLockState>(RESOURCES.testLock).data;
  const now = useSecond();
  const tz = useTz();
  const { inView: matchesSession } = useSessionScope();
  const rows = (crew?.rows ?? []).filter(matchesSession);
  if (rows.length === 0) return <p className="pb note">{crew ? NO_SEATS : DASH}</p>;
  return (
    <table className="wif-table" aria-label="Seats">
      <thead>
        <tr className="wif-table-head">
          <th scope="col">Seat</th>
          <th scope="col">Workstream</th>
          <th scope="col">Stage</th>
          <th scope="col">Stuck / waiting on</th>
          <th scope="col">FLIGHT's next action</th>
          <th scope="col">Last instruction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <WorkRow
            key={r.id}
            r={r}
            now={now}
            tz={tz}
            lock={lock}
            view={view}
            entry={ledger?.session === r.sessionId ? ledgerWork(r, ledger.entries ?? []) : null}
          />
        ))}
      </tbody>
    </table>
  );
}
