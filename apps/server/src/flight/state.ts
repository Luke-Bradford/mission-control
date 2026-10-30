/**
 * The FLIGHT seat as the rest of the hub sees it: which seat it is, whether it is running, and
 * what `GET /api/flight` shows (the seat and the last day's decisions); and the crew as FLIGHT
 * reads it (`flightState`, the wake digest and the `flight_state` tool).
 */
import { createHash } from "node:crypto";
import {
  type AttentionItem,
  clockHm,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_HEADLINE,
  FLIGHT_HOUR_MS,
  FLIGHT_ITEMS_LISTED,
  FLIGHT_LEDGER_INDEX_MAX,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_MAX_WAKES,
  FLIGHT_MEMORY_HEADING,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_RECALL_MAX,
  FLIGHT_MEMORY_TITLES_MAX,
  FLIGHT_MESSAGES_PER_HOUR,
  FLIGHT_METRICS_DAY_MS,
  FLIGHT_NOT_TRIAGING_KEY,
  FLIGHT_NOTE_SECTIONS,
  FLIGHT_RECENT_LISTED,
  FLIGHT_REPORT_MAX,
  FLIGHT_REPORT_PARKS,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTABLE,
  FLIGHT_STARTS_PER_HOUR,
  FLIGHT_STATE_DECISION_MAX,
  FLIGHT_STATE_TEXT_MAX,
  FLIGHT_TICKETS_LISTED,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_VIEW_LIMIT,
  FLIGHT_WAKE_SETTING,
  type FlightArrivalDisposition,
  type FlightArrivalOperation,
  type FlightBriefSection,
  type FlightBriefView,
  type FlightMemoryKind,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightPark,
  type FlightScheduleView,
  type FlightSeatState,
  type FlightState,
  type FlightView,
  type FlightWake,
  type FlightWakeList,
  type FlightWakeStatus,
  hudColumnOf,
  type ItemDiscussion,
  inLane,
  LANE_LABEL_PREFIX,
  OWNER_FLIGHT,
  OWNER_OPERATOR,
  orderLedger,
  priorityRank,
  READY_LABEL,
  RULING_PARK,
  type Run,
  seatCallSign,
  seatDef,
  type TestLockState,
  wakeKeyPrefix,
} from "@mc/core";
import { runAccountId } from "../account-bindings.ts";
import { activeAway } from "../away.ts";
import { flightQuestion } from "../comms.ts";
import { type CcConfig, seatUnavailable } from "../config.ts";
import { accountAtStop } from "../engine/queue.ts";
import { attentionItems, crew, NO_CLI_VERSION, NO_LOCK, questionWithOperator } from "../hud.ts";
import type { SeatBusy } from "../runtime/supervisor.ts";
import { parseTicket } from "../runview.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";
import { trustedAuthor } from "./collaborators.ts";
import { controllerDecisions } from "./controller-decisions.ts";
import { linkedMemory } from "./memory.ts";
import { pendingRetrospective } from "./retrospective.ts";
import { flightSeat } from "./seat.ts";
import { flightSignals } from "./signals.ts";
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

/**
 * Operator-owned items, including those temporarily routed to FLIGHT for triage or handling. The
 * "FLIGHT is not triaging" item is the operator's alone: FLIGHT never triages its own lapse.
 */
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
    rows ?? crew(config, store, now, lock, NO_CLI_VERSION).rows,
    hubLogin,
  ).filter(
    (i) =>
      (i.owner === OWNER_OPERATOR || i.owner === OWNER_FLIGHT) && i.key !== FLIGHT_NOT_TRIAGING_KEY,
  );
}

/** All items awaiting FLIGHT triage, before the digest's display cap. */
export function flightTriageItems(
  config: CcConfig,
  store: Store,
  now: number,
  hubLogin: string | null,
  rows?: ReturnType<typeof crew>["rows"],
  lock: TestLockState = NO_LOCK,
): AttentionItem[] {
  const flightId = flightSeat(config)?.seat.id ?? null;
  if (flightId === null) return [];
  // a question passed before #758 without a brief is still FLIGHT's to brief
  const questionKeys = new Set(
    store
      .openQuestions()
      .filter((q) => q.agentId !== flightId && store.run(q.runId)?.endedAt == null)
      .map((q) => `ask:${q.id}`),
  );
  return operatorItems(config, store, now, hubLogin, rows, lock)
    .filter(
      (x) =>
        // a released hold returns the item for a fresh brief: the old one predates the wait
        (!x.brief || (x.holdReleasedAt !== undefined && x.brief.at < x.holdReleasedAt)) &&
        !ownReply(x, flightId) &&
        (!x.key.startsWith("ask:") || questionKeys.has(x.key)),
    )
    .filter((item) => item.kind !== "message" || flightQuestion(item.text));
}

