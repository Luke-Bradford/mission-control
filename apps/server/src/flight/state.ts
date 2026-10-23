/**
 * The FLIGHT seat as the rest of the hub sees it: which seat it is, whether it is running, and
 * what `GET /api/flight` shows (the seat and the last day's decisions); and the crew as FLIGHT
 * reads it (`flightState`, the wake digest and the `flight_state` tool).
 */
import {
  clockHm,
  FLIGHT_HOUR_MS,
  FLIGHT_MESSAGES_PER_HOUR,
  FLIGHT_RECENT_LISTED,
  FLIGHT_STARTABLE,
  FLIGHT_STARTS_PER_HOUR,
  FLIGHT_TICKETS_LISTED,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_VIEW_LIMIT,
  FLIGHT_VIEW_MS,
  type FlightSeatState,
  type FlightState,
  type FlightView,
  hudColumnOf,
  inLane,
  PRIORITIES,
  READY_LABEL,
  seatCallSign,
  seatDef,
} from "@mc/core";
import type { CcConfig, CrewSeatConfig, CrewSessionConfig } from "../config.ts";
import { accountAtStop } from "../engine/queue.ts";
import { crew, NO_LOCK } from "../hud.ts";
import type { SeatBusy } from "../runtime/supervisor.ts";
import { parseTicket } from "../runview.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";
import { seatFree } from "./tools.ts";

/**
 * The tickets FLIGHT may start in an hour: FLIGHT_STARTS_PER_HOUR per developer (build) seat in its
 * session, and never fewer. The cap guards against a runaway FLIGHT, so it grows with the seats.
 */
export function flightStartCap(config: CcConfig): number {
  const devSeats = (flightSeat(config)?.session.seats ?? []).filter(
    (s) => !s.retiring && seatDef(s).loop === "build",
  ).length;
  return FLIGHT_STARTS_PER_HOUR * Math.max(1, devSeats);
}

/** The watch seat (the first seat that is not retiring and whose seatDef loop is "watch") and its session, else null. */
export function flightSeat(
  config: CcConfig,
): { seat: CrewSeatConfig; session: CrewSessionConfig } | null {
  for (const session of config.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => !s.retiring && seatDef(s).loop === "watch");
    if (seat !== undefined) return { seat, session };
  }
  return null;
}

/** The ids FLIGHT can answer for: its own session's seats other than FLIGHT itself. */
export function flightOwnSeatIds(config: CcConfig): ReadonlySet<string> {
  const found = flightSeat(config);
  if (found === null) return new Set();
  return new Set(found.session.seats.filter((s) => s.id !== found.seat.id).map((s) => s.id));
}

/** That seat's row holds an unended run in a state of ACTIVE_SEAT_STATES. */
export function flightLive(config: CcConfig, store: Store): boolean {
  const found = flightSeat(config);
  if (found === null) return false;
  const row = store.seatSession(found.seat.id);
  if (row === null || row.runId === null || !ACTIVE_SEAT_STATES.includes(row.state)) return false;
  return store.run(row.runId)?.endedAt === null;
}

export function flightView(config: CcConfig, store: Store, now: number): FlightView {
  const found = flightSeat(config);
  return {
    seat:
      found === null
        ? null
        : {
            id: found.seat.id,
            call: seatCallSign(found.seat.id),
            model: found.seat.model,
            state: store.seatSession(found.seat.id)?.state ?? null,
            live: flightLive(config, store),
          },
    decisions: store.flightDecisions(now - FLIGHT_VIEW_MS, FLIGHT_VIEW_LIMIT),
  };
}

const priorityRank = (p: string | null): number => {
  const i = (PRIORITIES as readonly (string | null)[]).indexOf(p);
  return i === -1 ? PRIORITIES.length : i;
};

/** Per store, the PRs already listed as merged or closed (`repo#number:state`): each is listed once. */
const shownByStore = new WeakMap<Store, Set<string>>();
const shownPrs = (store: Store): Set<string> => {
  const set = shownByStore.get(store) ?? new Set<string>();
  shownByStore.set(store, set);
  return set;
};
const shownKey = (p: { repoId: string; number: number; state: string }): string =>
  `${p.repoId}#${p.number}:${p.state}`;

