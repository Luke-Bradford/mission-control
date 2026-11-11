/**
 * The FLIGHT seat as the rest of the hub sees it: which seat it is, whether it is running, and
 * what `GET /api/flight` shows (the seat and the last day's decisions); and the crew as FLIGHT
 * reads it (`flightState`, the wake digest and the `flight_state` tool).
 */
import { createHash } from "node:crypto";
import {
  ATTENTION_KINDS,
  type AttentionItem,
  areaLabelsFor,
  areaLabelsOf,
  type BoardItem,
  COMMS_CAPCOM,
  COMMS_CONTROLLER,
  carriedFrom,
  claimedByOther,
  clockHm,
  FLIGHT_BRIEF_SECTIONS,
  FLIGHT_BRIEF_TITLES,
  FLIGHT_CONTEXT_ROTATE_TOKENS,
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_HEADLINE,
  FLIGHT_HOUR_MS,
  FLIGHT_IDLE_MS,
  FLIGHT_IDLE_SEAT_WAKE_MS,
  FLIGHT_ITEMS_LISTED,
  FLIGHT_ITEMS_SEEN_SETTING,
  FLIGHT_LEDGER_INDEX_MAX,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_LEFT_HEAD,
  FLIGHT_LEFT_NOTE_KEY,
  FLIGHT_MAX_WAKES,
  FLIGHT_MEMORY_HEADING,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_RECALL_MAX,
  FLIGHT_MEMORY_TITLES_MAX,
  FLIGHT_METRICS_DAY_MS,
  FLIGHT_MOVED_LISTED,
  FLIGHT_NOT_TRIAGING_KEY,
  FLIGHT_NOTE_SECTIONS,
  FLIGHT_OWED_MS,
  FLIGHT_PR_ENTRY_CHANGES,
  FLIGHT_RECENT_LISTED,
  FLIGHT_REPORT_MAX,
  FLIGHT_REPORT_PARKS,
  FLIGHT_REWAKE_MS,
  FLIGHT_STARTABLE,
  FLIGHT_STATE_DECISION_MAX,
  FLIGHT_STATE_TEXT_MAX,
  FLIGHT_TICKETS_LISTED,
  FLIGHT_UNPARK_KINDS,
  FLIGHT_VIEW_LIMIT,
  FLIGHT_VIEW_MS,
  FLIGHT_WAKE_IDLE_MS,
  FLIGHT_WAKE_SETTING,
  type FlightArrivalDisposition,
  type FlightArrivalOperation,
  type FlightBriefSection,
  type FlightBriefView,
  type FlightDecision,
  type FlightIdleSeats,
  type FlightMemoryKind,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightMovedPointer,
  type FlightPark,
  type FlightScheduleView,
  type FlightSeatState,
  type FlightSignal,
  type FlightState,
  type FlightView,
  type FlightWake,
  type FlightWakeHistory,
  type FlightWakeInputs,
  type FlightWakeList,
  type FlightWakeStatus,
  flightContextText,
  hudColumnOf,
  type ItemDiscussion,
  idleLong,
  idlePeriod,
  inLane,
  LANE_LABEL_PREFIX,
  OWNER_FLIGHT,
  OWNER_OPERATOR,
  orderLedger,
  type PaceCheck,
  paceRefusal,
  priorityRank,
  READY_LABEL,
  RULING_PARK,
  type Run,
  reviewFaultStands,
  STUCK_PARK,
  seatCallSign,
  seatDef,
  type TestLockState,
  WAITING_OPERATOR_LABEL,
  wakeKeyPrefix,
} from "@mc/core";
import { runAccountId } from "../accounts/bindings.ts";
import { activeAway } from "../away.ts";
import { flightQuestion } from "../comms/index.ts";
import { type CcConfig, configuredAgents, seatUnavailable } from "../config.ts";
import { pausedSeat, readCrewPause } from "../crew-pause.ts";
import { blockedWork, waitReader } from "../dependencies.ts";
import { accountAtStop } from "../engine/queue.ts";
import {
  attentionItems,
  crew,
  NO_CLI_VERSION,
  NO_LOCK,
  NOTE_KEY,
  questionWithOperator,
} from "../hud.ts";
import {
  MACHINE_CAPACITY_DEFAULTS,
  machineCapacity,
  machineCapacitySince,
} from "../machine-capacity.ts";
import { paceStartCheck, paceView } from "../pace.ts";
import { prFlow, prFlowFacts, prFlowWakeTimes } from "../pr/flow.ts";
import {
  closingFact,
  factsText,
  openQuestionSubjects,
  questionFacts,
  subjectId,
} from "../question-watch.ts";
import { parseTicket } from "../run/view.ts";
import type { SeatBusy } from "../runtime/supervisor.ts";
import { ACTIVE_SEAT_STATES, type Store } from "../store.ts";
import { trustedAuthor } from "./collaborators.ts";
import { controllerDecisions } from "./controller-decisions.ts";
import { flightFinancialFacts, flightWakeCost, flightWakeWaits } from "./cost.ts";
import { linkedMemory } from "./memory.ts";
import { pendingRetrospective } from "./retrospective.ts";
import { runawayTrip } from "./runaway.ts";
import { crewSeatIds, flightSeat } from "./seat.ts";
import { flightSignals, flightWaits } from "./signals.ts";
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

export { prFlow } from "../pr/flow.ts";

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
      (i.owner === OWNER_OPERATOR || i.owner === OWNER_FLIGHT) &&
      i.key !== FLIGHT_NOT_TRIAGING_KEY &&
      // what FLIGHT left undecided is the operator's to read, never FLIGHT's to triage
      i.key !== `${NOTE_KEY}${FLIGHT_LEFT_NOTE_KEY}`,
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
  return (
    operatorItems(config, store, now, hubLogin, rows, lock)
      .filter(
        (x) =>
          // a released hold returns the item for a fresh brief: the old one predates the wait
          (!x.brief ||
            (x.holdReleasedAt !== undefined && x.brief.at < x.holdReleasedAt) ||
            // the entry check refused FLIGHT's operator brief: it is FLIGHT's to rewrite (#1543)
            // (a brief with no `for` is an old one written for the operator)
            (x.returned !== undefined && x.brief.for !== "flight") ||
            // FLIGHT asked again after briefing its own question: the brief covers the first only
            (ownReply(x, flightId) && x.brief.at < x.at)) &&
          // FLIGHT's own @CAPCOM question is listed until FLIGHT briefs it for the operator
          // (Needs you takes no raw question, #1543) or dismisses it
          (!ownReply(x, flightId) ||
            x.returned !== undefined ||
            (x.brief !== undefined && x.brief.at < x.at)) &&
          (!x.key.startsWith("ask:") || questionKeys.has(x.key)),
      )
      .filter((item) => item.kind !== "message" || flightQuestion(item.text))
      // dismiss_item acks an item: as it was, it is dealt with. A returned item the entry check
      // still holds FLIGHT to (not "handling") is protected: the ack was the operator's read
      .filter(
        (item) =>
          item.acked !== true || (item.returned !== undefined && item.flightTriage !== "handling"),
      )
  );
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

export { crewSeatIds, flightSeat };

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
 * A reply or `@CAPCOM` tag FLIGHT itself wrote: not work for FLIGHT, and it reaches Needs you only
 * with FLIGHT's brief (#1543). Listing every one in the digest woke FLIGHT with every reply it
 * wrote; only an unbriefed question is listed. Assumes one live FLIGHT seat (`flightSeat`).
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