export function flightHeadline(
  store: Store,
  session: string | null,
  now: number,
): Pick<FlightState, "headline" | "headlineAgeMin"> {
  const row =
    session === null
      ? undefined
      : store.flightBrief(session).find((r) => r.section === FLIGHT_HEADLINE);
  return {
    headline: row?.text ?? "",
    headlineAgeMin: !row?.text ? null : Math.floor((now - row.updatedAt) / 60_000),
  };
}

/**
 * The tickets FLIGHT may start in an hour: FLIGHT_STARTS_PER_HOUR per developer (build) seat in its
 * session, and never fewer. The cap guards against a runaway FLIGHT, so it grows with the seats.
 */
export function flightStartCap(config: CcConfig): number {
  const devSeats = (flightSeat(config)?.session.seats ?? []).filter(
    (s) => !s.retiring && !seatUnavailable(s) && seatDef(s).loop === "build",
  ).length;
  return FLIGHT_STARTS_PER_HOUR * Math.max(1, devSeats);
}

export { flightSeat };

/** The seats whose run the HUD shows as stalled. */
export function stalledSeats(
  config: CcConfig,
  store: Store,
  now: number,
  rows = crew(config, store, now, NO_LOCK, NO_CLI_VERSION).rows,
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

/** Whether a seat's CLI session is alive; null when the hub cannot tell (`Supervisor.sessionAlive`). */
export type SessionAlive = (seatId: string) => boolean | null;

/**
 * The watch seat has an unended active run and is not held (parked). With `alive`, a run the hub
 * holds no live session for is not live, whatever its row says; null from `alive` (the hub cannot
 * tell yet, as during a restart's take-back) leaves it to the row.
 */
export function flightLive(config: CcConfig, store: Store, alive?: SessionAlive): boolean {
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
  if (store.run(row.runId)?.endedAt !== null) return false;
  return alive?.(found.seat.id) !== false;
}

/** The wakes a FLIGHT run has had: its claimed wake keys. */
export function flightWakes(store: Store, runId: string): number {
  const prefix = wakeKeyPrefix(runId);
  return Object.keys(store.claimedKeys(runId)).filter((k) => k.startsWith(prefix)).length;
}

/** What the watch keeps of FLIGHT's wakes: the last one, and the next one while it is scheduled. */
interface WakeRecord {
  repo: string;
  at: number;
  wokeOn: string[];
  next: number | null;
}

function readWakeRecord(store: Store, repo: string): WakeRecord | null {
  try {
    const r = JSON.parse(store.getSetting(FLIGHT_WAKE_SETTING) ?? "null") as WakeRecord | null;
    return r !== null && r.repo === repo && Number.isFinite(r.at) && Array.isArray(r.wokeOn)
      ? r
      : null;
  } catch {
    return null;
  }
}

/** Records a wake: its time, the session's repo and what woke FLIGHT. */
export function recordFlightWake(store: Store, repo: string, at: number, wokeOn: string[]): void {
  const record: WakeRecord = { repo, at, wokeOn, next: null };
  store.setSetting(FLIGHT_WAKE_SETTING, JSON.stringify(record));
}

/** Records when FLIGHT will next wake (null when nothing is scheduled); only changes are written. */
export function recordNextFlightWake(store: Store, repo: string, next: number | null): void {
  const r = readWakeRecord(store, repo);
  if (r === null || r.next === next) return;
  store.setSetting(FLIGHT_WAKE_SETTING, JSON.stringify({ ...r, next }));
}

/** The next wake the state schedules: the re-wake backstop while work is pending, or a planned entry. */
export function nextWakeAt(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
  lastWakeAt: number,
  now: number,
): number | null {
  const times: number[] = [];
  if (lastWakeAt > 0 && pending(s)) times.push(lastWakeAt + FLIGHT_REWAKE_MS);
  for (const p of s.planned ?? []) if (p.minutesFromNow > 0) times.push(p.dueAt);
  return times.length === 0 ? null : Math.min(...times.map((t) => Math.max(t, now)));
}

function flightWakeStatus(store: Store, repo: string, live: boolean): FlightWakeStatus {
  const r = readWakeRecord(store, repo);
  return {
    lastWakeAt: r?.at ?? null,
    wokeOn: r?.wokeOn ?? null,
    // a stopped FLIGHT wakes on no schedule
    nextWakeAt: live ? (r?.next ?? null) : null,
  };
}

export function flightView(
  config: CcConfig,
  store: Store,
  now: number,
  alive?: SessionAlive,
): FlightView {
  const found = flightSeat(config);
  const runId = found === null ? null : (store.seatSession(found.seat.id)?.runId ?? null);
  const live = found === null ? false : flightLive(config, store, alive);
  const decisions = store.flightDecisions(now - FLIGHT_METRICS_DAY_MS, FLIGHT_DECISIONS_SCAN_LIMIT);
  const controller = found === null ? [] : controllerDecisions(decisions);
  return {
    seat:
      found === null
        ? null
        : {
            id: found.seat.id,
            call: seatCallSign(found.seat.id),
            model: found.seat.model,
            state: store.seatSession(found.seat.id)?.state ?? null,
            live,
            turns:
              runId === null
                ? null
                : { n: flightWakes(store, runId) + 1, max: FLIGHT_MAX_WAKES + 1 },
          },
    decisions: decisions.slice(0, FLIGHT_VIEW_LIMIT),
    controllerDecisions: controller,
    ...(found === null ? {} : { wake: flightWakeStatus(store, found.session.repoId, live) }),
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
  rows = crew(config, store, now, lock, NO_CLI_VERSION).rows,
): FlightBriefView {
  const session = flightSeat(config)?.session.id ?? null;
  const drafts = store.drafts(true);
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
    signals: [],
    retrospective: undefined,
    triage: [],
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
      id: d.id,
      time: clockHm(d.at, tz),
      kind: d.kind,
      about: cut(d.about, FLIGHT_STATE_TEXT_MAX),
      decision: cut(d.decision, FLIGHT_STATE_DECISION_MAX),
    }));
  const headline = flightHeadline(store, found?.session.id ?? null, now);
  const openLedger = orderLedger(found === null ? [] : store.flightLedger(found.session.id)).filter(
    (e) => FLIGHT_LEDGER_OPEN.includes(e.status),
  );
  const ledger = openLedger
    .slice(0, FLIGHT_LEDGER_INDEX_MAX)
    .map(({ kind, key, title, status, next }) => ({ kind, key, title, status, next }));
  const notes: readonly string[] = FLIGHT_NOTE_SECTIONS;
  const brief = flightBriefSections(store, found?.session.id ?? null)
    .filter((b) => notes.includes(b.section))
    .map((b) => ({
      section: b.section,
      title: b.title,
      text: b.text,
      ageMin: b.updatedAt === null ? null : Math.floor((now - b.updatedAt) / 60_000),
    }));
  if (found === null) {
    return {
      discussions,
      signals: [],
      triage: [],
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
      ...headline,
      ledger,
      ledgerMore: openLedger.length - ledger.length,
    };
  }
  const { session } = found;
  const repo = config.repos.find((r) => r.id === session.repoId);
  const board = store.board(session.repoId);
  const crewRows = crew(config, store, now, i.lock ?? NO_LOCK, NO_CLI_VERSION).rows;
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
      free: !seatUnavailable(s) && seatFree(store, busy, s.id),
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
      atStop: accountAtStop(config, store, runAccountId(store, run?.id ?? null, s.accountId), now),
    };
  });

  const questions = open
    .filter(
      (q) =>
        !questionWithOperator(q, briefs.get(`ask:${q.id}`)) &&
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
        untrustedAuthor: !trustedAuthor(store, repo?.github ?? "", b.author, now),
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
  // in the full state until it merges or closes. A PR that left the open state is listed once.
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
        untrustedAuthor: !trustedAuthor(store, repo?.github ?? "", p.author, now),
        seat: holder?.agentId ?? "",
        runId: holder?.id ?? "",
        ready: holder !== undefined && ready.has(holder.id),
        awaitingFlight: holder?.loop?.awaitingFlight ?? null,
        ...(activeAway(store, now, tz) &&
        holder?.loop?.awayBugDecision?.headSha === p.headSha &&
        holder?.loop?.awayBugDecision
          ? { awayBugDecision: holder.loop.awayBugDecision }
          : {}),
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
        text: cut(message.text, FLIGHT_STATE_TEXT_MAX),
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

  const items = flightTriageItems(config, store, now, i.hubLogin ?? null, crewRows, i.lock)
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, FLIGHT_ITEMS_LISTED)
    .map((x) => ({
      key: x.key,
      kind: x.kind,
      ticket: x.ticket,
      text: cut(x.text, FLIGHT_STATE_TEXT_MAX),
      ageMin: Math.floor((now - x.at) / 60_000),
      triageRemainingMs: Math.max(0, (x.triageDueAt ?? now) - now),
      ...(x.holdReleased === undefined ? {} : { holdReleased: x.holdReleased }),
    }));

  const planned = flightScheduleView(config, store, now).entries;
  return {
    ...flightSignals({ config, store, session, seats, now }),
    memory: store.flightMemoryTitles(session.repoId),
    retrospective: pendingRetrospective(store, session.repoId, now, tz),
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
    ...headline,
    ledger,
    ledgerMore: openLedger.length - ledger.length,
  };
}

