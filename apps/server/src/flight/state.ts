/**
 * The FLIGHT seat as the rest of the hub sees it: which seat it is, whether it is running, and
 * what `GET /api/flight` shows (the seat and the last day's decisions); and the crew as FLIGHT
 * reads it (`flightState`, the wake digest and the `flight_state` tool).
 */
import {
  type AttentionItem,
  clockHm,
  FLIGHT_ABOUT_MAX,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  FLIGHT_HOUR_MS,
  FLIGHT_ITEMS_LISTED,
  FLIGHT_MAX_WAKES,
  FLIGHT_MESSAGES_PER_HOUR,
  FLIGHT_RECENT_LISTED,
  FLIGHT_REPORT_MAX,
  FLIGHT_REPORT_PARKS,
  FLIGHT_STARTABLE,
  FLIGHT_STARTS_PER_HOUR,
  FLIGHT_TICKETS_LISTED,
  FLIGHT_TRIAGE_WAIT_MS,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_VIEW_LIMIT,
  FLIGHT_VIEW_MS,
  type FlightArrivalDisposition,
  type FlightArrivalOperation,
  type FlightBriefSection,
  type FlightBriefView,
  type FlightPark,
  type FlightScheduleView,
  type FlightSeatState,
  type FlightState,
  type FlightView,
  hudColumnOf,
  type ItemDiscussion,
  inLane,
  LANE_LABEL_PREFIX,
  OWNER_FLIGHT,
  OWNER_OPERATOR,
  PR_WAIT_MS,
  PRIORITIES,
  READY_LABEL,
  RULING_PARK,
  type Run,
  seatCallSign,
  seatDef,
  type TestLockState,
  wakeKeyPrefix,
} from "@mc/core";
import type { CcConfig, CrewSeatConfig, CrewSessionConfig } from "../config.ts";
import { accountAtStop } from "../engine/queue.ts";
import { attentionItems, crew, NO_LOCK } from "../hud.ts";
import type { SeatBusy } from "../runtime/supervisor.ts";
import { parseTicket } from "../runview.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";
import { cut, seatFree } from "./tools.ts";

interface TeamsDigestState {
  teamsDigest?: {
    title: string;
    matches: {
      text: string;
      url: string;
      arrival: { source: "Teams"; arrivalId: string; version: string; arrivedAt: number };
    }[];
  };
}

/** Operator-owned items, including those temporarily routed to FLIGHT for triage or handling. */
export function operatorItems(
  config: CcConfig,
  store: Store,
  now: number,
  hubLogin: string | null,
  rows?: ReturnType<typeof crew>["rows"],
  lock: TestLockState = NO_LOCK,
): AttentionItem[] {
  return attentionItems(
    config,
    store,
    now,
    lock,
    rows ?? crew(config, store, now, lock, () => null).rows,
    hubLogin,
  ).filter((i) => i.owner === OWNER_OPERATOR || i.owner === OWNER_FLIGHT);
}

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

/** The seats whose run the HUD shows as stalled. */
export function stalledSeats(
  config: CcConfig,
  store: Store,
  now: number,
  rows = crew(config, store, now, NO_LOCK, () => null).rows,
): Set<string> {
  return new Set(rows.filter((r) => r.hudState === "stalled").map((r) => r.id));
}

/**
 * A reply or `@CAPCOM` tag FLIGHT itself wrote: the operator's to read (Needs you still shows it),
 * not work for FLIGHT. Listing it in the digest woke FLIGHT with every reply it wrote. Assumes one
 * live FLIGHT seat (`flightSeat`).
 */
export const ownReply = (
  item: Pick<AttentionItem, "kind" | "agentId">,
  flightId: string | null,
): boolean =>
  (item.kind === "message" || item.kind === "tag") &&
  flightId !== null &&
  item.agentId === flightId;