/** The fact category a wake cause names: "q (1)" is q; a re-wake for left reasons is "left". */
const causeReason = (cause: string): string =>
  cause.startsWith(FLIGHT_LEFT_HEAD) ? "left" : cause.replace(/ \(\d+\)$/, "");

/** Stores a wake on its run, with the fact categories (not the counts) that caused it. */
export function recordWakeReasons(
  store: Store,
  runId: string,
  at: number,
  causes: string[],
  wakeId?: string,
): void {
  store.addFlightWake(runId, at, [...new Set(causes.map(causeReason))], wakeId);
}

/** FLIGHT has received `s`: the pointers it lists as moved are read, and not listed again. */
export function markPointersShown(
  store: Store,
  config: CcConfig,
  s: FlightState,
  at: number,
): void {
  const session = flightSeat(config)?.session.id;
  const shown = [...(s.moved ?? []), ...(s.wake?.movedCovered ?? [])];
  if (session !== undefined && shown.length > 0) store.markFlightPointersRead(session, shown, at);
}

/** The last day's wakes, by reason and by hour (24 buckets, the last one ending at `now`). */
export function flightWakeHistory(
  store: Store,
  now: number,
  decisions: readonly FlightDecision[] = store.flightDecisions(
    now - FLIGHT_METRICS_DAY_MS,
    FLIGHT_DECISIONS_SCAN_LIMIT,
  ),
): FlightWakeHistory {
  const since = now - FLIGHT_METRICS_DAY_MS;
  const wakes = store.flightWakes(since).filter((w) => w.at <= now);
  const decided = decisions.map((d) => d.at);
  const idle = wakes.filter(
    (w) => !decided.some((at) => at >= w.at && at - w.at <= FLIGHT_WAKE_IDLE_MS),
  ).length;
  const total = new Map<string, number>();
  const perHour = Array.from({ length: 24 }, (_, i) => ({
    at: since + i * FLIGHT_HOUR_MS,
    n: 0,
    byReason: {} as Record<string, number>,
  }));
  for (const w of wakes) {
    const hour = perHour[Math.min(23, Math.floor((w.at - since) / FLIGHT_HOUR_MS))];
    if (hour === undefined) continue;
    hour.n++;
    for (const reason of w.reasons) {
      hour.byReason[reason] = (hour.byReason[reason] ?? 0) + 1;
      total.set(reason, (total.get(reason) ?? 0) + 1);
    }
  }
  return {
    since,
    total: wakes.length,
    idle,
    byReason: [...total]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason)),
    perHour,
  };
}

/** Records when FLIGHT will next wake (null when nothing is scheduled); only changes are written. */
export function recordNextFlightWake(store: Store, repo: string, next: number | null): void {
  const r = readWakeRecord(store, repo);
  if (r === null || r.next === next) return;
  store.setSetting(FLIGHT_WAKE_SETTING, JSON.stringify({ ...r, next }));
}

/**
 * The next wake the state schedules: the hourly re-wake backstop while work is pending, or a
 * planned entry, or the end of the batch window while routine facts wait in it (`batchAt`).
 */
export function nextWakeAt(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
  lastWakeAt: number,
  now: number,
  batchAt?: number,
): number | null {
  const times: number[] = prFlowWakeTimes(s.prFlow).filter((at) => at > lastWakeAt);
  if (lastWakeAt > 0 && pending(s)) times.push(lastWakeAt + FLIGHT_REWAKE_MS);
  for (const p of s.planned ?? []) if (p.minutesFromNow > 0) times.push(p.dueAt);
  if (s.wake?.idle) times.push(idleWakeAt(s.wake.idle));
  if (batchAt !== undefined) times.push(batchAt);
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

/** Cost and wait figures, read from one set of historical facts taken for this response. */
function financialFigures(
  config: CcConfig,
  store: Store,
  now: number,
  found: NonNullable<ReturnType<typeof flightSeat>>,
): Pick<FlightView, "wakeCost" | "wakeWaits"> {
  const crewIds = new Set(
    configuredAgents(config).flatMap((a) => (a.kind === "crew" ? [a.id] : [])),
  );
  const facts = flightFinancialFacts(store, now, new Set([...crewIds, found.seat.id]));
  return {
    wakeCost: flightWakeCost(store, now, found.seat.id, crewIds, undefined, facts),
    wakeWaits: flightWakeWaits(store, now, found.seat.id, found.session.repoId, undefined, facts),
  };
}

export function flightView(
  config: CcConfig,
  store: Store,
  now: number,
  alive?: SessionAlive,
): FlightView {
  const found = flightSeat(config);
  const seat = flightSeatView(config, store, alive);
  const live = seat?.live ?? false;
  const decisions = store.flightDecisions(now - FLIGHT_METRICS_DAY_MS, FLIGHT_DECISIONS_SCAN_LIMIT);
  const controller = found === null ? [] : controllerDecisions(decisions);
  return {
    seat,
    decisions: decisions.slice(0, FLIGHT_VIEW_LIMIT),
    controllerDecisions: controller,
    ...(found === null ? {} : { wake: flightWakeStatus(store, found.session.repoId, live) }),
    ...(found === null ? {} : { wakeHistory: flightWakeHistory(store, now, decisions) }),
    ...(found === null ? {} : financialFigures(config, store, now, found)),
    promptWakes:
      found === null
        ? []
        : store.agentPromptWakes(found.seat.id, now - FLIGHT_VIEW_MS, FLIGHT_VIEW_LIMIT),
    ...(found === null
      ? {}
      : { blocked: blockedWork(store, found.session.repoId, now, inThisLane(config)) }),
  };
}

/** The watch seat alone, for readers that do not need FLIGHT's historical view. */
export function flightSeatView(
  config: CcConfig,
  store: Store,
  alive?: SessionAlive,
): FlightView["seat"] {
  const found = flightSeat(config);
  if (found === null) return null;
  const session = store.seatSession(found.seat.id);
  const runId = session?.runId ?? null;
  const contextTokens = runId === null ? null : (store.digest(runId)?.contextTokens ?? null);
  return {
    id: found.seat.id,
    call: seatCallSign(found.seat.id),
    model: found.seat.model,
    state: session?.state ?? null,
    live: flightLive(config, store, alive),
    turns: runId === null ? null : { n: flightWakes(store, runId) + 1, max: FLIGHT_MAX_WAKES + 1 },
    context:
      runId === null
        ? null
        : {
            tokens: contextTokens,
            rotateAt: FLIGHT_CONTEXT_ROTATE_TOKENS,
            text: flightContextText(contextTokens, FLIGHT_CONTEXT_ROTATE_TOKENS),
          },
  };
}

/** Whether a card is in the hub's lane, as the wake lists cards. */
const inThisLane =
  (config: CcConfig) =>
  (card: Pick<BoardItem, "labels">): boolean =>
    inLane(card.labels, config.crew?.lane, config.crew?.laneDefault ?? false);

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
    // what it shows is seen: the next read lists no item as new
    ...(s.wake === undefined ? {} : { wake: { ...s.wake, fresh: [] } }),
    retrospective: undefined,
    triage: [],
    prs: s.prs.filter((p) => p.state === "open"),
    holds: s.holds.map((h) => ({ ...h, told: true })),
  });