export interface FlightWakeSnapshot {
  linked: Map<string, string>;
  memory: Map<string, string>;
  signals: Map<string, string>;
  brief: Map<string, string>;
  headlineHash: string;
  briefVersion: number;
  recent: Map<string, string>;
  prs: Map<string, string>;
  seats: Map<string, string>;
  ledger: Map<string, string>;
  tickets: Map<string, string>;
}

const entryHash = (entry: unknown): string =>
  createHash("sha256").update(JSON.stringify(entry)).digest("hex");

/** Prepare a wake without advancing the snapshot: only a delivered wake or tool read does that. */
export function flightWake(
  state: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
  previous?: FlightWakeSnapshot,
  notes: FlightMemoryNote[] = [],
  fullRead = false,
): { digest: FlightWake; snapshot: FlightWakeSnapshot } {
  const {
    brief,
    headline,
    recent,
    prs,
    seats,
    ledger,
    tickets,
    signals,
    memory = [],
    ...rest
  } = state;
  const briefHashes = new Map(
    brief.map(({ ageMin: _ageMin, ...note }) => [note.section, entryHash(note)]),
  );
  const changedNotes = brief.filter(
    (note) => previous?.brief.get(note.section) !== briefHashes.get(note.section),
  );
  const headlineHash = entryHash(headline);
  const changedHeadline = previous?.headlineHash !== headlineHash;
  const briefVersion =
    (previous?.briefVersion ?? 0) + (changedHeadline || changedNotes.length > 0 ? 1 : 0);
  const snapshot: FlightWakeSnapshot = {
    linked: new Map(previous?.linked),
    memory: new Map(),
    signals: new Map(),
    brief: briefHashes,
    headlineHash,
    briefVersion,
    recent: new Map(),
    prs: new Map(),
    seats: new Map(),
    ledger: new Map(),
    tickets: new Map(),
  };
  const changed = <T>(
    list: "recent" | "prs" | "seats" | "ledger" | "tickets" | "signals" | "memory",
    entries: T[],
    key: (entry: T) => string,
    // Poll times and age counters stay in sent entries, but do not make an entry new.
    content: (entry: T) => unknown = (entry) => entry,
  ): FlightWakeList<T> => {
    const kept = entries.filter((entry) => {
      const id = key(entry);
      const hash = entryHash(content(entry));
      snapshot[list].set(id, hash);
      return previous?.[list].get(id) !== hash;
    });
    return {
      entries: kept,
      unchanged: entries.length - kept.length,
      removed: [...(previous?.[list].keys() ?? [])].filter((id) => !snapshot[list].has(id)),
    };
  };
  const signalChanges = changed(
    "signals",
    signals,
    (s) => `${s.kind}:${s.key}`,
    (s) => (s.told ? { kind: s.kind, key: s.key, told: s.told } : s),
  );
  const memoryChanges = changed("memory", memory, (n) => `${n.kind}:${n.topic}`);
  const titles = Object.fromEntries(
    FLIGHT_MEMORY_KINDS.map((kind) => {
      const changes = memoryChanges.entries.filter((n) => n.kind === kind);
      const entries = changes.slice(0, FLIGHT_MEMORY_TITLES_MAX);
      // Omitted titles have not been delivered; keep them eligible for the next wake.
      for (const note of fullRead ? [] : changes.slice(FLIGHT_MEMORY_TITLES_MAX)) {
        const key = `${kind}:${note.topic}`;
        const prior = previous?.memory.get(key);
        if (prior === undefined) snapshot.memory.delete(key);
        else snapshot.memory.set(key, prior);
      }
      return [
        kind,
        {
          entries,
          more: changes.length - entries.length,
          unchanged: memory.filter((n) => n.kind === kind).length - changes.length,
          removed: memoryChanges.removed
            .filter((key) => key.startsWith(`${kind}:`))
            .map((key) => key.slice(kind.length + 1)),
        },
      ];
    }),
  ) as Record<FlightMemoryKind, FlightWakeList<FlightMemoryTitle> & { more: number }>;
  const linkedHash = ({ updatedAt: _updatedAt, ...note }: FlightMemoryNote): string =>
    entryHash(note);
  const linkedChanges = linkedMemory(notes, state).filter(
    (note) => previous?.linked.get(note.topic.toLowerCase()) !== linkedHash(note),
  );
  const linked = linkedChanges.slice(0, FLIGHT_MEMORY_RECALL_MAX);
  for (const note of linked) snapshot.linked.set(note.topic.toLowerCase(), linkedHash(note));
  const ticketChanges = changed("tickets", tickets.slice(0, FLIGHT_TICKETS_LISTED), (t) => t.ref);
  return {
    snapshot,
    digest: {
      ...rest,
      memory: {
        heading: FLIGHT_MEMORY_HEADING,
        titles,
        linked,
        linkedMore: linkedChanges.length - linked.length,
      },
      signals: signalChanges,
      ...(changedNotes.length > 0 ? { brief: changedNotes } : {}),
      ...(changedHeadline ? { headline } : {}),
      briefVersion,
      recent: changed("recent", recent, (d) => String(d.id)),
      prs: changed(
        "prs",
        prs,
        (p) => String(p.pr),
        ({ readAt: _readAt, ...pr }) => pr,
      ),
      seats: changed(
        "seats",
        seats,
        (s) => s.id,
        ({ idleMin: _idleMin, ...seat }) => seat,
      ),
      ledger: changed("ledger", ledger, (e) => e.key),
      tickets: {
        ...ticketChanges,
        entries: ticketChanges.entries.map((t) =>
          !t.ready && (t.column === "Backlog" || t.column === "Refinement")
            ? `${t.ref.slice(t.ref.lastIndexOf("#"))} ${t.untrustedAuthor ? "[untrusted] " : ""}${t.title}`
            : t,
        ),
      },
      facts: JSON.parse(wakeFacts(state)) as FlightWake["facts"],
    },
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
    retrospective: s.retrospective ? [s.retrospective.day] : [],
    signals: s.signals
      .filter((s) => !s.told)
      .map((s) => `${s.kind}:${s.key}`)
      .sort(),
    triage: s.triage.map((t) => `${t.ref}:${t.cause}`).sort(),
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
    prs: s.prs
      .map(
        (p) =>
          `${p.ref}:${p.pr}:${p.ready}:${p.state}:${p.awaitingFlight ?? ""}:${p.awayBugDecision?.about ?? ""}`,
      )
      .sort(),
    items: s.items
      .map((x) => (x.kind === "pr" ? `${x.key.replace(/:\d+$/, "")}:${x.text}` : x.key))
      .sort(),
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
  kind === RULING_PARK ||
  kind === "review-failed" ||
  (FLIGHT_UNPARK_KINDS as readonly string[]).includes(kind);

/** Something still waits on FLIGHT: a question, an item to brief, a free or stopped build seat, or a park in FLIGHT_UNPARK_KINDS. */
export function pending(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
): boolean {
  return (
    s.retrospective !== undefined ||
    s.signals.some((s) => !s.told) ||
    s.triage.length > 0 ||
    (s.planned?.some((p) => p.minutesFromNow <= 0) ?? false) ||
    (s.discussions?.length ?? 0) > 0 ||
    (s.teamsDigest?.matches.length ?? 0) > 0 ||
    s.prs.some((p) => p.awaitingFlight != null || p.awayBugDecision != null) ||
    s.questions.length > 0 ||
    s.items.length > 0 ||
    releasable(s).length > 0 ||
    stoppedSeats(s).length > 0 ||
    (s.tickets.some((t) => t.ready) && s.seats.some((x) => x.loop === "build" && x.free)) ||
    s.seats.some((x) => x.parked !== null && flightParkKind(x.parked.kind)) ||
    s.aside.some((x) => x.parked !== null && flightParkKind(x.parked.kind))
  );
}