/** The ids FLIGHT can answer for: its own session's seats other than FLIGHT itself. */
export function flightOwnSeatIds(config: CcConfig): ReadonlySet<string> {
  const found = flightSeat(config);
  if (found === null) return new Set();
  return new Set(found.session.seats.filter((s) => s.id !== found.seat.id).map((s) => s.id));
}

/** The watch seat has an unended active run and is not held (parked). */
export function flightLive(config: CcConfig, store: Store): boolean {
  const found = flightSeat(config);
  if (found === null) return false;
  const row = store.seatSession(found.seat.id);
  if (
    row === null ||
    row.runId === null ||
    row.state === "parked" ||
    !ACTIVE_SEAT_STATES.includes(row.state)
  )
    return false;
  return store.run(row.runId)?.endedAt === null;
}

/** The wakes a FLIGHT run has had: its claimed wake keys. */
export function flightWakes(store: Store, runId: string): number {
  const prefix = wakeKeyPrefix(runId);
  return Object.keys(store.claimedKeys(runId)).filter((k) => k.startsWith(prefix)).length;
}

export function flightView(config: CcConfig, store: Store, now: number): FlightView {
  const found = flightSeat(config);
  const runId = found === null ? null : (store.seatSession(found.seat.id)?.runId ?? null);
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
            turns:
              runId === null
                ? null
                : { n: flightWakes(store, runId) + 1, max: FLIGHT_MAX_WAKES + 1 },
          },
    decisions: store.flightDecisions(now - FLIGHT_VIEW_MS, FLIGHT_VIEW_LIMIT),
  };
}

/** All nine sections of a session's brief, in order; one never written (or no session) is empty. */
export function flightBriefSections(store: Store, sessionId: string | null): FlightBriefSection[] {
  const rows = new Map(
    (sessionId === null ? [] : store.flightBrief(sessionId)).map((r) => [r.section, r]),
  );
  return FLIGHT_BRIEF_SECTIONS.map((section) => {
    const r = rows.get(section);
    return {
      section,
      title: FLIGHT_BRIEF_TITLES[section],
      text: r?.text ?? "",
      updatedAt: r?.updatedAt ?? null,
      updatedBy: r?.updatedBy ?? null,
    };
  });
}

/** Pending actual plans, including overdue work; a due time never proves completion. */
export function flightScheduleView(
  config: CcConfig,
  store: Store,
  now: number,
): FlightScheduleView {
  const session = flightSeat(config)?.session.id ?? null;
  const entries = (session === null ? [] : store.flightPlans(session))
    .filter((p) => p.status === "pending")
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .map((p) => ({
      ...p,
      title: p.label,
      at: p.dueAt,
      minutesFromNow: Math.ceil((p.dueAt - now) / 60_000),
      overdue: p.dueAt < now,
    }));
  return { session, entries };
}

export function flightBriefView(
  config: CcConfig,
  store: Store,
  lock: TestLockState = NO_LOCK,
  now = Date.now(),
): FlightBriefView {
  const session = flightSeat(config)?.session.id ?? null;
  const drafts = store.drafts(true);
  const rows = crew(config, store, now, lock, () => null).rows;
  const watch = (session === null ? [] : store.flightWatch(session)).filter((entry) => {
    const action = entry.action;
    if (!action) return true;
    if (action.kind === "draft") {
      const draft = store.drafts().find((d) => d.id === action.draftId);
      if (draft?.state !== "pending" || draft.target !== action.target) return false;
      const source = store.draftSource(draft.id);
      if (!source) return true;
      const match = /^person:(\d+):(\d+)$/.exec(source.itemKey);
      const n = match ? store.notification(match[1] as string) : null;
      return (
        !!n &&
        n.unread &&
        n.updatedAt === Number(match?.[2]) &&
        (n.handledThrough === null || n.updatedAt > n.handledThrough) &&
        JSON.stringify(n.message?.source) === JSON.stringify(source.source)
      );
    }
    const h = lock.holder;
    return (
      h !== null &&
      h.runId === action.runId &&
      h.since === action.since &&
      store
        .lockHolds()
        .some(
          (r) =>
            r.runId === action.runId &&
            r.toolUseId === action.toolUseId &&
            r.since === action.since,
        ) &&
      store.run(action.runId)?.endedAt === null &&
      store.seatSession(h.seatId)?.runId === action.runId &&
      rows.some((r) => r.id === h.seatId && r.hudState === "stalled") &&
      lock.waiting.length > 0
    );
  });
  return {
    session,
    sections: flightBriefSections(store, session),
    watch,
    drafts,
    planned: flightScheduleView(config, store, now).entries,
  };
}