/** The items FLIGHT was last shown, by key, each with a hash of its text. */
const seenItems = (store: Store): Record<string, string> => {
  try {
    return JSON.parse(store.getSetting(FLIGHT_ITEMS_SEEN_SETTING) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
};

const itemHash = (x: { text: string }): string => entryHash(x.text);

/** FLIGHT has received `s`: its items are not new again until their text changes. */
export function markItemsShown(store: Store, s: FlightState): void {
  const seen = Object.fromEntries(wakeItems(s).map((x) => [itemFactId(x), itemHash(x)]));
  if (JSON.stringify(seen) !== JSON.stringify(seenItems(store))) {
    store.setSetting(FLIGHT_ITEMS_SEEN_SETTING, JSON.stringify(seen));
  }
}

/** The wake fact for a queued review an idle review seat has not started; also FLIGHT's `wait_on` target for it. */
export const REVIEW_FAULT_FACT = "idle-reviewers";
/** The wait targets that hold it: the fact, and the wake reason's label (`reviews idle-reviewers`). */
export const REVIEW_FAULT_TARGETS = [REVIEW_FAULT_FACT, `reviews ${REVIEW_FAULT_FACT}`];

/** Whether a recorded wait still holds `target` (a seat id or a ticket ref) back. */
const waitingOn = (waits: Record<string, { until: number }>, target: string, now: number) =>
  Object.entries(waits).some(
    ([name, w]) => w.until > now && name.toLowerCase() === target.toLowerCase(),
  );

/** What `wakeFacts` reads beyond the digest: where a Ready ticket could start, and which items are new. */
function withCovered(inputs: FlightWakeInputs, covered: FlightMovedPointer[]): FlightWakeInputs {
  return covered.length === 0 ? inputs : { ...inputs, movedCovered: covered };
}

/** Unread operator requests stay pending through an outage; only reading them retires this wake. */
export function unreadOperatorComms(store: Store, flightId: string): string[] {
  return [COMMS_CAPCOM, COMMS_CONTROLLER]
    .flatMap((from) => store.unreadCommsFrom(from, flightId, 0))
    .sort((a, b) => Number(a) - Number(b));
}

function wakeInputs(i: {
  /** The slow pace's check while it is on: tickets it refuses are not startable, so wake no one. */
  pace?: PaceCheck | undefined;
  store: Store;
  seats: FlightSeatState[];
  tickets: FlightState["tickets"];
  /** Every open ticket, past the digest's cap: the idle-seat check counts them all. */
  allTickets: FlightState["tickets"];
  items: FlightState["items"];
  areas: Record<string, string[]> | undefined;
  hubLogin: string | null;
  flightId: string | null;
  now: number;
}): FlightWakeInputs {
  const waits = flightWaits(i.store);
  const rules = i.areas === undefined ? null : { areas: i.areas };
  const fits = (seat: FlightSeatState, t: FlightState["tickets"][number]): boolean => {
    if (rules === null || Object.keys(rules.areas).length === 0) return true;
    const label = areaLabelsOf(rules, t);
    return (
      label.length === 1 &&
      areaLabelsFor(rules, seat.area).includes(label[0] ?? "") &&
      !claimedByOther(t, i.hubLogin)
    );
  };
  const pace = i.pace;
  const ready = i.tickets.filter(
    (t) =>
      t.ready &&
      !waitingOn(waits, t.ref, i.now) &&
      (pace === undefined || paceRefusal(pace, t.ref, t.labels) === null),
  );
  const fit: Record<string, string[]> = {};
  for (const seat of i.seats) {
    if (seat.loop !== "build" || waitingOn(waits, seat.id, i.now)) continue;
    fit[seat.id] = ready.filter((t) => fits(seat, t)).map((t) => t.ref);
  }
  const seen = seenItems(i.store);
  const reviewsWaited = REVIEW_FAULT_TARGETS.some((target) => waitingOn(waits, target, i.now));
  const fresh = wakeItems({ items: i.items })
    .filter((x) => seen[itemFactId(x)] !== itemHash(x))
    .map(itemFactId);
  const flightId = i.flightId;
  const operator = flightId === null ? [] : unreadOperatorComms(i.store, flightId);
  // read by FLIGHT and still unanswered after its turn: owed until it replies
  const owed =
    flightId === null
      ? []
      : [COMMS_CAPCOM, COMMS_CONTROLLER]
          .flatMap((from) => i.store.owedCommsFrom(from, flightId, i.now - FLIGHT_OWED_MS))
          .sort((a, b) => Number(a) - Number(b));
  // a seat left idle by the slow pace is the operator's wish, not a fault to wake FLIGHT about
  const idle = i.pace ? undefined : idleSeats(i, waits, rules, fit);
  return idle === undefined
    ? { fit, fresh, operator, owed, reviewsWaited }
    : { fit, fresh, operator, owed, reviewsWaited, idle };
}

/** The setting that keeps when each seat's idle spell began (the hub's own record). */
export const FLIGHT_IDLE_SEAT_SETTING = "flight.idle-seat";

const readIdleSince = (store: Store): Record<string, number> => {
  try {
    const v = JSON.parse(store.getSetting(FLIGHT_IDLE_SEAT_SETTING) || "null") as {
      seats?: Record<string, unknown>;
    } | null;
    return Object.fromEntries(
      Object.entries(v?.seats ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"),
    );
  } catch {
    return {};
  }
};

/**
 * The free build seats that have open tickets near their area (Backlog, Refinement or Ready) and no
 * FLIGHT wait on them or the ticket, read from the board with no FLIGHT tokens. A ticket is near a
 * seat when its one area label is the seat's, or it has none or several (it needs triage). Each
 * seat's spell is timed on its own.
 */
function idleSeats(
  i: Parameters<typeof wakeInputs>[0],
  waits: Record<string, { until: number }>,
  rules: { areas: Record<string, string[]> } | null,
  fit: Record<string, string[]>,
): FlightIdleSeats | undefined {
  // a ticket held behind an open PR is waiting by FLIGHT's own choice, not open work for a seat
  const held = new Set(i.store.activeHolds().map((h) => h.ref));
  const open = i.allTickets.filter((t) => !held.has(t.ref) && !waitingOn(waits, t.ref, i.now));
  const near = (seat: FlightSeatState, t: FlightState["tickets"][number]): boolean => {
    if (rules === null || Object.keys(rules.areas).length === 0) return true;
    if (claimedByOther(t, i.hubLogin)) return false;
    const label = areaLabelsOf(rules, t);
    return label.length !== 1 || areaLabelsFor(rules, seat.area).includes(label[0] ?? "");
  };
  const seats = i.seats
    .filter((x) => x.loop === "build" && x.free && !waitingOn(waits, x.id, i.now))
    .map((x) => ({ id: x.id, near: open.filter((t) => near(x, t)) }))
    .filter((x) => x.near.length > 0);
  if (seats.length === 0) return undefined;
  const tickets = [...new Map(seats.flatMap((x) => x.near).map((t) => [t.ref, t])).values()];
  const stored = readIdleSince(i.store);
  return {
    seats: seats
      .map((x) => {
        const since = stored[x.id] ?? i.now;
        return { id: x.id, since, ms: Math.max(0, i.now - since) };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    open: tickets.map((t) => t.ref).sort(),
    untriaged: tickets
      .filter((t) => t.noStatus === true)
      .map((t) => t.ref)
      .sort(),
    ready: [...new Set(seats.flatMap((x) => fit[x.id] ?? []))].sort(),
  };
}

/**
 * Keeps when each seat's idle spell began: a seat is added when it first idles with tickets open
 * and dropped when it stops. The watcher calls it on each look; reads of the state never write.
 */
export function trackIdleSeat(store: Store, s: Pick<FlightState, "wake">, now: number): void {
  const before = readIdleSince(store);
  const after = Object.fromEntries(
    (s.wake?.idle?.seats ?? []).map((x) => [x.id, before[x.id] ?? now]),
  );
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  store.setSetting(
    FLIGHT_IDLE_SEAT_SETTING,
    Object.keys(after).length === 0 ? "" : JSON.stringify({ seats: after }),
  );
}

/** The log line for the seats idle past a 30-minute period: each one's time, and why nothing started. */
export function idleSeatLine(idle: FlightIdleSeats, seats: FlightIdleSeats["seats"]): string {
  const why =
    idle.ready.length > 0
      ? `Ready ${idle.ready.join(", ")} not started`
      : "no Ready ticket fits; FLIGHT has promoted none and logged no wait";
  const triage =
    idle.untriaged.length > 0 ? ` (${idle.untriaged.length} with no board status)` : "";
  const named = seats.map((x) => `${x.id} ${Math.floor(x.ms / 60_000)} min`).join(", ");
  return `flight watch: seat idle: ${named} with ${idle.open.length} open ticket${idle.open.length === 1 ? "" : "s"}${triage}; why: ${why}`;
}

/** When FLIGHT is next woken about idle seats: the soonest period boundary of any seat. */
export function idleWakeAt(idle: FlightIdleSeats): number {
  return Math.min(
    ...idle.seats.map((x) => {
      const period = idlePeriod(x.ms);
      return (
        x.since + FLIGHT_IDLE_MS + (period === null ? 0 : (period + 1) * FLIGHT_IDLE_SEAT_WAKE_MS)
      );
    }),
  );
}

/** The crew as FLIGHT sees it: its session's other seats, their questions, tickets, PRs and limits. */
export function flightState(i: {
  config: CcConfig;
  store: Store;
  busy: readonly SeatBusy[];
  now: number;
  hubLogin?: string | null;
  lock?: TestLockState;
  /** The repo's area labels and their globs; absent: any Ready ticket fits any build seat. */
  areas?: Record<string, string[]>;
}): FlightState & TeamsDigestState & { discussions: ItemDiscussion[] } {
  const { config, store, busy, now } = i;
  const discussions = store.pendingDiscussions();
  const tz = config.operator.timezone;
  const found = flightSeat(config);
  const trip = runawayTrip(store);
  const breaker = { tripped: trip !== null, reason: trip?.reason ?? null };
  // brief edits stay out of `recent`: the brief itself is in the state, and edits would crowd it
  const recent = store
    .flightDecisions(0, FLIGHT_RECENT_LISTED * 4)
    .filter((d) => d.kind !== "brief")
    .slice(0, FLIGHT_RECENT_LISTED)
    .map((d) => ({
      ...(d.orderId === undefined ? {} : { orderId: d.orderId }),
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
  const movedAll = found === null ? [] : store.movedFlightPointers(found.session.id);
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
      blocked: [],
      time: clockHm(now, tz),
      repo: "",
      lane: config.crew?.lane ?? null,
      hubLogin: i.hubLogin ?? null,
      seats: [],
      aside: [],
      questions: [],
      tickets: [],
      prs: [],
      prFlow: { generatedAt: now, rows: [], unowned: 0, metrics: [] },
      items: [],
      holds: [],
      reviewQueue: { queued: 0, running: 0, seats: [] },
      mergeQueue: [],
      flowHolds: [],
      recent,
      breaker,
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
    const pause = pausedSeat(store, s.id);
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
      free:
        !seatUnavailable(s) &&
        pause === null &&
        row?.state !== "stopped" &&
        seatFree(store, busy, s.id),
      pause: pause === null ? null : { by: pause.by, reason: pause.reason, at: pause.at },
      stop:
        row?.state === "stopped" && row.stop != null
          ? { by: row.stop.by, reason: row.stop.reason, at: row.stop.at }
          : null,
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

  const reviewRows = store
    .reviewsIn(["queued", "starting", "running"])
    .filter((row) => row.repoId === session.repoId);
  const reviewSeats = mine.filter((s) => seatDef(s).loop === "review");
  const reviewQueue = {
    queued: reviewRows.filter((row) => row.state === "queued").length,
    running: reviewRows.filter((row) => row.state === "starting" || row.state === "running").length,
    waitMin: Math.max(
      0,
      ...reviewRows
        .filter((row) => row.state === "queued")
        .map((row) => Math.floor((now - row.createdAt) / 60_000)),
    ),
    seats: reviewSeats.map((seat) => {
      const reviews = reviewRows.filter((row) => row.seatId === seat.id);
      const held = unended(seat.id);
      return {
        seat: seat.id,
        queued: reviews.filter((row) => row.state === "queued").length,
        running: reviews.filter((row) => row.state === "starting" || row.state === "running")
          .length,
        // the oldest review queued on this seat; the engine may re-route it to another seat on its next pass
        waitMin: Math.max(
          0,
          ...reviews
            .filter((row) => row.state === "queued")
            .map((row) => Math.floor((now - row.createdAt) / 60_000)),
        ),
        idle:
          !seatUnavailable(seat) &&
          !accountAtStop(
            config,
            store,
            runAccountId(store, held?.id ?? null, seat.accountId),
            now,
          ) &&
          pausedSeat(store, seat.id) === null &&
          store.seatSession(seat.id)?.state !== "stopped" &&
          held === null &&
          !busy.some((b) => b.seatId === seat.id),
      };
    }),
  };

  const active = store.activeTickets();
  const waitsOf = waitReader(store, session.repoId);
  const openTickets = board
    .filter(
      (b) =>
        !b.closed &&
        !b.labels.includes(WAITING_OPERATOR_LABEL) &&
        inLane(b.labels, config.crew?.lane, config.crew?.laneDefault ?? false) &&
        FLIGHT_STARTABLE.includes(hudColumnOf(b)) &&
        !active.has(`${b.repoId}#${b.issueNumber}`) &&
        waitsOf(b).length === 0,
    )
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.createdAt - b.createdAt ||
        a.issueNumber - b.issueNumber,
    )
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
        ...(b.status.trim() === "" ? { noStatus: true } : {}),
        blockedBy: b.blockedBy.filter((x) => x.closed).map((x) => x.ref),
        laneLabel: b.labels.find((l) => l.startsWith(LANE_LABEL_PREFIX)) ?? null,
        assignees: b.assignees ?? [],
      };
    });
  // the digest lists the first FLIGHT_TICKETS_LISTED; the idle-seat check reads all of them
  const tickets = openTickets.slice(0, FLIGHT_TICKETS_LISTED);

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
      // a merge no longer wakes FLIGHT, so an unshown one waits a day for the next wake to carry it
      (p) =>
        p.state === "open" ||
        (!shown.has(shownKey(p)) && now - p.updatedAt < FLIGHT_METRICS_DAY_MS),
    )
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const holder = holders.find((r) => r.loop?.prNumber === p.number);
      const reviewed = store.latestReportedReview(session.repoId, p.number);
      const carried =
        p.headSha === null
          ? null
          : carriedFrom(holder?.loop?.carry, holder?.loop?.reviewWaivedSha, p.headSha);
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
          reviewed?.verdict == null || (reviewed.sha !== p.headSha && reviewed.sha !== carried)
            ? null
            : { ...reviewed.verdict, blocking: reviewed.blocking, sha: reviewed.sha },
        failingChecks: (p.checks ?? []).filter((c) => c.state === "failing").map((c) => c.name),
      };
    });

  const mergeFacts = new Map(
    store
      .pullRequests(session.repoId)
      .map((pr) => [pr.number, { checks: pr.checks ?? [], mergeable: pr.mergeable }]),
  );
  const flow = prFlow(store, session.repoId, now);
  const mergeQueue = prs
    .filter((p) => p.state === "open")
    .map((p) => {
      const facts = mergeFacts.get(p.pr);
      const pendingChecks = facts?.checks.filter((check) => check.state === "pending") ?? [];
      const waitsOn = [
        ...(p.failingChecks.length > 0 ? [`CI: ${p.failingChecks.join(", ")}`] : []),
        ...(pendingChecks.length
          ? [`CI pending: ${pendingChecks.map((check) => check.name).join(", ")}`]
          : []),
        ...(facts?.mergeable === "CONFLICTING" ? ["merge conflict"] : []),
        ...(p.review === null ? ["review"] : []),
        ...(p.review?.blocking
          ? [`${p.review.blocking} review finding${p.review.blocking === 1 ? "" : "s"}`]
          : []),
        ...(p.awaitingFlight === null || p.awaitingFlight === undefined ? [] : ["FLIGHT merge"]),
      ];
      return { pr: p.pr, waitsOn };
    })
    .filter((p) => p.waitsOn.length > 0);

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

  const capacityConfig = config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS;
  const capacity = machineCapacity(
    store.machineSamples(machineCapacitySince(now, capacityConfig)),
    now,
    capacityConfig,
  );
  const queuedReviews = reviewQueue.queued;
  const idleReviewers = reviewQueue.seats.filter((seat) => seat.idle).length;
  const eligibleBuilds = tickets.filter((ticket) => ticket.ready).length;
  const idleBuilds = seats.filter((seat) => seat.loop === "build" && seat.free).length;
  const machineBlocks = [
    ...(queuedReviews > 0
      ? [
          `${queuedReviews} queued review${queuedReviews === 1 ? "" : "s"} for ${idleReviewers} idle review seat${idleReviewers === 1 ? "" : "s"}`,
        ]
      : []),
    ...(eligibleBuilds > 0
      ? [
          `${eligibleBuilds} eligible ticket${eligibleBuilds === 1 ? "" : "s"} for ${idleBuilds} idle build seat${idleBuilds === 1 ? "" : "s"}`,
        ]
      : []),
  ].join("; ");
  const flowHolds: NonNullable<FlightState["flowHolds"]> = [
    ...(capacity.blocked && capacity.reason !== null
      ? [
          {
            kind: "machine" as const,
            reason: capacity.reason,
            blocks: machineBlocks,
            ...(queuedReviews > 0
              ? { feedbackLoop: "the hold blocks reviews; held reviews cannot merge" }
              : {}),
            blocking: queuedReviews > 0 || eligibleBuilds > 0,
          },
        ]
      : []),
    ...(() => {
      const pause = readCrewPause(store);
      if (pause === null) return [];
      const pausedReviews = reviewQueue.seats.filter((seat) =>
        pause.seats === "all" ? true : pause.seats.includes(seat.seat),
      );
      const pausedBuilds = seats.filter(
        (seat) => seat.loop === "build" && (pause.seats === "all" || pause.seats.includes(seat.id)),
      );
      const pausedQueuedReviews = pausedReviews.reduce((total, seat) => total + seat.queued, 0);
      return [
        {
          kind: "crew-pause" as const,
          reason: pause.reason,
          blocks: `${pausedBuilds.length} build seat${pausedBuilds.length === 1 ? "" : "s"}, ${pausedReviews.length} review seat${pausedReviews.length === 1 ? "" : "s"} and ${pausedQueuedReviews} queued review${pausedQueuedReviews === 1 ? "" : "s"}`,
          blocking: (pausedBuilds.length > 0 && eligibleBuilds > 0) || pausedQueuedReviews > 0,
        },
      ];
    })(),
    ...seats
      .filter((seat) => seat.atStop)
      .map((seat) => {
        const accountId = mine.find((source) => source.id === seat.id)?.accountId;
        const account = config.accounts.find((source) => source.id === accountId);
        const reading =
          account === undefined || accountId === undefined
            ? null
            : (["5h", "7d"] as const)
                .map((window) => ({ window, usage: store.latestUsage(accountId, window) }))
                .find(
                  ({ usage }) =>
                    usage !== null && usage.resetAt > now && usage.pct >= account.stopAt,
                );
        const reason =
          reading === null ||
          reading === undefined ||
          reading.usage === null ||
          account === undefined
            ? `${seat.call}'s account is at its quota stop`
            : `${seat.call}'s ${reading.window} quota is ${reading.usage.pct}% (stop ${account.stopAt}%)`;
        return {
          kind: "quota" as const,
          reason,
          blocks: `${seat.loop} work assigned to ${seat.call}`,
          blocking:
            (seat.loop === "build" && eligibleBuilds > 0) ||
            (seat.loop === "review" &&
              reviewQueue.seats.some((review) => review.seat === seat.id && review.queued > 0)),
        };
      }),
    ...seats
      .filter((seat) => seat.state === "stopped")
      .map((seat) => ({
        kind: "seat-stopped" as const,
        reason: `${seat.call} is stopped`,
        blocks: `${seat.loop} work assigned to ${seat.call}`,
        blocking:
          (seat.loop === "build" && eligibleBuilds > 0) ||
          (seat.loop === "review" &&
            reviewQueue.seats.some((review) => review.seat === seat.id && review.queued > 0)),
      })),
  ];

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

  const triageAll = flightTriageItems(config, store, now, i.hubLogin ?? null, crewRows, i.lock);
  const items = triageAll
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
      ...(x.returned === undefined ? {} : { returned: x.returned }),
    }));

  const planned = flightScheduleView(config, store, now).entries;
  const pace = paceView(store, config, now);
  // a PR the digest lists already shows a change to its state or head; the pointer is read with the wake, not repeated
  const listedPrs = new Set(prs.map((p) => `${session.repoId}#${p.pr}`));
  const covered = movedAll.filter(
    (m) => m.kind === "pr" && listedPrs.has(m.target) && FLIGHT_PR_ENTRY_CHANGES.includes(m.change),
  );
  const moved = movedAll.filter((m) => !covered.includes(m)).slice(0, FLIGHT_MOVED_LISTED);
  return {
    prFlow: flow,
    ...flightSignals({
      config,
      store,
      session,
      seats,
      aside,
      triageItems: triageAll.map((x) => ({ key: x.key, kind: x.kind, at: x.at, text: x.text })),
      readyPrs: prs.flatMap((p) => {
        const at = store
          .notes()
          .find((n) => n.kind === "ready" && n.runId === p.runId && p.runId !== "")?.at;
        return p.state === "open" && p.ready && at !== undefined
          ? [{ ref: p.ref, pr: p.pr, at }]
          : [];
      }),
      questions: openQuestionSubjects({ config, store, now, lock: i.lock }).map((q) => {
        const facts = questionFacts(store, q);
        return {
          id: subjectId(q),
          facts: factsText(facts),
          closing: closingFact(q, facts) !== null,
        };
      }),
      now,
    }),
    ...(pace ? { pace } : {}),
    instructionRevision: store.instructions.revision(),
    memory: store.flightMemoryTitles(session.repoId),
    retrospective: pendingRetrospective(store, session.repoId, now, tz),
    ...(planned.length > 0 ? { planned } : {}),
    discussions,
    wake: withCovered(
      wakeInputs({
        pace: paceStartCheck(store, config, now),
        store,
        seats,
        tickets,
        allTickets: openTickets,
        items,
        areas: i.areas,
        hubLogin: i.hubLogin ?? null,
        flightId: found?.seat.id ?? null,
        now,
      }),
      covered,
    ),
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
    blocked: blockedWork(store, session.repoId, now, inThisLane(config)),
    prs,
    items,
    holds,
    reviewQueue,
    mergeQueue,
    flowHolds,
    recent,
    breaker,
    brief,
    ...headline,
    ledger,
    ledgerMore: openLedger.length - ledger.length,
    ...(moved.length === 0 ? {} : { moved }),
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
  now = Date.now(),
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
    wake: _wake,
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
  // Delivery receipts survive a session handover; the per-session snapshot does not. A told
  // episode must not become new again on the first wake. Changed reasons have a new key or
  // are untold by the producer. Do not announce removals for entries never delivered.
  const wakeSignals = signals.filter(
    (signal) =>
      !signal.told && (signal.kind !== "wait_over" || now - signal.since <= 24 * FLIGHT_HOUR_MS),
  );
  const signalChanges = changed("signals", wakeSignals, (s) => `${s.kind}:${s.key}`);
  signalChanges.unchanged += signals.length - wakeSignals.length;
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

/**
 * What `flight_state` shows of the signals by default: a wait that ended over a day ago folds into one
 * summary line with a count. Every other signal stays whole. `full` in the tool call lists everything (#1632).
 */
export function compactSignals(signals: FlightSignal[], now: number): FlightSignal[] {
  const expired = (s: FlightSignal): boolean =>
    s.kind === "wait_over" && now - s.since > 24 * FLIGHT_HOUR_MS;
  const folded = signals.filter(expired);
  if (folded.length === 0) return signals;
  return [
    ...signals.filter((s) => !expired(s)),
    {
      kind: "wait_over",
      key: "expired",
      since: Math.min(...folded.map((s) => s.since)),
      evidence: `${folded.length} expired waits left out; call flight_state with full: true to list them`,
    },
  ];
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

/**
 * What a wake is about, as a stable string (no times): it changes only when something new needs
 * FLIGHT's judgement. Routine pipeline steps (CI, review and merge moving, a park the engine
 * clears) are in the digest but not here; a timed signal wakes FLIGHT when one stands still.
 */
export function wakeFacts(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
): string {
  const { free, startable } = startableFor(s);
  // a review just queued waits for its seat to start it; only one that has stood still is a fault
  // The engine re-routes a queued review to the seat `reviewerOf` picks, so an idle seat with no queue
  // of its own gets one without FLIGHT. The fault is an idle seat whose own queued review has stood
  // still; a seat at its quota stop is not idle. A wait on it holds the fact.
  const reviewFault = s.wake?.reviewsWaited !== true && reviewFaultStands(s.reviewQueue);
  return JSON.stringify({
    instructions:
      s.instructionRevision && s.instructionRevision !== "0" ? [s.instructionRevision] : [],
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
    t: startable.sort(),
    // seats idle with tickets open: a new fact each 30 minutes, until one starts or FLIGHT logs a wait
    idle: idleFacts(s.wake?.idle),
    // a park the engine clears alone is digest-only; old_park says when it has stood too long
    parked: [
      ...s.seats
        .filter((x) => x.parked !== null && flightParkKind(x.parked.kind))
        .map((x) => `${x.id}:${x.ticket}:${x.parked?.kind}`),
      ...s.aside
        .filter((x) => x.parked !== null && flightParkKind(x.parked.kind))
        .map((x) => `${x.seat}:${x.ticket}:${x.parked?.kind}`),
    ].sort(),
    stopped: stoppedSeats(s),
    reviews: reviewFault ? [REVIEW_FAULT_FACT] : [],
    prFlow: prFlowFacts(s.prFlow),
    holdsInForce:
      s.flowHolds
        ?.filter((hold) => hold.blocking)
        .map((hold) => hold.kind)
        .sort() ?? [],
    // CI, review and merge steps are digest-only; merge_stalled says when a ready PR has stood still
    prs: s.prs
      .filter((p) => p.awaitingFlight != null || p.awayBugDecision != null)
      .map(
        (p) =>
          `${p.ref}:${p.pr}:${p.ready}:${p.state}:${p.awaitingFlight ?? ""}:${p.awayBugDecision?.about ?? ""}`,
      )
      .sort(),
    // an unread plain message from the operator: never routine
    operator: s.wake?.operator ?? [],
    // read and not answered: owed until FLIGHT replies to it
    owed: s.wake?.owed ?? [],
    items: (s.wake?.fresh ?? wakeItems(s).map(itemFactId)).slice().sort(),
    release: releasable(s),
    breaker: s.breaker.tripped ? [s.breaker.reason ?? "tripped"] : [],
  });
}

/** The idle-seat facts: each long-idle seat with the period of its own spell, so a new period is a new fact. */
const idleFacts = (idle: FlightIdleSeats | undefined): string[] =>
  idleLong(idle).map((x) => `${x.id}:${idlePeriod(x.ms)}`);

/** An item as a wake fact: a PR's by its text, so a new state of it is a new fact. */
export const itemFactId = (x: { kind: string; key: string; text: string }): string =>
  x.kind === "pr" ? `${x.key.replace(/:\d+$/, "")}:${x.text}` : x.key;

/**
 * The free build seats that have a Ready ticket to take, and those tickets. A seat or ticket with
 * no fit, or one FLIGHT waits on, is not a reason to wake: nothing could start there.
 */
const startableFor = (s: FlightState): { free: string[]; startable: string[] } => {
  const fit = s.wake?.fit;
  const ready = s.tickets.filter((t) => t.ready).map((t) => t.ref);
  const free = s.seats
    .filter((x) => x.loop === "build" && x.free)
    .filter((x) => (fit === undefined ? ready.length > 0 : (fit[x.id]?.length ?? 0) > 0));
  const startable = new Set(free.flatMap((x) => fit?.[x.id] ?? ready));
  return { free: free.map((x) => x.id), startable: [...startable] };
};

/** The items that wake FLIGHT: a PR ready to merge is a routine step, and merge_stalled says when it stands still. */
const wakeItems = (s: Pick<FlightState, "items">): FlightState["items"] =>
  s.items.filter((x) => x.kind !== "ready");

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
  kind !== STUCK_PARK && // the engine lifts it once the PR shows the push; push_unseen says when it has not
  (kind === RULING_PARK ||
    kind === "review-failed" ||
    (FLIGHT_UNPARK_KINDS as readonly string[]).includes(kind));

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
    wakeItems(s).length > 0 ||
    releasable(s).length > 0 ||
    stoppedSeats(s).length > 0 ||
    startableFor(s).free.length > 0 ||
    idleFacts(s.wake?.idle).length > 0 ||
    (s.wake?.owed?.length ?? 0) > 0 ||
    s.seats.some((x) => x.parked !== null && flightParkKind(x.parked.kind)) ||
    s.aside.some((x) => x.parked !== null && flightParkKind(x.parked.kind))
  );
}