/** FLIGHT has received `s`: each merged or closed PR in it is not listed again. */
export function markPrsShown(store: Store, s: FlightState): void {
  const shown = shownPrs(store);
  for (const p of s.prs) {
    if (p.state !== "open") shown.add(shownKey({ repoId: s.repo, number: p.pr, state: p.state }));
  }
}

/** The facts a delivered state leaves behind: the PRs that will leave the list are not counted. */
export const deliveredFacts = (s: FlightState): string =>
  wakeFacts({ ...s, prs: s.prs.filter((p) => p.state === "open") });

/** The crew as FLIGHT sees it: its session's other seats, their questions, tickets, PRs and limits. */
export function flightState(i: {
  config: CcConfig;
  store: Store;
  busy: readonly SeatBusy[];
  now: number;
}): FlightState {
  const { config, store, busy, now } = i;
  const tz = config.operator.timezone;
  const found = flightSeat(config);
  const since = now - FLIGHT_HOUR_MS;
  const limits = {
    startsLeft: Math.max(
      0,
      flightStartCap(config) - store.countFlightDecisions({ kinds: ["start"], since }),
    ),
    messagesLeft: Math.max(
      0,
      FLIGHT_MESSAGES_PER_HOUR -
        store.countFlightDecisions({ kinds: ["answer", "message", "unpark"], since }),
    ),
  };
  const recent = store.flightDecisions(0, FLIGHT_RECENT_LISTED).map((d) => ({
    time: clockHm(d.at, tz),
    kind: d.kind,
    about: d.about,
    decision: d.decision,
  }));
  if (found === null) {
    return {
      time: clockHm(now, tz),
      repo: "",
      seats: [],
      questions: [],
      tickets: [],
      prs: [],
      recent,
      limits,
    };
  }
  const { session } = found;
  const board = store.board(session.repoId);
  const stalled = new Set(
    crew(config, store, now, NO_LOCK, () => null)
      .rows.filter((r) => r.hudState === "stalled")
      .map((r) => r.id),
  );
  const mine = session.seats.filter((s) => s.id !== found.seat.id && !s.retiring);
  const unended = (seatId: string) => {
    const runId = store.seatSession(seatId)?.runId ?? null;
    const run = runId === null ? null : store.run(runId);
    return run !== null && run.endedAt === null ? run : null;
  };
  const open = store.openQuestions();

  const seats = mine.map((s): FlightSeatState => {
    const row = store.seatSession(s.id);
    const run = unended(s.id);
    const loop = run?.loop ?? null;
    const t = run?.ticket == null ? null : parseTicket(run.ticket);
    const last = row?.lastTurnEndedAt ?? null;
    return {
      id: s.id,
      call: seatCallSign(s.id),
      role: s.role,
      loop: seatDef(s).loop,
      area: s.area,
      state: row?.state ?? null,
      free: seatFree(store, busy, s.id),
      ticket: run?.ticket ?? null,
      title: t === null ? null : (board.find((b) => b.issueNumber === t.number)?.title ?? null),
      phase: loop?.phase ?? null,
      parked:
        loop?.phase === "parked"
          ? { kind: loop.parked?.kind ?? "", reason: loop.parked?.reason ?? "" }
          : null,
      stalled: stalled.has(s.id),
      idleMin:
        run !== null && row?.state === "idle" && last !== null
          ? Math.floor((now - last) / 60_000)
          : null,
      openQuestion: open.some((q) => q.agentId === s.id),
      atStop: accountAtStop(config, store, s.accountId, now),
    };
  });

  const questions = open
    .filter(
      (q) =>
        q.passedAt === null &&
        mine.some((s) => s.id === q.agentId) &&
        unended(q.agentId)?.id === q.runId,
    )
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .map((q) => ({
      id: q.id,
      seat: q.agentId,
      ticket: unended(q.agentId)?.ticket ?? null,
      text: q.text,
      ageMin: Math.floor((now - q.at) / 60_000),
    }));

  const active = store.activeTickets();
  const tickets = board
    .filter(
      (b) =>
        !b.closed &&
        inLane(b.labels, config.crew?.lane, config.crew?.laneDefault ?? false) &&
        FLIGHT_STARTABLE.includes(hudColumnOf(b)) &&
        !active.has(`${b.repoId}#${b.issueNumber}`) &&
        !b.blockedBy.some((x) => !x.closed),
    )
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.createdAt - b.createdAt ||
        a.issueNumber - b.issueNumber,
    )
    .slice(0, FLIGHT_TICKETS_LISTED)
    .map((b) => {
      const column = hudColumnOf(b);
      return {
        ref: `${b.repoId}#${b.issueNumber}`,
        title: b.title,
        column,
        priority: b.priority,
        labels: b.labels,
        ready: column === "Ready" || b.labels.includes(READY_LABEL),
        blockedBy: b.blockedBy.filter((x) => x.closed).map((x) => x.ref),
      };
    });

  const ready = new Set(store.notes().flatMap((n) => (n.kind === "ready" ? [n.runId] : [])));
  // The list is the stored read of the repo's PRs, not any run's phase or park: an open PR is
  // listed at every wake until it merges or closes. A PR that left the open state is listed once.
  const holders = store
    .loopRuns(now)
    .filter(
      (r) =>
        r.endedAt === null &&
        r.repoId === session.repoId &&
        r.loop?.prNumber != null &&
        mine.some((s) => s.id === r.agentId),
    );
  const stale = store.stalePullRequests(session.repoId);
  const shown = shownPrs(store);
  const prs = store
    .pullRequests(session.repoId)
    .filter(
      (p) => p.state === "open" || (!shown.has(shownKey(p)) && now - p.updatedAt < FLIGHT_HOUR_MS),
    )
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const holder = holders.find((r) => r.loop?.prNumber === p.number);
      return {
        ref: p.ticket ?? holder?.ticket ?? "",
        pr: p.number,
        seat: holder?.agentId ?? "",
        ready: holder !== undefined && ready.has(holder.id),
        state: p.state,
        headSha: p.headSha,
        readAt: clockHm(store.pullRequestReadAt(session.repoId, p.number) ?? 0, tz),
        stale: stale.has(p.number),
      };
    });

  return {
    time: clockHm(now, tz),
    repo: session.repoId,
    seats,
    questions,
    tickets,
    prs,
    recent,
    limits,
  };
}