/** Source records supply identity and text; a notification alone never implies an action. */
export function flightArrivalSource(
  config: CcConfig,
  store: Store,
  operation: FlightArrivalOperation,
): Pick<FlightArrivalDisposition, "text" | "arrivedAt"> | null {
  if (operation.source === "Board") {
    const repo = flightSeat(config)?.session.repoId;
    const card =
      repo === undefined
        ? undefined
        : store.board(repo).find((c) => `${repo}#${c.issueNumber}` === operation.arrivalId);
    return card && String(card.createdAt) === operation.version
      ? { text: card.title, arrivedAt: card.createdAt }
      : null;
  }
  const n = store.notification(operation.arrivalId);
  const source = n?.message?.source;
  if (
    !n ||
    n.repoId !== flightSeat(config)?.session.repoId ||
    (operation.source === "Teams" ? source?.kind !== "teams" : source?.kind === "teams") ||
    operation.version !== (source?.revision ?? String(n.updatedAt))
  )
    return null;
  // Keep Teams triage with the source revision, independent of the capped outcome log.
  if (
    operation.source === "Teams" &&
    n.message?.disposition === "digest" &&
    operation.outcome !== "Queued"
  ) {
    store.upsertNotifications(
      [
        {
          ...n,
          message: { ...n.message, triagedVersion: operation.version },
        },
      ],
      false,
      n.firstSeenAt,
    );
  }
  return { text: n.title, arrivedAt: n.updatedAt };
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

/** FLIGHT has received `s`: each merged or closed PR in it is not listed again, nor a hold re-announced. */
export function markPrsShown(store: Store, s: FlightState): void {
  const shown = shownPrs(store);
  for (const h of s.holds) {
    if (h.prState !== "open") store.markHoldTold(h.ref, h.prState);
  }
  for (const p of s.prs) {
    if (p.state !== "open") shown.add(shownKey({ repoId: s.repo, number: p.pr, state: p.state }));
  }
}

/** The facts a delivered state leaves behind: the PRs that will leave the list are not counted. */
export const deliveredFacts = (s: FlightState): string =>
  wakeFacts({
    ...s,
    prs: s.prs.filter((p) => p.state === "open"),
    holds: s.holds.map((h) => ({ ...h, told: true })),
  });

/** The crew as FLIGHT sees it: its session's other seats, their questions, tickets, PRs and limits. */
export function flightState(i: {
  config: CcConfig;
  store: Store;
  busy: readonly SeatBusy[];
  now: number;
  hubLogin?: string | null;
  lock?: TestLockState;
}): FlightState & TeamsDigestState & { discussions: ItemDiscussion[] } {
  const { config, store, busy, now } = i;
  const discussions = store.pendingDiscussions();
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
  // brief edits stay out of `recent`: the brief itself is in the state, and edits would crowd it
  const recent = store
    .flightDecisions(0, FLIGHT_RECENT_LISTED * 4)
    .filter((d) => d.kind !== "brief")
    .slice(0, FLIGHT_RECENT_LISTED)
    .map((d) => ({
      time: clockHm(d.at, tz),
      kind: d.kind,
      about: d.about,
      decision: d.decision,
    }));
  const brief = flightBriefSections(store, found?.session.id ?? null).map((b) => ({
    section: b.section,
    title: b.title,
    text: b.text,
    ageMin: b.updatedAt === null ? null : Math.floor((now - b.updatedAt) / 60_000),
  }));
  if (found === null) {
    return {
      discussions,
      time: clockHm(now, tz),
      repo: "",
      lane: config.crew?.lane ?? null,
      hubLogin: i.hubLogin ?? null,
      seats: [],
      aside: [],
      questions: [],
      tickets: [],
      prs: [],
      items: [],
      holds: [],
      recent,
      limits,
      brief,
    };
  }
  const { session } = found;
  const board = store.board(session.repoId);
  const crewRows = crew(config, store, now, i.lock ?? NO_LOCK, () => null).rows;
  const stalled = stalledSeats(config, store, now, crewRows);
  const mine = session.seats.filter((s) => s.id !== found.seat.id && !s.retiring);
  const unended = (seatId: string) => {
    const runId = store.seatSession(seatId)?.runId ?? null;
    const run = runId === null ? null : store.run(runId);
    return run !== null && run.endedAt === null ? run : null;
  };
  const open = store.openQuestions();
  const briefs = store.briefs();

  const seats = mine.map((s): FlightSeatState => {
    const row = store.seatSession(s.id);
    const run = unended(s.id);
    const loop = run?.loop ?? null;
    const t = run?.ticket == null ? null : parseTicket(run.ticket);
    const last = row?.lastTurnEndedAt ?? null;
    return {
      id: s.id,
      runId: run?.id ?? null,
      call: seatCallSign(s.id),
      role: s.role,
      loop: seatDef(s).loop,
      area: s.area,
      state: row?.state ?? null,
      free: seatFree(store, busy, s.id),
      ticket: run?.ticket ?? null,
      title: t === null ? null : (board.find((b) => b.issueNumber === t.number)?.title ?? null),
      phase: loop?.phase ?? null,
      parked: run === null ? null : parkOf(store, run),
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
        ((briefs.get(`ask:${q.id}`)?.at ?? -1) < q.at ||
          briefs.get(`ask:${q.id}`)?.for === "flight") &&
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
        arrival: {
          source: "Board" as const,
          arrivalId: `${b.repoId}#${b.issueNumber}`,
          version: String(b.createdAt),
          arrivedAt: b.createdAt,
        },
        title: b.title,
        column,
        priority: b.priority,
        labels: b.labels,
        ready: column === "Ready" || b.labels.includes(READY_LABEL),
        blockedBy: b.blockedBy.filter((x) => x.closed).map((x) => x.ref),
        laneLabel: b.labels.find((l) => l.startsWith(LANE_LABEL_PREFIX)) ?? null,
        assignees: b.assignees ?? [],
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
      const reviewed = store.latestReportedReview(session.repoId, p.number);
      return {
        ref: p.ticket ?? holder?.ticket ?? "",
        pr: p.number,
        seat: holder?.agentId ?? "",
        runId: holder?.id ?? "",
        ready: holder !== undefined && ready.has(holder.id),
        state: p.state,
        headSha: p.headSha,
        readAt: clockHm(store.pullRequestReadAt(session.repoId, p.number) ?? 0, tz),
        stale: stale.has(p.number),
        review:
          reviewed?.verdict == null
            ? null
            : { ...reviewed.verdict, blocking: reviewed.blocking, sha: reviewed.sha },
        failingChecks: (p.checks ?? []).filter((c) => c.state === "failing").map((c) => c.name),
      };
    });

  const aside = store
    .loopRuns(now)
    .filter(
      (r) =>
        r.endedAt === null &&
        r.loop?.aside != null &&
        r.repoId === session.repoId &&
        mine.some((s) => s.id === r.agentId),
    )
    .map((r) => ({
      runId: r.id,
      seat: r.agentId,
      ticket: r.ticket ?? null,
      phase: r.loop?.phase ?? "working",
      parked: parkOf(store, r),
    }));

  const prStates = new Map<number, FlightState["prs"][number]["state"]>(
    store.pullRequests(session.repoId).map((p) => [p.number, p.state]),
  );
  // A hold ends when the board has moved its card past Backlog (or closed or dropped it). A PR
  // gone from the stored read is reported as unknown, for FLIGHT to check.
  const holds = store.activeHolds().flatMap((h) => {
    const card = board.find((b) => `${b.repoId}#${b.issueNumber}` === h.ref);
    // The stored board lags the move to Backlog until the next poll, so a card is only past its
    // hold once the board has shown it in Backlog.
    // a card a run has taken is past its hold, wherever the board shows it
    if (
      card === undefined ||
      card.closed ||
      active.has(h.ref) ||
      (h.seen && hudColumnOf(card) !== "Backlog")
    ) {
      store.releaseHold(h.ref, now);
      return [];
    }
    if (!h.seen && hudColumnOf(card) === "Backlog") store.markHoldSeen(h.ref);
    const prState: FlightState["holds"][number]["prState"] = prStates.get(h.waitsOn) ?? "unknown";
    return [
      {
        ref: h.ref,
        waitsOn: h.waitsOn,
        ageMin: Math.floor((now - h.at) / 60_000),
        prState,
        told: h.toldState === prState,
      },
    ];
  });

  const outcomes = store.flightIncoming();
  const digestMatches = store.notifications().flatMap((n) => {
    const message = n.message;
    if (
      n.repoId !== session.repoId ||
      message?.source.kind !== "teams" ||
      message.disposition !== "digest" ||
      message.triagedVersion === message.source.revision ||
      !n.unread ||
      (n.handledThrough !== null && n.updatedAt <= n.handledThrough)
    )
      return [];
    // Backfill matches triaged before the durable marker was introduced.
    if (
      outcomes.some(
        (o) =>
          o.source === "Teams" && o.arrivalId === n.id && o.version === message.source.revision,
      )
    ) {
      store.upsertNotifications(
        [
          {
            ...n,
            message: { ...message, triagedVersion: message.source.revision },
          },
        ],
        false,
        n.firstSeenAt,
      );
      return [];
    }
    return [
      {
        text: cut(message.text, FLIGHT_ABOUT_MAX),
        url: message.url,
        arrival: {
          source: "Teams" as const,
          arrivalId: n.id,
          version: message.source.revision,
          arrivedAt: n.updatedAt,
        },
      },
    ];
  });

  const flightId = found.seat.id;
  const questionKeys = new Set(
    open
      .filter(
        (q) => q.agentId !== flightId && q.passedAt === null && store.run(q.runId)?.endedAt == null,
      )
      .map((q) => `ask:${q.id}`),
  );
  const items = operatorItems(config, store, now, i.hubLogin ?? null, crewRows, i.lock)
    .filter(
      (x) =>
        !x.brief &&
        !ownReply(x, flightId) &&
        (!x.key.startsWith("ask:") || questionKeys.has(x.key)),
    )
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, FLIGHT_ITEMS_LISTED)
    .map((x) => ({
      key: x.key,
      kind: x.kind,
      ticket: x.ticket,
      text: cut(x.text, FLIGHT_ABOUT_MAX),
      ageMin: Math.floor((now - x.at) / 60_000),
      triageRemainingMs: Math.max(
        0,
        (x.triageDueAt ?? x.at + (x.kind === "pr" ? PR_WAIT_MS : 0) + FLIGHT_TRIAGE_WAIT_MS) - now,
      ),
    }));

  const planned = flightScheduleView(config, store, now).entries;
  return {
    ...(planned.length > 0 ? { planned } : {}),
    discussions,
    time: clockHm(now, tz),
    ...(digestMatches.length > 0
      ? {
          teamsDigest: {
            title: `Teams: ${digestMatches.length} matches to triage`,
            matches: digestMatches,
          },
        }
      : {}),
    repo: session.repoId,
    lane: config.crew?.lane ?? null,
    hubLogin: i.hubLogin ?? null,
    seats,
    aside,
    questions,
    tickets,
    prs,
    items,
    holds,
    recent,
    limits,
    brief,
  };
}

/** A run's park, as FLIGHT reads it; null when it is not parked. A ruling park carries the seat's last report. */
const parkOf = (store: Store, run: Run): FlightPark | null => {
  if (run.loop?.phase !== "parked") return null;
  const kind = run.loop.parked?.kind ?? "";
  const park: FlightPark = { kind, reason: run.loop.parked?.reason ?? "" };
  if (FLIGHT_REPORT_PARKS.includes(kind)) {
    const report = store.latestEvidence(run.id)?.note;
    if (report !== undefined) park.report = cut(report, FLIGHT_REPORT_MAX);
  }
  return park;
};

/** What a wake is about, as a stable string (no times): it changes only when something new needs FLIGHT. */
export function wakeFacts(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
): string {
  const startable = s.tickets.filter((t) => t.ready);
  const free =
    startable.length > 0
      ? s.seats.filter((x) => x.loop === "build" && x.free).map((x) => x.id)
      : [];
  return JSON.stringify({
    discussions: s.discussions?.map((t) => [t.id, t.messages.map((m) => m.id)]),
    planned: (s.planned ?? [])
      .filter((p) => p.minutesFromNow <= 0)
      .map((p) => [p.id, p.dueAt, p.kind, p.target, p.label]),
    teams: s.teamsDigest?.matches.map((m) => [m.arrival.arrivalId, m.arrival.version]) ?? [],
    q: s.questions.map((q) => q.id).sort((a, b) => a - b),
    free: free.sort(),
    t: free.length > 0 ? startable.map((t) => t.ref) : [],
    parked: [
      ...s.seats
        .filter((x) => x.parked !== null)
        .map((x) => `${x.id}:${x.ticket}:${x.parked?.kind}`),
      ...s.aside
        .filter((x) => x.parked !== null)
        .map((x) => `${x.seat}:${x.ticket}:${x.parked?.kind}`),
    ].sort(),
    stopped: stoppedSeats(s),
    prs: s.prs.map((p) => `${p.ref}:${p.pr}:${p.ready}:${p.state}`).sort(),
    items: s.items.map((x) => x.key).sort(),
    release: releasable(s),
  });
}

/** The held cards whose PR has merged or closed, ready for FLIGHT to promote again. */
const releasable = (s: FlightState): string[] =>
  s.holds
    .filter((h) => h.prState !== "open" && !h.told)
    .map((h) => `${h.ref}:${h.waitsOn}:${h.prState}`)
    .sort();

/** The build seats left stopped, which only a start (or the operator) brings back into rotation. */
const stoppedSeats = (s: FlightState): string[] =>
  s.seats
    .filter((x) => x.loop === "build" && x.state === "stopped")
    .map((x) => x.id)
    .sort();

/** A park FLIGHT acts on: one it may lift, or a CI ruling it may settle. */
const flightParkKind = (kind: string): boolean =>
  kind === RULING_PARK || (FLIGHT_UNPARK_KINDS as readonly string[]).includes(kind);

/** Something still waits on FLIGHT: a question, an item to brief, a free or stopped build seat, or a park in FLIGHT_UNPARK_KINDS. */
export function pending(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
): boolean {
  return (
    (s.planned?.some((p) => p.minutesFromNow <= 0) ?? false) ||
    (s.discussions?.length ?? 0) > 0 ||
    (s.teamsDigest?.matches.length ?? 0) > 0 ||
    s.questions.length > 0 ||
    s.items.length > 0 ||
    releasable(s).length > 0 ||
    stoppedSeats(s).length > 0 ||
    (s.tickets.some((t) => t.ready) && s.seats.some((x) => x.loop === "build" && x.free)) ||
    s.seats.some((x) => x.parked !== null && flightParkKind(x.parked.kind)) ||
    s.aside.some((x) => x.parked !== null && flightParkKind(x.parked.kind))
  );
}