/** One thing a wake woke FLIGHT for: its fact id, a label, and what a decision on it would name. */
export interface WakeReason {
  id: string;
  label: string;
  targets: string[];
}

type Facts = Record<string, unknown[]>;
/** Reasons that stay open until FLIGHT decides, because nothing in the state shows them settled. */
const decisionOnly = (id: string): boolean =>
  id.startsWith("triage:") || id.startsWith('signals:"seat_call:');
/** A fact that is only a name for what a decision names, not a target. */
const NOT_A_TARGET = new Set(["true", "false", "open", "merged", "closed", "null"]);

/** Words that name a kind of fact, not the thing it is about: never a target of their own. */
const GENERIC = new Set<string>([
  "report",
  "watch",
  "loop",
  "ask",
  "note",
  "controller",
  ...ATTENTION_KINDS,
]);

/**
 * What a decision on this fact would name. A signal's kind and its times are not targets (two
 * signals of one kind share them); a park's kind is not either. What is left is the seat, run, ref,
 * question or item key the fact is about.
 */
const factTargets = (category: string, item: unknown): string[] => {
  const first = Array.isArray(item) ? item[0] : item;
  // a question's decision may name it as its item key, ask:<id>
  if (typeof first !== "string")
    return category === "q" ? [String(first), `ask:${first}`] : [String(first)];
  if (category === "prFlow") {
    const pr = first.split(":")[0];
    return pr && /^\d+$/.test(pr) ? [pr, `#${pr}`] : [];
  }
  let parts = first.split(":");
  if (category === "signals") parts = parts.slice(1);
  if (category === "parked") parts = parts.slice(0, -1);
  const whole = parts.join(":");
  return [whole, ...parts].filter(
    (t, i, all) =>
      t !== "" &&
      !NOT_A_TARGET.has(t) &&
      !GENERIC.has(t) &&
      !/^\d{10,}$/.test(t) &&
      all.indexOf(t) === i,
  );
};