/** What a wake is about, as a stable string (no times): it changes only when something new needs FLIGHT. */
export function wakeFacts(s: FlightState): string {
  const startable = s.tickets.filter((t) => t.ready);
  const free =
    startable.length > 0
      ? s.seats.filter((x) => x.loop === "build" && x.free).map((x) => x.id)
      : [];
  return JSON.stringify({
    q: s.questions.map((q) => q.id).sort((a, b) => a - b),
    free: free.sort(),
    t: free.length > 0 ? startable.map((t) => t.ref) : [],
    parked: s.seats
      .filter((x) => x.parked !== null)
      .map((x) => `${x.id}:${x.ticket}:${x.parked?.kind}`)
      .sort(),
    stopped: stoppedSeats(s),
    prs: s.prs.map((p) => `${p.ref}:${p.pr}:${p.ready}:${p.state}`).sort(),
  });
}

/** The build seats left stopped, which only a start (or the operator) brings back into rotation. */
const stoppedSeats = (s: FlightState): string[] =>
  s.seats
    .filter((x) => x.loop === "build" && x.state === "stopped")
    .map((x) => x.id)
    .sort();

/** Something still waits on FLIGHT: a question, a free or stopped build seat, or a park in FLIGHT_UNPARK_KINDS. */
export function pending(s: FlightState): boolean {
  return (
    s.questions.length > 0 ||
    stoppedSeats(s).length > 0 ||
    (s.tickets.some((t) => t.ready) && s.seats.some((x) => x.loop === "build" && x.free)) ||
    s.seats.some(
      (x) =>
        x.parked !== null && (FLIGHT_UNPARK_KINDS as readonly string[]).includes(x.parked.kind),
    )
  );
}