/** The words of a decision's text, lower-cased, trailing punctuation off: a target matches a whole word. */
const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[\s,;()"'`]+/)
      .map((w) => w.replace(/[.:]+$/, ""))
      .filter((w) => w !== "")
      // #12 and repo#12 both name 12, kept as "#12"
      .flatMap((w) => (w.includes("#") ? [w, w.slice(w.lastIndexOf("#"))] : [w])),
  );

/** The facts of a wake that need a decision: a PR entry counts when FLIGHT has something to do on it. */
const accountable = (category: string, item: unknown): boolean => {
  // Guidance changes wake FLIGHT but do not demand a fabricated decision when nothing changes.
  if (category === "t" || category === "instructions" || category === "operator") return false;
  // an owed reply is answered with a Comms reply, not a logged decision
  if (category === "owed") return false;
  if (category === "prs") {
    const [, , ready, state, awaiting, away] = String(item).split(":");
    return (ready === "true" && state === "open") || !!awaiting || !!away;
  }
  if (category === "parked") {
    const kind = String(item).split(":").at(-1) ?? "";
    return flightParkKind(kind);
  }
  return true;
};

/** What a wake newly lists, as reasons: the facts in `current` that `previous` did not have. */
/** The tickets of the item a fact is about: the item itself, or the item an item_stale signal names. */
const itemTickets = (
  category: string,
  item: unknown,
  itemRefs: readonly { key: string; ticket: string | null }[],
): string[] => {
  const stale = typeof item === "string" && item.startsWith("item_stale:");
  const key = stale ? item.slice("item_stale:".length) : item;
  if (category !== "items" && !(category === "signals" && stale)) return [];
  return itemRefs.flatMap((x) =>
    (stale ? x.key.replace(/:\d+$/, "") : x.key) === key
      ? // a stale signal's key drops the item key's last part: a wait on the full key handles it
        [...(x.ticket === null ? [] : [x.ticket]), ...(stale ? [x.key] : [])]
      : [],
  );
};

export function wakeReasons(
  previous: string,
  current: string,
  itemRefs: readonly { key: string; ticket: string | null }[] = [],
): WakeReason[] {
  const before = JSON.parse(previous || "{}") as Facts;
  const after = JSON.parse(current) as Facts;
  return Object.entries(after).flatMap(([category, items]) => {
    const old = new Set((before[category] ?? []).map((v) => JSON.stringify(v)));
    return items
      .filter((item) => !old.has(JSON.stringify(item)) && accountable(category, item))
      .map((item) => ({
        id: `${category}:${JSON.stringify(item)}`,
        label: `${category} ${typeof item === "string" ? item : JSON.stringify(item)}`.slice(
          0,
          200,
        ),
        // an item's ticket is a target too: a brief or wait on the ticket handles the item
        targets: [...factTargets(category, item), ...itemTickets(category, item, itemRefs)],
      }));
  });
}

/**
 * A wake reason in words for the operator, from its fact: a PR, ticket, seat or item named, and the
 * time where the fact has one. Never the raw `kind:key:epoch` id.
 */
export function wakeReasonWords(reason: WakeReason, timeZone: string): string {
  const at = (ms: number): string => {
    const day = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      timeZone,
    }).format(ms);
    return `${day} ${clockHm(ms, timeZone)}`;
  };
  const times = (text: string): string => text.replace(/\d{13}/g, (ms) => at(Number(ms)));
  const spaced = (text: string): string => text.replace(/[_-]+/g, " ");
  const split = /^([^:]+):([\s\S]*)$/.exec(reason.id);
  const category = split?.[1] ?? "";
  let item: unknown = split?.[2];
  try {
    item = JSON.parse(split?.[2] ?? "null");
  } catch {
    // a fact id that is not JSON keeps its text
  }
  const text = typeof item === "string" ? item : JSON.stringify(item);
  const [a = "", b = "", c = "", d = "", e = ""] = typeof item === "string" ? item.split(":") : [];
  const since = (part: string): string =>
    /^\d{13}$/.test(part) ? ` since ${at(Number(part))}` : "";
  switch (category) {
    case "q":
      return `question ${text}`;
    case "prFlow": {
      const [pr = "", what = "", ...rest] = (typeof item === "string" ? item : "").split(":");
      const when = since(rest.at(-1) ?? "");
      if (what === "unowned") return `PR #${pr} has had no owner${when}`;
      if (what === "waiting") return `PR #${pr} has waited on the ${rest[0] ?? "operator"}${when}`;
      return `PR #${pr} has stood at the ${rest[0] ?? "same"} step${when}`;
    }
    case "triage":
      return b === "missed"
        ? `FLIGHT missed ${a}`
        : `${a} waits for FLIGHT's triage (${spaced(b)})`;
    case "parked":
      return `${a} is parked on ${b} (${spaced(c)})`;
    case "stopped":
      return `${text} is stopped`;
    case "idle":
      return `${a} idle ${b}`;
    case "free":
      return `seat ${text} is free`;
    case "t":
      return `ticket ${text} is ready to start`;
    case "reviews":
      return "review seats are idle with a review queued";
    case "holdsInForce":
      return `${spaced(text)} hold is in force`;
    case "owed":
      return `you owe the operator an answer to Comms message ${text}`;
    case "breaker":
      return `the runaway breaker is tripped (${spaced(text)})`;
    case "prs":
      return `PR #${b} (${a}) waits on FLIGHT${e ? ` to ${spaced(e)}` : ""}`;
    case "planned": {
      const [, dueAt, , target, label] = Array.isArray(item) ? item : [];
      return `${label ?? "a planned check"} on ${target ?? "its target"}, due ${typeof dueAt === "number" ? at(dueAt) : "now"}`;
    }
    case "items": {
      if (a === "pr") return times(text.replace(/^pr:/, "").replace(/^([^:]+):/, ""));
      if (a === "comms-open") return `Comms message ${b} waits for an answer`;
      if (a === "esc") return `issue ${b} waits for an answer`;
      if (a === "stall") return `${b} stalled${since(e)}`;
      return `${spaced(a)} ${times([b, c, d, e].filter((x) => x !== "").join(" "))}`.trim();
    }
    case "signals": {
      const target = times(text.slice(a.length + 1));
      return target === "" ? spaced(a) : `${spaced(a)} on ${target}`;
    }
    default:
      return times(`${category} ${text}`);
  }
}

/** The plain noun phrase a wake reason counts under in the wake-left alert. */
function leftWakeGroup(reason: WakeReason): readonly [string, string] {
  const { category, item } = ((): { category: string; item: string } => {
    const split = /^([^:]+):([\s\S]*)$/.exec(reason.id);
    return { category: split?.[1] ?? "", item: split?.[2] ?? "" };
  })();
  if (category === "prFlow" || category === "prs" || item.startsWith('"pr:'))
    return ["pull request waiting for a next step", "pull requests waiting for a next step"];
  if (category === "q" || item.startsWith('"comms-open:') || item.startsWith('"esc:'))
    return ["question waiting for an answer", "questions waiting for an answer"];
  if (category === "free") return ["free seat", "free seats"];
  if (category === "t") return ["ticket ready to start", "tickets ready to start"];
  if (category === "parked" || category === "stopped" || category === "idle")
    return ["seat that needs a look", "seats that need a look"];
  if (category === "triage") return ["item waiting for FLIGHT", "items waiting for FLIGHT"];
  if (category === "reviews" || category === "release")
    return ["review or release step waiting", "review or release steps waiting"];
  if (category === "breaker" || category === "holdsInForce")
    return ["safety stop or hold in force", "safety stops or holds in force"];
  if (category === "planned") return ["planned check that is due", "planned checks that are due"];
  if (category === "signals") return ["signal from the crew", "signals from the crew"];
  if (item.startsWith('"stall:')) return ["seat that needs a look", "seats that need a look"];
  return ["other thing to look at", "other things to look at"];
}

/**
 * The wake-left alert in plain words: how many things FLIGHT was woken about and left undecided,
 * when it was woken, and a count by kind. Never a PR, ticket or seat id, or a raw key.
 */
export function leftWakeText(
  left: readonly WakeReason[],
  wokeAt: number,
  timeZone: string,
): string {
  const groups = new Map<string, { one: string; many: string; n: number }>();
  for (const r of left) {
    const [one, many] = leftWakeGroup(r);
    const g = groups.get(one) ?? { one, many, n: 0 };
    g.n += 1;
    groups.set(one, g);
  }
  const parts = [...groups.values()].map((g) => `${g.n} ${g.n === 1 ? g.one : g.many}`);
  const things = left.length === 1 ? "1 thing" : `${left.length} things`;
  return `FLIGHT was woken at ${clockHm(wokeAt, timeZone)} about ${things} and left ${left.length === 1 ? "it" : "them"} undecided after two tries: ${parts.join(", ")}.`;
}

/** Facts whose removal frees work FLIGHT can act on: a lift wakes FLIGHT at once, never batched or settled. */
const LIFTS_WAKE: ReadonlySet<string> = new Set(["breaker", "holdsInForce"]);

/** Fact categories that are routine pipeline steps: they wait for the batch window. */
const ROUTINE_CATEGORIES: ReadonlySet<string> = new Set([
  "free",
  "t",
  "release",
  "reviews",
  "prFlow",
]);

/**
 * Whether everything that changed between two wake facts is routine: a free seat, a ticket, a PR
 * moving. An operator message, question, blocker, park, signal, plan, instruction or the breaker is
 * never routine, so those wake FLIGHT at once. False when nothing changed.
 */
export function routineOnly(previous: string, current: string): boolean {
  const before = JSON.parse(previous || "{}") as Facts;
  const after = JSON.parse(current) as Facts;
  let changed = false;
  for (const category of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = new Set((before[category] ?? []).map((v) => JSON.stringify(v)));
    const now = new Set((after[category] ?? []).map((v) => JSON.stringify(v)));
    const added = [...now].filter((v) => !old.has(v));
    const removed = [...old].filter((v) => !now.has(v));
    if (added.length === 0 && removed.length === 0) continue;
    // settling a question, a park or a discussion is FLIGHT's own work, not a new reason; only the
    // breaker's lift is, as a lift alone wakes FLIGHT
    if (added.length === 0 && !LIFTS_WAKE.has(category) && !ROUTINE_CATEGORIES.has(category))
      continue;
    changed = true;
    if (category === "items") {
      // a PR's own steps are routine; any other item (a message, a blocker) is not
      if (!added.every((v) => String(JSON.parse(v)).startsWith("pr:"))) return false;
    } else if (!ROUTINE_CATEGORIES.has(category)) return false;
  }
  return changed;
}

/**
 * Whether the only differences between two wake facts are things that went away (a question
 * answered, a message read, a park lifted): nothing new to tell FLIGHT. A breaker lift or a hold
 * lifting is not settled: either one frees work FLIGHT can act on, so it wakes FLIGHT at once.
 */
export function onlySettled(previous: string, current: string): boolean {
  const before = JSON.parse(previous || "{}") as Facts;
  const after = JSON.parse(current) as Facts;
  let removed = false;
  for (const category of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = new Set((before[category] ?? []).map((v) => JSON.stringify(v)));
    const now = new Set((after[category] ?? []).map((v) => JSON.stringify(v)));
    if ([...now].some((v) => !old.has(v))) return false;
    if ([...old].some((v) => !now.has(v))) {
      if (LIFTS_WAKE.has(category)) return false;
      removed = true;
    }
  }
  return removed;
}

/** The ids of the reasons still open in this state; a delivered signal stays open while it holds. */
export function openReasonIds(
  s: FlightState & TeamsDigestState & { discussions?: ItemDiscussion[] },
): Set<string> {
  const facts = JSON.parse(wakeFacts(s)) as Facts;
  facts.signals = s.signals.filter((x) => x.kind !== "seat_call").map((x) => `${x.kind}:${x.key}`);
  return new Set(
    Object.entries(facts).flatMap(([category, items]) =>
      items.map((item) => `${category}:${JSON.stringify(item)}`),
    ),
  );
}

/**
 * The reasons of a wake that FLIGHT left alone: not settled in the state, and with no decision since
 * the wake that names one of their targets (a ref, seat, run, question, or the target in its text).
 */
export function unhandledReasons(
  store: Store,
  reasons: readonly WakeReason[],
  wokeAt: number,
  open: ReadonlySet<string>,
): WakeReason[] {
  const decisions = store.flightDecisions(wokeAt, 500);
  const words = decisions.map((d) => wordsOf(`${d.about} ${d.decision}`));
  return reasons.filter((r) => {
    if (!decisionOnly(r.id) && !open.has(r.id)) return false;
    return !decisions.some((d, i) =>
      r.targets.some(
        (t) =>
          // a wait names its target whole, before ": waiting on"; a key with spaces is no word
          (d.kind === "wait" &&
            d.about.toLowerCase().startsWith(`${t.toLowerCase()}: waiting on`)) ||
          d.ref === t ||
          d.seatId === t ||
          d.targetRunId === t ||
          (d.questionId !== null && String(d.questionId) === t) ||
          (t.length >= 2 && words[i]?.has(t.toLowerCase()) === true) ||
          (/^\d+$/.test(t) && words[i]?.has(`#${t}`) === true),
      ),
    );
  });
}
