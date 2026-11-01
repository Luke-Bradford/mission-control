/**
 * The HUD's server-built views: agent views, crew rows and attention items. Kept apart from api.ts
 * so the scheduler can build attention items without importing the API (api.ts imports the
 * scheduler).
 */

import { createHash } from "node:crypto";
import {
  type AgentView,
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionOwner,
  agentState,
  type BoardItem,
  CI_TRIES,
  COMMS_CAPCOM,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  COMMS_OPEN_PREFIX,
  CONTROLLER_CHECK_PARK,
  type Crew,
  type CrewAsideRun,
  type CrewLoop,
  type CrewQueueItem,
  type CrewRow,
  clockHm,
  crewHudState,
  currentReview,
  type DriverStop,
  driverStopKey,
  type Escalation,
  escalationKind,
  FLIGHT_DOWN_NOTE_KEY,
  FLIGHT_DOWN_NOTES,
  FLIGHT_HANDLING_MAX_MS,
  FLIGHT_LEFT_NOTE_KEY,
  FLIGHT_NOT_TRIAGING_KEY,
  FLIGHT_NOTE_KEY,
  FLIGHT_OFF_GRACE_MS,
  FLIGHT_RUNAWAY_NOTE_KEY,
  FLIGHT_TRIAGE_WAIT_MS,
  type FlightNotTriagingCause,
  fixesSent,
  flightFloorBlocked,
  flightNotTriagingText,
  hardRulesBySettingKey,
  hudState,
  isCleanupNoteKey,
  isFlakeNoteKey,
  isHardRulesFlagKey,
  isNoReportNoteKey,
  LOCK_WAITING_TEXT,
  type LoopWait,
  laneOwner,
  lockBlockedText,
  loopText,
  modeOfSeat,
  OPERATOR_CALL_KINDS,
  OWNER_CONTROLLER,
  OWNER_FLIGHT,
  OWNER_LOOP,
  OWNER_OPERATOR,
  PR_WAIT_MS,
  type PullRequestView,
  pathInArea,
  profileStep,
  prYouAction,
  questionText,
  REVIEW_ROUNDS,
  type ReviewRow,
  type ReviewState,
  RUNAWAY_TRIAGE_DETAIL,
  type Run,
  type RunDigest,
  type SeatSessionRow,
  STALL_TEXT,
  seatCallSign,
  seatDef,
  stallStart,
  startOfLocalDay,
  strayText,
  type TestLockState,
  type TokenUsage,
  UAT_PARK,
} from "@mc/core";
import { runAccountId } from "./account-bindings.ts";
import { decisionDefault, partitionAttention, protectedDecisionItem } from "./attention-holds.ts";
import { confirmedResumeAfter, pendingRunApproval } from "./attention-subjects.ts";
import { claudeVersion } from "./cli-version.ts";
import { cloneData } from "./clone.ts";
import { collectorName, noteCollectorName } from "./collectors/common.ts";
import { notificationOpen, personKey, personText } from "./collectors/notifications.ts";
import { isPaused } from "./collectors/ta-loop.ts";
import { attentionChatter, resolvedCommsReason } from "./comms.ts";
import {
  agentIds,
  type CcConfig,
  type ConfiguredAgent,
  configuredAgents,
  seatUnavailable,
} from "./config.ts";
import { pausedSeat } from "./crew-pause.ts";
import { asideWakeDue } from "./engine/aside.ts";
import { reviewerOf } from "./engine/engine.ts";
import { collectFiles, type FileDeps, filesUnchanged, statNoted } from "./file-deps.ts";
import { runawayLiftedAt, runawayTrip } from "./flight/runaway.ts";
import { flightLive, flightSeat, ownReply } from "./flight/state.ts";
import { loopTries } from "./loophistory.ts";
import { reviewCheckFor } from "./review-check.ts";
import {
  type PrCache,
  parseTicket,
  runPrs,
  runSummary,
  runTicket,
  runTicketTitle,
} from "./runview.ts";
import type { AttentionNote, Store } from "./store.ts";
import { lastOutputAt } from "./stream.ts";
import { transcriptFilePath } from "./transcript-file.ts";
import { HUB_UPDATE_HELD_KEY } from "./update.ts";
import { runEvents, runEventsIndex } from "./views.ts";

/** A crew error's attention key: this, then its row id (an ack of it acks the row). */
export const CREW_ERROR_KEY = "crew-error:";
/** An engine note's Needs-you key: this, then the note's own key. */
export const NOTE_KEY = "note:";

/** Runs read per loop for its view (state, context-window fallback). */
const AGENT_RUNS = 50;
/** No lock: the default for callers that have none (a preview, a test). */
export const NO_LOCK: TestLockState = { holder: null, waiting: [] };

/** A transcript's mtime (whole ms), or null when the run has none or the file is gone. */
export function transcriptMtime(path: string): number | null {
  if (path === "") return null;
  try {
    return Math.floor(statNoted(transcriptFilePath(path)).mtimeMs);
  } catch {
    return null;
  }
}

interface LoopView {
  agent: ConfiguredAgent;
  runs: Run[];
  /** The run shown for the agent: the one its seat holds, else the newest. */
  latest: Run | null;
  view: AgentView;
  /** Crew only: the seat's session row (null before it was ever started). */
  seatRow: SeatSessionRow | null;
}

/** The fields an agent view has only for a crew seat; a loop has none of them. */
function crewFields(
  agent: ConfiguredAgent,
): Pick<AgentView, "kind" | "role" | "mode" | "area" | "model" | "sessionId"> {
  if (agent.kind === "loop") {
    return { kind: "loop", role: null, mode: null, area: [], model: null, sessionId: null };
  }
  const { seat } = agent;
  return {
    kind: "crew",
    role: seat.role,
    mode: modeOfSeat(seat),
    area: [...seat.area],
    model: seat.model,
    sessionId: agent.sessionId,
  };
}

/** The driver stop the collector stored, else null (also when the stored text is not a stop). */
function readStop(store: Store, loopId: string): DriverStop | null {
  const raw = store.getSetting(driverStopKey(loopId));
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<DriverStop> | null;
    return v && typeof v.reason === "string" && typeof v.at === "number" ? (v as DriverStop) : null;
  } catch {
    return null;
  }
}

/**
 * What turns a row's state with no run behind it: each loop's collector status and note, pause
 * flag, driver stop and newest run, the escalations, and each crew seat's session. Two equal signals mean no
 * such input changed between them. Reads what `loopViews` reads.
 */
export function stateInputs(config: CcConfig, store: Store): string {
  const status = new Map(store.status().map((s) => [s.collector, s]));
  const agents = configuredAgents(config);
  const seats = store.seatSessions(agents.filter((a) => a.kind === "crew").map((a) => a.id));
  return JSON.stringify([
    agents.map((agent) => {
      if (agent.kind === "crew") {
        const s = seats.get(agent.id);
        return [s?.state, s?.reason, s?.runId, s?.updatedAt, s?.errorSince];
      }
      const loop = agent.loop;
      return [
        status.get(collectorName(loop.kind, loop.id))?.ok,
        status.get(collectorName(loop.kind, loop.id))?.error,
        status.get(noteCollectorName(loop.kind, loop.id))?.error,
        loop.kind === "ta-loop" ? isPaused(loop) : false,
        loop.kind === "studio-loop" ? store.getSetting(driverStopKey(loop.id)) : null,
        // a late line can turn the newest ended run blocked
        store.runs(agent.id, 1).map((r) => [r.id, r.status, r.endedAt]),
      ];
    }),
    store.escalations().map((e) => [e.repoId, e.source, e.id]),
  ]);
}

function loopViews(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState = NO_LOCK,
  runsByAgent?: ReadonlyMap<string, Run[]>,
  seatRows?: ReadonlyMap<string, SeatSessionRow>,
  digests?: ReadonlyMap<string, RunDigest>,
): LoopView[] {
  const status = new Map(store.status().map((s) => [s.collector, s]));
  const inLine = new Set(lock.waiting.map((w) => w.runId));
  const escalations = store.escalations();
  return configuredAgents(config).map((agent) => {
    const runs = runsByAgent?.get(agent.id) ?? store.runs(agent.id, AGENT_RUNS);
    const seatRow =
      agent.kind === "crew" ? (seatRows?.get(agent.id) ?? store.seatSession(agent.id)) : null;
    const held = runs.find((run) => run.id === seatRow?.runId && run.agentId === agent.id);
    const latest = held?.endedAt === null ? held : (runs[0] ?? null);
    const lastOutput = latest
      ? lastOutputAt(
          digests?.get(latest.id)?.lastEventAt ?? store.digest(latest.id)?.lastEventAt ?? null,
          transcriptMtime(latest.transcriptPath),
        )
      : null;
    if (agent.kind === "crew") {
      const waiting = seatRow?.runId != null && inLine.has(seatRow.runId);
      const hud = crewHudState(seatRow, lastOutput, now, waiting);
      const reason =
        seatUnavailable(agent.seat) ??
        (hud === "waiting" ? LOCK_WAITING_TEXT : (seatRow?.reason ?? null));
      const view: AgentView = {
        id: agent.id,
        repoId: agent.repoId,
        ...crewFields(agent),
        loopKind: "crew",
        accountId: runAccountId(store, seatRow?.runId ?? null, agent.accountId),
        state:
          hud === "error"
            ? "error"
            : hud === "running" || hud === "stalled"
              ? "working"
              : hud === "waiting"
                ? "waiting-agent"
                : "idle",
        stateSince: seatRow?.updatedAt ?? (latest ? (latest.endedAt ?? latest.startedAt) : 0),
        currentRun: latest ? runSummary(latest) : null,
        paused: false,
        sourceError: hud === "error" ? (reason ?? "seat error") : null,
        // The seat's reason is its doing line, unless it is already the error text.
        note: hud === "error" ? null : reason,
        stop: null,
        lastOutputAt: lastOutput,
      };
      return { agent, runs, latest, view, seatRow };
    }
    const loop = agent.loop;
    const st = status.get(collectorName(loop.kind, loop.id));
    const sourceError = st && !st.ok ? (st.error ?? "collector failed") : null;
    const paused = loop.kind === "ta-loop" ? isPaused(loop) : false;
    // Only a title marker (`[operator-decision]` / `[loop-blocked]` / `[mvp-ready]`) means the
    // loop waits on the operator; a label-only escalation is listed in Needs you and nothing more.
    const waitingOnOperator = escalations.some(
      (e) => e.repoId === loop.repoId && e.source === "title",
    );
    const note = status.get(noteCollectorName(loop.kind, loop.id))?.error ?? null;
    const stop = loop.kind === "studio-loop" ? readStop(store, loop.id) : null;
    const { state, since } = agentState({ runs, paused, sourceError, waitingOnOperator });
    const view: AgentView = {
      id: loop.id,
      repoId: loop.repoId,
      ...crewFields(agent),
      loopKind: loop.kind,
      accountId: loop.accountId,
      state,
      stateSince: since,
      currentRun: latest ? runSummary(latest) : null,
      paused,
      sourceError,
      note,
      stop,
      lastOutputAt: lastOutput,
    };
    return { agent, runs, latest, view, seatRow: null };
  });
}

export function agentViews(config: CcConfig, store: Store, now: number = Date.now()): AgentView[] {
  return loopViews(config, store, now).map((l) => l.view);
}

/**
 * The open PR on the run's branch in the seat's repo (the newest, if several), as the row's review
 * state; null without a branch or an open PR.
 */
function reviewOf(
  store: Store,
  repoId: string,
  branch: string | null,
  inFlight: ReviewRow[],
  now: number,
  prs?: readonly PullRequestView[],
): CrewRow["review"] {
  if (branch === null) return null;
  const open = (prs ?? store.pullRequests(repoId))
    .filter((p) => p.state === "open" && p.branch === branch)
    .sort((a, b) => b.number - a.number)[0];
  if (!open) return null;
  const state = open.isDraft
    ? "draft"
    : open.review === "changes" || open.review === "approved"
      ? open.review
      : "open";
  const reviewing = inFlight.findLast((r) => r.repoId === repoId && r.prNumber === open.number);
  const check = reviewCheckFor(store, repoId, now, inFlight)(open);
  return {
    prNumber: open.number,
    state,
    reviewing: reviewing?.seatId ?? null,
    ...(check === null ? {} : { check }),
  };
}

/** A writer seat's queued tickets in order, without the one it holds; [] for any other row. */
function queueOf(store: Store, agent: ConfiguredAgent): CrewQueueItem[] {
  if (agent.kind !== "crew" || modeOfSeat(agent.seat) !== "writer") return [];
  return store
    .queue(agent.id)
    .filter((q) => q.takenAt === null)
    .map((q, i) => ({ ref: `${q.repoId}#${q.issue}`, issue: q.issue, pos: i + 1 }));
}

/** A scratch seat's live review: its latest run is active and performs a review. */
function reviewingOf(store: Store, latest: Run | null): CrewRow["reviewing"] {
  if (latest === null || latest.endedAt !== null || latest.reviewId == null) return null;
  const rv = store.review(latest.reviewId);
  return rv === null ? null : { prNumber: rv.prNumber, sha: rv.sha, ref: latest.ticket };
}

const allTokens = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheCreate;

/** How many of a seat's earlier runs are looked through for a cost rate. */
const COST_RATE_RUNS = 20;

/**
 * A running run's cost so far, for the ~Cost tile: a crew run's `costUsd` comes only from `result`
 * lines, so it lags a turn. Its own cost per token (at its latest `result`) carried over the tokens
 * folded since; with none yet, the newest earlier run of the seat and model that has a cost gives
 * the rate. Null when the run has ended (its `costUsd` is final) or no rate is known.
 */
function costEstimate(
  store: Store,
  seatId: string,
  run: Run,
  digest: RunDigest | null,
  previousRuns?: readonly Run[],
): number | null {
  if (run.status !== "running" || run.tokens === null) return null;
  const now = allTokens(run.tokens);
  const atResult = digest?.costTokens ?? null;
  if (run.costUsd !== null && atResult !== null && atResult > 0) {
    return (run.costUsd * now) / atResult;
  }
  for (const prev of previousRuns ?? store.runs(seatId, COST_RATE_RUNS)) {
    if (prev.id === run.id || prev.model !== run.model || prev.costUsd === null) continue;
    if (prev.tokens === null || allTokens(prev.tokens) <= 0) continue;
    return (now * prev.costUsd) / allTokens(prev.tokens);
  }
  return null;
}

/** A review in one of these states is on the review seat now. */
const REVIEWING: readonly ReviewState[] = ["queued", "starting", "running"];

/** Open note keys that say the operator is next on a run in review. */
const OPERATOR_NOTE_PREFIXES = ["ready:", "review:", "headmoved:"];
/** A review in one of these states is still to come from the review seat. */
const REVIEW_PENDING: readonly string[] = ["queued", "starting", "running", "failed"];

/** What a looped run waits on; the first matching rule wins (null: its seat is on it, or it is done). */
export function runWait(
  config: CcConfig,
  store: Store,
  run: Run,
  loop: NonNullable<Run["loop"]>,
  lock: TestLockState,
): LoopWait | null {
  if (run.endedAt !== null || loop.phase === "done") return null;
  if (lock.waiting.some((w) => w.runId === run.id)) return "lock";
  if (loop.phase === "parked") return "operator";
  if (asideWakeDue(store, run)) return "seat";
  if (loop.mainMerge) return "main";
  if (loop.phase === "ci") return "ci";
  if (loop.phase !== "review") return null;
  const keys = store.openNoteKeys(run.id);
  if (keys.some((k) => OPERATOR_NOTE_PREFIXES.some((p) => k.startsWith(p)))) return "operator";
  const push = store.runPush(run.id);
  if (reviewerOf(config, run.agentId) !== null && push !== null) {
    const cur = currentReview(store.reviewsOfRun(run.id), loop.epoch, push.sha);
    if (cur === null || REVIEW_PENDING.includes(cur.state)) return "retro";
  }
  return null;
}

/** What a rework due on a seat that is on another ticket reads: null when nothing holds it up. */
function reworkWaitText(store: Store, run: Run): string | null {
  const holder = store.seatSession(run.agentId)?.runId ?? null;
  if (holder === null || holder === run.id) return null;
  const held = store.run(holder);
  if (held === null || held.endedAt !== null || held.ticket === null) return null;
  const issue = held.ticket.slice(held.ticket.lastIndexOf("#"));
  return `rework waiting on ${seatCallSign(run.agentId)} (behind ${issue})`;
}

/** The current step's try and its limit, else null. */
function runTries(store: Store, run: Run, loop: NonNullable<Run["loop"]>): CrewLoop["tries"] {
  if (loop.phase === "ci")
    return {
      n: loop.ciFails + 1,
      max: run.profile?.profile.tries ?? CI_TRIES,
      failures: loop.ciFails,
      runs: loopTries(run, store.loopEventsOfRun(run.id), null).filter((t) => t.step === "ci")
        .length,
    };
  if (loop.phase === "review") {
    const sent = fixesSent(store.claimedKeys(run.id), run.id, loop.epoch);
    const max = run.profile?.profile.rounds ?? REVIEW_ROUNDS;
    return { n: Math.min(max, 1 + sent), max };
  }
  return null;
}

/**
 * The views below are rebuilt from every run, PR and digest row, and several callers (the pages, the
 * scheduler's ticks, FLIGHT's tools) ask for the same one many times a second. A view is reused
 * while the second it was built in is unchanged, the store has not been written since (by this
 * process or another), no file it read has changed, and the inputs that are in neither (config,
 * lock, login, CLI version) match.
 * The second is the coarsest bucket the age rules allow: they all compare whole seconds or
 * minutes (stall and wait thresholds, "5m ago"), so a view up to a second old shows the same.
 * Each caller gets its own copy, so one that sorts or edits what it was given cannot skew the others.
 */
const VIEW_MEMO_MS = 1_000;
const MEMO_ENTRIES = 16;

/** What a memoised view stands on: the store's write version and the files it read. */
interface Basis {
  version: string;
  files: FileDeps;
}
interface ViewMemo {
  bucket: number;
  entries: Map<string, Basis & { value: unknown; token: string }>;
}
const viewMemos = new WeakMap<Store, ViewMemo>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
const identityOf = (o: object): number => {
  const known = identities.get(o);
  if (known !== undefined) return known;
  const id = ++nextIdentity;
  identities.set(o, id);
  return id;
};
/** Crew rows handed out of the memo: the memo entry they are a copy of, and what it stands on. */
const rowOrigins = new WeakMap<object, Basis & { token: string }>();

/** The CLI version for callers that have no use for it: one function, so they share an entry. */
export const NO_CLI_VERSION = (): string | null => null;

function memoised<T>(
  store: Store,
  now: number,
  key: unknown[],
  build: () => T,
  /** What the inputs of this view were built from, which it stands on too. */
  inherited?: Basis,
): { value: T } & Basis & { token: string } {
  const bucket = Math.floor(now / VIEW_MEMO_MS);
  let memo = viewMemos.get(store);
  if (!memo || memo.bucket !== bucket) {
    memo = { bucket, entries: new Map() };
    viewMemos.set(store, memo);
  }
  const k = JSON.stringify(key);
  const version = store.readVersion();
  const hit = memo.entries.get(k);
  if (hit?.version === version && filesUnchanged(hit.files))
    return { ...hit, value: cloneData(hit.value as T) };
  const built = collectFiles(build);
  if (inherited)
    for (const [f, seen] of inherited.files) if (!built.files.has(f)) built.files.set(f, seen);
  // names this build, so a view made from its rows is reused only while it is
  const token = `${bucket}/${++nextIdentity}`;
  // A build that wrote (a read that keeps bookkeeping) left the store at a newer version: not reusable.
  if (store.readVersion() === version) {
    memo.entries.delete(k);
    if (memo.entries.size >= MEMO_ENTRIES) {
      const oldest = memo.entries.keys().next();
      if (!oldest.done) memo.entries.delete(oldest.value);
    }
    memo.entries.set(k, {
      value: cloneData(built.value),
      version,
      files: built.files,
      token,
    });
  }
  return { value: built.value, version, files: built.files, token };
}

/** Drops the store's memoised views: something outside the store changed (a bus topic was emitted). */
export function forgetViews(store: Store): void {
  viewMemos.delete(store);
}

export function crew(
  config: CcConfig,
  store: Store,
  now: number,
  /** The test lock: a seat in line for it is waiting, not stalled. */
  lock: TestLockState = NO_LOCK,
  /** The CLI version; tests pass a stub. */
  cliVersion: () => string | null = claudeVersion,
  /** The Overview's rows: no event timelines are built, current or set-aside (see `crewSummary`). */
  summary = false,
): Crew {
  const { value, ...basis } = memoised(
    store,
    now,
    ["crew", config, lock, identityOf(cliVersion), summary],
    () => buildCrew(config, store, now, lock, cliVersion, summary),
  );
  rowOrigins.set(value.rows, basis);
  return value;
}

function buildCrew(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState,
  cliVersion: () => string | null,
  summary: boolean,
): Crew {
  const boards = new Map<string, BoardItem[]>();
  const boardOf = (repoId: string): BoardItem[] => {
    let b = boards.get(repoId);
    if (!b) {
      b = config.repos.some((r) => r.id === repoId) ? store.board(repoId) : [];
      boards.set(repoId, b);
    }
    return b;
  };
  const ticketTitle = (ticket: string | null): string | null => {
    const t = ticket === null ? null : parseTicket(ticket);
    if (!t) return null;
    return boardOf(t.repoId).find((i) => i.issueNumber === t.number)?.title ?? null;
  };

  let version: string | null | undefined;
  const cliVersionOnce = (): string | null => {
    if (version === undefined) version = cliVersion();
    return version;
  };

  const prCache: PrCache = new Map();
  const configured = configuredAgents(config);
  const seatRows = store.seatSessions(
    configured.filter((agent) => agent.kind === "crew").map((agent) => agent.id),
  );
  const runsByAgent = store.runsForAgents(
    configured.map((agent) => agent.id),
    AGENT_RUNS,
    [...seatRows.values()].flatMap((seat) => (seat.runId === null ? [] : [seat.runId])),
  );
  const allRuns = [...runsByAgent.values()].flat();
  const latestRunIds = [...runsByAgent.entries()].flatMap(([agentId, runs]) => {
    const held = runs.find(
      (run) => run.id === seatRows.get(agentId)?.runId && run.agentId === agentId,
    );
    const latest = held?.endedAt === null ? held : runs[0];
    return latest ? [latest.id] : [];
  });
  const digestByRun = store.digests(latestRunIds);
  const contextWindows = store.digestContextWindows(allRuns.map((run) => run.id));
  const pullRequests = store.pullRequestsForRepos(config.repos.map((repo) => repo.id));
  for (const [repoId, rows] of pullRequests)
    prCache.set(repoId, new Map(rows.map((row) => [row.number, row])));
  const crewLoop = (run: Run, ticket: string | null): CrewLoop | null => {
    if (!run.loop) return null;
    const wait = runWait(config, store, run, run.loop, lock);
    return {
      phase: run.loop.phase,
      text: loopText(ticket, run.loop),
      prNumber: run.loop.prNumber,
      parked: run.loop.phase === "parked" ? (run.loop.parked?.reason ?? null) : null,
      tries: runTries(store, run, run.loop),
      wait,
      ...(wait === "seat" ? { waitText: reworkWaitText(store, run) } : {}),
      ...(run.profile
        ? {
            profile: run.profile.profile.name,
            step: profileStep(run.profile.profile, run.loop.phase),
            steps: run.profile.profile.steps.map((s) => ({ name: s.name, phase: s.phase })),
            planned: store.planLanded(run),
          }
        : {}),
    };
  };
  const eventIndex = summary ? null : runEventsIndex(store, now);
  const asideAll = store.asideRuns();
  const reviewsInFlight = store.reviewsIn(REVIEWING);
  const rows = loopViews(config, store, now, lock, runsByAgent, seatRows, digestByRun).map(
    ({ agent, runs, latest, view, seatRow }, index): CrewRow => {
      const digests = digestByRun;
      const digest = latest ? (digests.get(latest.id) ?? null) : null;
      let contextWindow: number | null = null;
      for (const r of runs) {
        const w = contextWindows.get(r.id) ?? null;
        if (w !== null) {
          contextWindow = w;
          break;
        }
      }
      const prs = latest ? runPrs(config, store, latest, prCache) : [];
      const ticket = latest ? runTicket(latest, prs) : null;
      const backgroundInFlight = (digest?.background.length ?? 0) > 0;
      const state =
        agent.kind === "crew"
          ? crewHudState(
              seatRow,
              view.lastOutputAt,
              now,
              seatRow?.runId != null && lock.waiting.some((w) => w.runId === seatRow.runId),
            )
          : hudState({
              state: view.state,
              paused: view.paused,
              stopped: view.stop !== null,
              lastOutputAt: view.lastOutputAt,
              now,
              backgroundInFlight,
            });
      // A stalled agent has been in that state since the silence reached the threshold, not
      // since its run began. A seat that wrote nothing counts from its row's last change. Never
      // before the view's own stateSince (the run start): output older than the run is no stall of it.
      const silentSince = view.lastOutputAt ?? seatRow?.updatedAt ?? null;
      const stateSince =
        state === "stalled" && silentSince !== null
          ? Math.max(
              stallStart(silentSince, agent.kind === "loop" && backgroundInFlight),
              view.stateSince,
            )
          : state === "waiting" && latest
            ? (lock.waiting.find((w) => w.runId === latest.id)?.since ?? view.stateSince)
            : view.stateSince;
      return {
        id: agent.id,
        ...(agent.kind === "crew" ? { crewPause: pausedSeat(store, agent.id) } : {}),
        ...(agent.kind === "crew" && agent.seat.displayCallSign !== undefined
          ? { displayCallSign: agent.seat.displayCallSign }
          : {}),
        ...(agent.kind === "crew" ? { focus: agent.seat.focus ?? null } : {}),
        repoId: agent.repoId,
        index,
        hudState: state,
        ...(eventIndex === null
          ? {}
          : { events: latest ? runEvents(store, latest, now, eventIndex) : [] }),
        stateSince,
        accountId: view.accountId,
        kind: view.kind,
        loopKind: view.loopKind,
        role: view.role,
        mode: view.mode,
        area: view.area,
        model: view.model,
        sessionId: view.sessionId,
        cli:
          agent.kind === "crew"
            ? {
                version: cliVersionOnce(),
                effort: agent.seat.effort ?? null,
                budgetUsd: latest?.profile?.profile.budgetUsd ?? null,
              }
            : { version: null, effort: null },
        review:
          agent.kind === "crew"
            ? reviewOf(
                store,
                agent.repoId,
                latest?.branch ?? null,
                reviewsInFlight,
                now,
                pullRequests.get(agent.repoId),
              )
            : null,
        reviewing: reviewingOf(store, latest),
        paused: view.paused,
        note: view.note,
        stop: view.stop,
        sourceError: view.sourceError,
        ticket,
        ticketTitle: latest ? runTicketTitle(latest, ticket, ticketTitle(ticket)) : null,
        loop: agent.kind === "crew" && latest ? crewLoop(latest, ticket) : null,
        asideRuns:
          agent.kind === "crew"
            ? asideAll
                .filter((r) => r.agentId === agent.id && r.id !== latest?.id)
                .flatMap((r): CrewAsideRun[] => {
                  const t = runTicket(r, runPrs(config, store, r, prCache));
                  const l = crewLoop(r, t);
                  return l
                    ? [
                        {
                          runId: r.id,
                          ...(eventIndex === null
                            ? {}
                            : { events: runEvents(store, r, now, eventIndex) }),
                          stateSince:
                            store.loopEventsOfRun(r.id).at(-1)?.at ?? r.endedAt ?? r.startedAt,
                          ticket: t,
                          ticketTitle: runTicketTitle(r, t, ticketTitle(t)),
                          loop: l,
                        },
                      ]
                    : [];
                })
            : [],
        queue: queueOf(store, agent),
        queuedMessages:
          agent.kind === "crew" && state === "parked" && seatRow
            ? store.commsCountTo(COMMS_CAPCOM, agent.id, seatRow.updatedAt)
            : 0,
        run: latest
          ? {
              id: latest.id,
              seq: latest.seq,
              startedAt: latest.startedAt,
              endedAt: latest.endedAt,
              status: latest.status,
              model: latest.model,
              branch: latest.branch,
              tokens: latest.tokens,
              costUsd: latest.costUsd,
              costEstimateUsd:
                agent.kind === "crew" ? costEstimate(store, agent.id, latest, digest, runs) : null,
            }
          : null,
        work:
          agent.kind === "crew" && latest
            ? {
                commits: store.runCommits(latest.id).length,
                denials: store.guardHitCount(latest.id),
              }
            : null,
        prs,
        summary: latest?.summary ?? null,
        digest: digest ? (({ toolStarts: _, attemptUsage: __, ...rest }) => rest)(digest) : null,
        contextWindow,
        lastOutputAt: view.lastOutputAt,
      };
    },
  );

  const dayStart = startOfLocalDay(now, config.operator.timezone);
  const agents = new Set(agentIds(config));
  let firstRunToday: number | null = null;
  for (const r of store.runsOverlapping(dayStart, now + 1)) {
    if (!agents.has(r.agentId) || r.startedAt < dayStart) continue;
    if (firstRunToday === null || r.startedAt < firstRunToday) firstRunToday = r.startedAt;
  }
  return { rows, firstRunToday };
}

const kindRank = (k: AttentionItem["kind"]): number => ATTENTION_KINDS.indexOf(k);

/** The watch's FLIGHT-down notes as items: folded into the one "FLIGHT is not triaging" item. */
const FLIGHT_DOWN_ITEMS: ReadonlySet<string> = new Set(
  FLIGHT_DOWN_NOTES.map((k) => `${NOTE_KEY}${k}`),
);

/**
 * Whether FLIGHT is triaging, and if not, why (FLIGHT_NOT_TRIAGING_CAUSES, "late" aside: that
 * depends on the items). `since`: when it stopped (its watch note, or its seat's last change);
 * `liveSince`: when its live run started, from which an item's triage window runs at the latest,
 * so FLIGHT coming back gets a fresh window rather than a backlog of missed ones.
 */
interface FlightTriage {
  flightId: string;
  repoId: string;
  triaging: boolean;
  /** Routes items as a live FLIGHT: live, or within the restart grace. */
  live: boolean;
  cause: Exclude<FlightNotTriagingCause, "late"> | null;
  /** The watch note's text, when one says why. */
  detail: string | null;
  since: number | null;
  liveSince: number;
  /** An "off" FLIGHT within FLIGHT_OFF_GRACE_MS: when the item will show, else null. */
  showsAt: number | null;
  /** The runaway breaker is tripped: FLIGHT stands down but the item shows only if items wait. */
  breaker?: boolean;
}

/**
 * The operator's call (#758): FLIGHT may brief it for the operator but never keep it, and it is
 * never folded into the "FLIGHT is not triaging" item. The decision kinds, the held hub Update,
 * and a run parked on its budget or account.
 */
export function isOperatorCall(item: Pick<AttentionItem, "key" | "kind">, store: Store): boolean {
  if (OPERATOR_CALL_KINDS.includes(item.kind)) return true;
  if (item.key === `${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`) return true;
  if (item.key === `${NOTE_KEY}${FLIGHT_RUNAWAY_NOTE_KEY}`) return true;
  if (item.kind !== "blocked") return false;
  const note = store.notes().find((n) => `${NOTE_KEY}${n.key}` === item.key);
  const park = note?.runId ? store.run(note.runId)?.loop?.parked?.kind : undefined;
  return (
    park === "budget" || park === "account" || park === CONTROLLER_CHECK_PARK || park === UAT_PARK
  );
}

/**
 * Kinds that, once FLIGHT misses them (or while nobody is triaging), reach the operator as
 * themselves so they notify as they always did: a stuck run, or an error a seat is stuck on, is
 * not news to fold into a count.
 */
const STUCK_KINDS: readonly AttentionItem["kind"][] = [
  "stalled",
  "blocked",
  "parked",
  "lock",
  "error",
];

/** Whether an item missed by FLIGHT reaches the operator as itself rather than being counted. */
const keptRaw = (item: Pick<AttentionItem, "key" | "kind">, store: Store): boolean =>
  isOperatorCall(item, store) || STUCK_KINDS.includes(item.kind);

/**
 * A seat's question FLIGHT passed to the operator with its brief: the operator's to answer, not
 * FLIGHT's. Passed without one (before #758), it is still FLIGHT's.
 */
export function questionWithOperator(
  q: { passedAt: number | null },
  brief: AttentionItem["brief"],
): boolean {
  return q.passedAt !== null && brief !== undefined && brief.for !== "flight";
}

/** When this hub process started (main.ts); null in a test or tool that never sets it. */
let hubStartedAt: number | null = null;
/** main.ts: a FLIGHT seat with no seat row yet counts as stopped since the hub started. */
export function markHubStarted(at: number | null): void {
  hubStartedAt = at;
}

/** Runs of FLIGHT walked back for `liveSince`: hours of a crash loop at FLIGHT_STARTS_MAX an hour. */
const LIVE_SINCE_RUNS = 30;

/**
 * When FLIGHT's current stretch of being up began: its live run's start, moved back over each
 * earlier run that ended within FLIGHT_OFF_GRACE_MS of the next one's start (a rotation, a quick
 * restart, a crash the watch recovered), so only a real outage gives items a fresh window and a
 * crash loop cannot keep resetting them.
 */
function flightLiveSince(store: Store, flightId: string, run: Run): number {
  let start = run.startedAt;
  for (const prev of store.runs(flightId, LIVE_SINCE_RUNS)) {
    if (prev.id === run.id || prev.startedAt >= start) continue;
    if (prev.endedAt === null || start - prev.endedAt > FLIGHT_OFF_GRACE_MS) break;
    start = prev.startedAt;
  }
  return start;
}

function flightTriage(config: CcConfig, store: Store, now: number): FlightTriage | null {
  const triage = flightTriageNow(config, store, now);
  if (triage === null) return null;
  // items raised while the breaker held FLIGHT back get a fresh window after the lift
  return { ...triage, liveSince: Math.max(triage.liveSince, runawayLiftedAt(store)) };
}

function flightTriageNow(config: CcConfig, store: Store, now: number): FlightTriage | null {
  const found = flightSeat(config);
  if (found === null) return null;
  const flightId = found.seat.id;
  // FLIGHT's writes are stopped until the operator lifts the breaker, so it triages nothing:
  // items reach the operator at once
  const tripped = runawayTrip(store);
  if (tripped !== null) {
    return {
      flightId,
      repoId: found.session.repoId,
      triaging: false,
      live: false,
      cause: "down",
      detail: RUNAWAY_TRIAGE_DETAIL,
      since: tripped.at,
      liveSince: 0,
      showsAt: null,
      breaker: true,
    };
  }
  const live = flightLive(config, store);
  const notes = store.notes().filter((n) => n.dismissedAt === null);
  const note =
    notes.find((n) => n.key === FLIGHT_NOTE_KEY) ??
    notes.find((n) => n.key === FLIGHT_DOWN_NOTE_KEY);
  const row = store.seatSession(flightId);
  const run = row?.runId == null ? null : store.run(row.runId);
  const base = { flightId, repoId: found.session.repoId, live, liveSince: 0, showsAt: null };
  if (note !== undefined) {
    return {
      ...base,
      triaging: false,
      cause: note.key === FLIGHT_NOTE_KEY ? "start-failed" : "down",
      detail: note.text,
      since: note.at,
      liveSince: live && run !== null ? flightLiveSince(store, flightId, run) : 0,
    };
  }
  if (live) {
    return {
      ...base,
      triaging: true,
      cause: null,
      detail: null,
      since: null,
      liveSince: run === null ? 0 : flightLiveSince(store, flightId, run),
    };
  }
  // never run: down since this hub started (a test without a start time: just now, so in grace)
  const since = row === null ? (hubStartedAt ?? now) : Math.max(row.updatedAt, run?.endedAt ?? 0);
  if (row?.state === "stopped") {
    return { ...base, triaging: false, cause: "stopped", detail: null, since };
  }
  // parked is an outage, not a restart: no grace (the watch's note, when raised, says more)
  if (row?.state === "parked") {
    return { ...base, triaging: false, cause: "down", detail: "FLIGHT is parked.", since };
  }
  const showsAt = since + FLIGHT_OFF_GRACE_MS;
  if (now < showsAt) {
    // Within the restart grace (a rotation, a crash the watch recovers, a hub restart) FLIGHT
    // still counts as triaging, so items keep their windows and a "late" item carries through
    // rather than vanishing and notifying again when FLIGHT is back.
    const last = run ?? store.runs(flightId, 1)[0] ?? null;
    return {
      ...base,
      live: true,
      triaging: true,
      cause: null,
      detail: null,
      since,
      liveSince: last === null ? 0 : flightLiveSince(store, flightId, last),
      showsAt,
    };
  }
  return { ...base, triaging: false, cause: "off", detail: null, since };
}

/** When a not-running FLIGHT's grace ends and its "not triaging" item shows; null if not pending. */
export function flightNotTriagingDueAt(config: CcConfig, store: Store, now: number): number | null {
  return flightTriage(config, store, now)?.showsAt ?? null;
}

/** "14:05" today, "27 Oct 14:05" before today, in the operator's timezone. */
function sinceText(at: number, now: number, timeZone: string): string {
  const hm = clockHm(at, timeZone);
  if (at >= startOfLocalDay(now, timeZone)) return hm;
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(
    at,
  );
  return `${day} ${hm}`;
}

/** An attention item before its ack is read; the server always knows its owner. */
type OwnedItem = Omit<AttentionItem, "acked" | "owner"> & { owner: AttentionOwner };

/** Escalation kinds that name the operator; any other is a loop's own. */
const OPERATOR_ESCALATIONS: readonly Escalation["kind"][] = [
  "operator-decision",
  "mvp-ready",
  "autonomy-question",
];

/** The login a draft PR belongs to when it is not the hub's: its author, else an assignee. */
function otherLogin(
  pr: Pick<PullRequestView, "author" | "assignees">,
  hubLogin: string | null,
): string | null {
  if (hubLogin === null) return null;
  const logins = [pr.author ?? null, ...(pr.assignees ?? [])];
  return logins.find((l): l is string => l !== null && l !== hubLogin) ?? null;
}

/**
 * Needs-you items: every escalation, every stalled loop (keyed by run and last output, so a new
 * stall, on a new run or later in the same one, pulses again) and every loop in error (keyed by
 * its last success, so a failure after a recovery pulses again); the crew's strays, open
 * questions and unacked errors; and the test lock when its holder has stalled with seats in line.
 * Messages are not needs: unread chatter is counted on its Comms thread. FLIGHT's own lines count
 * only as an `@CAPCOM` question (a `tag` for the operator); another agent's `@CAPCOM` tag, or a
 * question on its direct line, is FLIGHT's to triage and reaches the operator only through a brief
 * FLIGHT writes for them. So is a seat's `ask_flight` question: its `ask:` item alone (never also
 * the Comms line that mirrors it), FLIGHT's from the start until FLIGHT briefs it for the operator.
 * While FLIGHT is not triaging, one "FLIGHT is not triaging" item stands for all of them.
 * Sorted by ATTENTION_KINDS order, then time; `acked` from the acks table.
 */
export function attentionItems(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState = NO_LOCK,
  /** The crew rows at `now` (built with `lock`), when the caller has already built them. */
  rows?: CrewRow[],
  /** The hub's own `gh` login, to tell another login's draft PRs from its own; null when unread. */
  hubLogin: string | null = null,
  includeHeld = false,
): AttentionItem[] {
  // no caller's rows: the summary crew, since attention never reads the event timelines
  const given = rows ?? crew(config, store, now, lock, undefined, true).rows;
  const origin = rowOrigins.get(given);
  return memoised(
    store,
    now,
    ["attention", config, lock, origin?.token ?? identityOf(given), hubLogin, includeHeld],
    () => buildAttentionItems(config, store, now, lock, given, hubLogin, includeHeld),
    origin,
  ).value;
}

function buildAttentionItems(
  config: CcConfig,
  store: Store,
  now: number,
  lock: TestLockState,
  rows: CrewRow[],
  hubLogin: string | null,
  includeHeld: boolean,
): AttentionItem[] {
  const acks = store.acks();
  const briefs = store.briefs();
  const status = new Map(store.status().map((s) => [s.collector, s]));
  const items: OwnedItem[] = [];

  const flightId = flightSeat(config)?.seat.id ?? null;
  for (const agent of configuredAgents(config)) {
    const own = agent.id === flightId;
    // with no FLIGHT seat, another agent's chatter has nobody to triage it but its Comms thread
    if (!own && flightId === null) continue;
    const lines = attentionChatter(store, agent.id, agent.kind === "crew", own);
    for (const kind of ["tag", "message"] as const) {
      const messages = lines[kind];
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) continue;
      // Another agent's item is keyed on its first unread line, so a brief stays attached while it
      // writes again until the thread is read. FLIGHT's own question is the operator's to ack, and
      // each new one is a new ask.
      const keyed = own ? last : first;
      items.push({
        // routed below: FLIGHT's question stays the operator's; another agent's line is FLIGHT's
        // unless FLIGHT briefs it for the operator
        owner: OWNER_OPERATOR,
        key: `${kind}:${agent.id}:${keyed.id}`,
        kind,
        agentId: agent.id,
        repoId: agent.repoId,
        text: kind === "tag" ? last.text.replace(/^[→←]\s*[^:]+:\s*/, "") : last.text,
        at: last.at ?? 0,
        messageAt: last.at,
        tool: null,
        url: null,
        escalationId: null,
        ticket: last.ticket,
      });
    }
  }

  // A labelled direct question or blocker stays in its conversation while its addressee has the
  // first fifteen minutes to react. After that it is a durable FLIGHT triage item, rather than an
  // unbounded stream of unread-chatter items.
  for (const message of store.openCommsItems()) {
    const author = config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === message.from);
    if (message.at < COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT) continue;
    if (now < message.at + COMMS_FLIGHT_ESCALATION_MS) continue;
    const ticket = /^(.+)#(\d+)$/.exec(message.ticket ?? "");
    const prNumber = /^PR (\d+)$/.exec(message.ref ?? "")?.[1];
    const flight = flightSeat(config);
    const senderRepoId =
      message.from === flight?.seat.id
        ? flight.session.repoId
        : config.crew?.sessions.find((session) =>
            session.seats.some((seat) => seat.id === message.from),
          )?.repoId;
    const repoId =
      ticket?.[1] ??
      senderRepoId ??
      (prNumber === undefined
        ? undefined
        : (store.commsForTicket(message.ref ?? "", message.ticket ?? undefined).repoId ??
          undefined));
    if (
      resolvedCommsReason(
        store,
        message,
        author !== undefined && author.role !== "FLIGHT",
        repoId,
      ) !== null
    )
      continue;
    items.push({
      owner: OWNER_OPERATOR,
      key: `${COMMS_OPEN_PREFIX}${message.id}`,
      kind: message.label === "blocker" ? "blocked" : "question",
      agentId: message.from,
      repoId: repoId ?? null,
      text: message.text,
      tool: null,
      at: message.at,
      messageAt: message.at,
      url: null,
      escalationId: null,
      ticket: message.ticket,
    });
  }

  for (const e of store.escalations()) {
    // an escalation whose issue the board has since seen closed no longer holds
    if (store.board(e.repoId).some((b) => b.issueNumber === e.issueNumber && b.closed)) continue;
    // A paused, parked or stopped loop asks nobody: its open escalations stay on its card until
    // it runs again.
    const loopRow = rows.find((r) => r.kind === "loop" && r.repoId === e.repoId);
    const loopIdle =
      loopRow !== undefined &&
      (loopRow.paused || loopRow.hudState === "parked" || loopRow.hudState === "stopped");
    items.push({
      // a needs-you label asks the operator whatever the kind, unless its loop is paused, parked or
      // stopped; a [loop-blocked] title is always the loop's
      owner:
        !loopIdle && (e.source === "label" || OPERATOR_ESCALATIONS.includes(e.kind))
          ? OWNER_OPERATOR
          : OWNER_LOOP,
      key: `esc:${e.id}`,
      kind: escalationKind(e),
      agentId: config.loops.find((l) => l.repoId === e.repoId)?.id ?? null,
      repoId: e.repoId,
      text: e.title,
      tool: null,
      at: e.openedAt,
      url: e.url,
      escalationId: e.id,
      ticket: e.id,
    });
  }

  for (const row of rows) {
    if (row.hudState === "stalled" && row.run && row.lastOutputAt !== null) {
      items.push({
        owner: row.kind === "loop" ? OWNER_LOOP : OWNER_OPERATOR,
        key: `stall:${row.id}:${row.run.id}:${row.lastOutputAt}`,
        kind: "stalled",
        agentId: row.id,
        repoId: row.repoId,
        text: STALL_TEXT,
        tool: row.digest?.liveTool?.name ?? null,
        at: row.lastOutputAt,
        url: null,
        escalationId: null,
        ticket: null,
      });
    } else if (row.hudState === "error" && row.sourceError !== null) {
      // Every error row has a sourceError: loopViews gives a failing collector "collector failed"
      // when it stored no text, and a seat "seat error".
      // A loop's error is keyed by its collector's last success; a seat's by its last state change.
      const st =
        row.loopKind === "crew" ? undefined : status.get(collectorName(row.loopKind, row.id));
      items.push({
        owner: row.kind === "loop" ? OWNER_LOOP : OWNER_OPERATOR,
        key:
          row.kind === "crew"
            ? `error:${row.id}:${row.stateSince}`
            : `error:${row.id}:${st?.lastOkAt ?? "never"}`,
        kind: "error",
        agentId: row.id,
        repoId: row.repoId,
        text: row.sourceError,
        tool: null,
        // stable while it keeps failing: its ack and brief must not age with every poll
        at:
          row.kind === "crew"
            ? row.stateSince
            : (st?.lastOkAt ?? st?.failingSince ?? st?.at ?? now),
        url: null,
        escalationId: null,
        ticket: null,
      });
    }
  }

  // A PR waits on you when it is linked to a ticket on a configured board and no agent is running
  // on that ticket (the loops merge their own PRs; see PR_WAIT_MS). A ticket whose run is still
  // open is the crew's, whether or not a seat is running on it (set aside, queued, held).
  const working = new Set(
    rows.filter((r) => r.run?.status === "running" && r.ticket !== null).map((r) => r.ticket),
  );
  for (const ticket of store.activeTickets()) working.add(ticket);
  for (const repo of config.repos) {
    // a paused, parked or stopped loop's PRs wait on nobody: they stay on its card
    const loopRow = rows.find((r) => r.kind === "loop" && r.repoId === repo.id);
    if (
      loopRow !== undefined &&
      (loopRow.paused || loopRow.hudState === "parked" || loopRow.hudState === "stopped")
    )
      continue;
    // a ticket the board has seen closed clears its PR's item
    const onBoard = new Set(
      store
        .board(repo.id)
        .filter((b) => !b.closed)
        .map((b) => `${repo.id}#${b.issueNumber}`),
    );
    for (const pr of store.pullRequests(repo.id)) {
      if (pr.ticket === null || !onBoard.has(pr.ticket)) continue;
      const action = prYouAction(pr, working.has(pr.ticket), now);
      if (action === null) continue;
      // a draft another login's run opened is that lane's to decide
      const lane = pr.isDraft ? otherLogin(pr, hubLogin) : null;
      const crewed = config.crew?.sessions.some((session) => session.repoId === repo.id) ?? false;
      const loopOwner =
        loopRow && (!crewed || pr.branch === loopRow.run?.branch || pr.ticket === loopRow.ticket)
          ? loopRow
          : null;
      items.push({
        owner: loopOwner
          ? OWNER_LOOP
          : lane === null
            ? pr.isDraft
              ? OWNER_CONTROLLER
              : OWNER_OPERATOR
            : laneOwner(lane),
        key: `pr:${pr.repoId}#${pr.number}:${pr.updatedAt}`,
        kind: "pr",
        agentId: loopOwner?.id ?? null,
        repoId: pr.repoId,
        text: `PR #${pr.number} · ${loopOwner ? (loopOwner.displayCallSign ?? loopOwner.id) : pr.isDraft ? "Controller" : "You"}: ${action}`,
        tool: null,
        at: pr.updatedAt,
        url: pr.url,
        escalationId: null,
        ticket: pr.ticket,
      });
    }
  }

  // A person waits on you: an open GitHub notification thread of a configured repo.
  const crewed = new Set(config.repos.map((r) => r.id));
  for (const n of store.notifications()) {
    if (!crewed.has(n.repoId) || !notificationOpen(n) || n.message?.disposition === "digest")
      continue;
    items.push({
      owner: OWNER_OPERATOR,
      key: personKey(n),
      kind: "person",
      agentId: null,
      repoId: n.repoId,
      text: personText(n),
      tool: null,
      at: n.updatedAt,
      url: n.url,
      escalationId: null,
      ticket: n.subjectType === "Issue" && n.number !== null ? `${n.repoId}#${n.number}` : null,
    });
  }

  items.push(...crewItems(config, store, lock, rows, now));

  const triage = flightTriage(config, store, now);
  const live = triage?.live ?? false;
  const triaging = triage?.triaging ?? false;
  // FLIGHT's own questions (from before #758, when it had a question tool) stay the operator's.
  const flightAsks = new Set(
    store
      .openQuestions()
      .filter((q) => q.agentId === flightId)
      .map((q) => `ask:${q.id}`),
  );
  /**
   * Missed or late: with a FLIGHT seat it stays FLIGHT's, counted by the one not-triaging item,
   * except an operator's call or a stuck run, which reaches the operator as itself.
   */
  const missed = (item: AttentionItem, triageDueAt?: number): AttentionItem => ({
    ...item,
    ...(triage === null || keptRaw(item, store) ? {} : { owner: OWNER_FLIGHT }),
    flightTriage: "missed",
    ...(triageDueAt === undefined ? {} : { triageDueAt }),
  });
  const route = (i: OwnedItem): AttentionItem => {
    const saved = briefs.get(i.key);
    // A cleared and re-raised note may reuse its key; the old triage must not keep it hidden.
    const brief = saved?.for === "flight" && saved.at < i.at ? undefined : saved;
    // An ack covers the item as it was: a re-raised note, a newer line or a new or changed ask
    // for the operator is unread again.
    const ackAt = acks.get(i.key);
    const askAt = brief !== undefined && brief.for !== "flight" ? (brief.askAt ?? brief.at) : 0;
    const item: AttentionItem = {
      ...i,
      ...(brief === undefined ? {} : { brief }),
      acked: ackAt !== undefined && ackAt >= Math.max(i.at, askAt),
    };
    if (
      brief?.for === "operator" &&
      brief.recommendation.trim() !== "" &&
      (i.owner === OWNER_CONTROLLER || i.owner === OWNER_FLIGHT)
    )
      return { ...item, owner: OWNER_OPERATOR };
    // A seat's question is FLIGHT's from the start (#758); only FLIGHT's brief makes it the
    // operator's. With no FLIGHT seat nobody else can answer it, so it is the operator's.
    const seatAsk = i.kind === "question" && i.key.startsWith("ask:") && !flightAsks.has(i.key);
    const unansweredComms = i.key.startsWith(COMMS_OPEN_PREFIX);
    if (unansweredComms && triage !== null) {
      if (brief !== undefined && brief.for !== "flight") return item;
      if (!triaging) return { ...item, owner: OWNER_FLIGHT, flightTriage: "down" };
      if (brief?.for === "flight")
        return { ...item, owner: OWNER_FLIGHT, flightTriage: "handling" };
      const triageDueAt = i.at + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS;
      return now < triageDueAt
        ? { ...item, owner: OWNER_FLIGHT, flightTriage: "waiting", triageDueAt }
        : missed(item, triageDueAt);
    }
    if (seatAsk && triage !== null) {
      if (brief !== undefined && brief.for !== "flight") return item;
      if (brief?.for === "flight" && now - brief.at >= FLIGHT_HANDLING_MAX_MS) return missed(item);
      if (!triaging) return { ...item, owner: OWNER_FLIGHT, flightTriage: "down" };
      if (brief?.for === "flight")
        return { ...item, owner: OWNER_FLIGHT, flightTriage: "handling" };
      const triageDueAt = Math.max(i.at, triage.liveSince) + FLIGHT_TRIAGE_WAIT_MS;
      return now < triageDueAt
        ? { ...item, owner: OWNER_FLIGHT, flightTriage: "waiting", triageDueAt }
        : missed(item, triageDueAt);
    }
    if (brief?.for === "flight" && !protectedDecisionItem(store, item, config, now))
      return { ...item, owner: OWNER_FLIGHT, flightTriage: triaging ? "handling" : "down" };
    if (i.owner !== OWNER_OPERATOR || flightAsks.has(i.key) || ownReply(i, flightId)) return item;
    // what FLIGHT left undecided twice is the operator's, never FLIGHT's to triage
    if (i.key === `${NOTE_KEY}${FLIGHT_LEFT_NOTE_KEY}`) return item;
    if (brief !== undefined && brief.for !== "flight") return item;
    if (brief?.for === "flight" && now - brief.at >= FLIGHT_HANDLING_MAX_MS) return missed(item);
    // nobody is triaging: an operator's call or a stuck run goes straight to the operator
    if (!live || (!triaging && keptRaw(i, store))) return item;
    if (brief?.for === "flight") return { ...item, owner: OWNER_FLIGHT, flightTriage: "handling" };
    // A PR only becomes an attention item after its existing quiet wait.
    const raisedAt =
      i.kind === "stalled"
        ? (rows.find((r) => r.id === i.agentId)?.stateSince ?? i.at)
        : i.at + (i.kind === "pr" ? PR_WAIT_MS : 0);
    const triageDueAt = Math.max(raisedAt, triage?.liveSince ?? 0) + FLIGHT_TRIAGE_WAIT_MS;
    return now < triageDueAt
      ? { ...item, owner: OWNER_FLIGHT, flightTriage: "waiting", triageDueAt }
      : missed(item, triageDueAt);
  };
  const result: AttentionItem[] = items
    // the watch's FLIGHT-down notes are the not-triaging item's reason, never items of their own
    .filter((i) => !FLIGHT_DOWN_ITEMS.has(i.key))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.at - b.at)
    .map((i) => {
      const item = route(i);
      // Another agent's tag or direct-line question stays FLIGHT's, even untriaged, until FLIGHT
      // briefs it for the operator (ownReply keeps FLIGHT's own question tag the operator's).
      // While FLIGHT is not triaging it is still FLIGHT's, counted by the not-triaging item.
      const chatter = (i.kind === "tag" || i.kind === "message") && !ownReply(i, flightId);
      const briefed = item.brief !== undefined && item.brief.for !== "flight";
      if (!chatter || briefed || item.owner !== OWNER_OPERATOR) return item;
      return triaging
        ? { ...item, owner: OWNER_FLIGHT }
        : { ...item, owner: OWNER_FLIGHT, flightTriage: "down" };
    });
  const partition = partitionAttention(
    store,
    result.map((item) => {
      const d = decisionDefault(store, item, config, now);
      return d === null ? item : { ...item, defaultDueAt: d.dueAt };
    }),
    acks,
  );
  const shown =
    triage === null
      ? partition.items
      : withNotTriaging(partition.items, triage, acks, now, config.operator.timezone);
  return includeHeld ? [...shown, ...partition.held] : shown;
}

/**
 * Adds the one "FLIGHT is not triaging" item (#758) when FLIGHT is not triaging, or is live but
 * has let one or more items pass their triage window. It counts what waits on FLIGHT meanwhile:
 * items marked down or missed, and while FLIGHT is reported down, those still in their window.
 * Those stay FLIGHT's, listed under it, so Needs you shows one item instead of N raw ones.
 */
function withNotTriaging(
  items: AttentionItem[],
  triage: FlightTriage,
  acks: Map<string, number>,
  now: number,
  timeZone: string,
): AttentionItem[] {
  const members = items
    .filter(
      (i) =>
        i.owner === OWNER_FLIGHT &&
        (i.flightTriage === "down" ||
          i.flightTriage === "missed" ||
          (!triage.triaging && i.flightTriage === "waiting")),
    )
    .sort((a, b) => a.at - b.at);
  // a tripped breaker is the flag's business: the item adds nothing unless something waits
  if (triage.breaker === true && members.length === 0) return items;
  const cause: FlightNotTriagingCause | null =
    triage.cause ?? (triage.triaging && members.length > 0 ? "late" : null);
  if (cause === null) return items;
  const dated = members.filter((i) => i.at > 0);
  const since = dated.length === 0 ? null : Math.min(...dated.map((i) => i.at));
  const lateAt = Math.min(...members.map((i) => i.triageDueAt ?? i.at));
  const at = since ?? (cause === "late" ? lateAt : (triage.since ?? 0));
  const ackAt = acks.get(FLIGHT_NOT_TRIAGING_KEY);
  const item: AttentionItem = {
    key: FLIGHT_NOT_TRIAGING_KEY,
    kind: "blocked",
    owner: OWNER_OPERATOR,
    agentId: triage.flightId,
    repoId: triage.repoId,
    text: flightNotTriagingText(
      cause,
      members.length,
      since === null ? null : sinceText(since, now, timeZone),
      triage.detail,
    ),
    tool: null,
    at,
    url: null,
    escalationId: null,
    ticket: null,
    notTriaging: { cause, keys: members.map((i) => i.key), since },
    // read as it was: a member raised after the ack makes it unread again
    acked: ackAt !== undefined && ackAt >= Math.max(at, ...members.map((i) => i.at)),
  };
  return [item, ...items];
}

/** Identity of the ask and brief, independent of refresh time and read state. */
export function attentionVersion(item: AttentionItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: item.key,
        kind: item.kind,
        text: item.text,
        at: item.at,
        brief: item.brief,
      }),
    )
    .digest("hex");
}

/**
 * Whether an ended run's park is past acting on: its PR is merged or closed, or its ticket is
 * closed, gone from its repo's board, or in a repo no longer configured. A repo whose board was
 * never read keeps the note.
 */
function endedParkGone(
  config: CcConfig,
  store: Store,
  run: Run,
  boardOf: (repoId: string) => BoardItem[],
): boolean {
  const loop = run.loop;
  if (loop?.phase !== "parked" || loop.parked?.kind !== "ended") return false;
  const prs = store.pullRequests(run.repoId);
  const pr =
    loop.prNumber !== null
      ? prs.find((p) => p.number === loop.prNumber)
      : run.branch === null
        ? undefined
        : prs
            .filter((p) => p.branch === run.branch && p.createdAt >= run.startedAt)
            .sort((a, b) => b.number - a.number)[0];
  if (pr !== undefined && pr.state !== "open") return true;
  const t = run.ticket === null ? null : parseTicket(run.ticket);
  if (!t) return false;
  if (!config.repos.some((r) => r.id === t.repoId)) return true;
  const board = boardOf(t.repoId);
  if (board.length === 0) return false;
  const item = board.find((b) => b.issueNumber === t.number);
  return item === undefined || item.closed;
}

/**
 * Who an engine note waits on: housekeeping is the controller's; a hard-rule flag is the
 * operator's, unless the repo's rules say the controller merges hard-rule PRs.
 */
function noteOwner(
  store: Store,
  n: Pick<AttentionNote, "key" | "repoId" | "runId">,
): AttentionOwner {
  if (
    n.repoId !== null &&
    store.getSetting(hardRulesBySettingKey(n.repoId)) === "flight" &&
    (isHardRulesFlagKey(n.key) || n.key.startsWith("ready:"))
  ) {
    const loop = n.runId === null ? null : store.run(n.runId)?.loop;
    return loop && !flightFloorBlocked(loop) ? OWNER_FLIGHT : OWNER_OPERATOR;
  }
  if (isCleanupNoteKey(n.key) || isFlakeNoteKey(n.key) || isNoReportNoteKey(n.key))
    return OWNER_CONTROLLER;
  if (
    isHardRulesFlagKey(n.key) &&
    n.repoId !== null &&
    store.getSetting(hardRulesBySettingKey(n.repoId)) === OWNER_CONTROLLER
  ) {
    return OWNER_CONTROLLER;
  }
  return OWNER_OPERATOR;
}

/** The crew's own Needs-you items: strays, questions, crew errors and a blocked test lock. */
function crewItems(
  config: CcConfig,
  store: Store,
  lock: TestLockState,
  rows: CrewRow[],
  now: number,
): OwnedItem[] {
  const sessions = config.crew?.sessions ?? [];
  const repoOfSeat = (seatId: string) =>
    sessions.find((s) => s.seats.some((x) => x.id === seatId))?.repoId ?? null;
  const item = (
    i: Pick<AttentionItem, "key" | "kind" | "agentId" | "repoId" | "text" | "at"> & {
      owner?: AttentionOwner;
      path?: string | null;
      sessionId?: string | null;
    },
  ): OwnedItem => ({
    ...i,
    owner: i.owner ?? OWNER_OPERATOR,
    tool: null,
    url: null,
    escalationId: null,
    ticket: null,
  });
  const out: OwnedItem[] = [];
  const boards = new Map<string, BoardItem[]>();
  const boardOf = (repoId: string): BoardItem[] => {
    let b = boards.get(repoId);
    if (!b) {
      b = store.board(repoId);
      boards.set(repoId, b);
    }
    return b;
  };

  for (const s of store.strays()) {
    const session = sessions.find((x) => x.id === s.sessionId);
    // the writer whose area holds it, by today's config; none: it reads as outside every area
    const owner =
      s.kind === "other-area"
        ? (session?.seats.find(
            (w) =>
              w.id !== s.agentId &&
              seatDef(w).mode === "writer" &&
              w.area.length > 0 &&
              pathInArea(w.area, s.path),
          ) ?? null)
        : null;
    out.push(
      item({
        key: s.key,
        kind: "stray",
        agentId: s.agentId,
        repoId: session?.repoId ?? null,
        path: s.path,
        sessionId: s.sessionId,
        text: strayText(s.path, s.sessionId, owner === null ? null : seatCallSign(owner.id)),
        at: s.at,
      }),
    );
  }

  for (const q of store.openQuestions()) {
    out.push(
      item({
        key: `ask:${q.id}`,
        kind: "question",
        agentId: q.agentId,
        repoId: repoOfSeat(q.agentId),
        text: questionText(seatCallSign(q.agentId), q.text),
        at: q.at,
      }),
    );
  }

  // The engine's notes: blocked, ready for review, check before merging, rate-limited. Each
  // goes when the engine clears it.
  for (const n of store.notes()) {
    if (n.dismissedAt !== null) continue;
    if (isHardRulesFlagKey(n.key) || isFlakeNoteKey(n.key)) continue;
    const run = n.runId === null ? null : store.run(n.runId);
    if (
      n.kind === "blocked" &&
      noteOwner(store, n) !== OWNER_CONTROLLER &&
      run !== null &&
      endedParkGone(config, store, run, boardOf)
    )
      continue;
    const pr =
      run?.loop?.prNumber === undefined || run.loop.prNumber === null
        ? undefined
        : store.pullRequests(run.repoId).find((p) => p.number === run.loop?.prNumber);
    const noteItem: OwnedItem = {
      owner: noteOwner(store, n),
      key: `${NOTE_KEY}${n.key}`,
      kind: n.kind,
      agentId: n.seatId,
      repoId: n.repoId,
      text: n.text,
      tool: null,
      at: n.at,
      url: pr?.url ?? null,
      escalationId: null,
      ticket: run?.ticket ?? null,
    };
    const ticket = run?.ticket ? parseTicket(run.ticket) : null;
    const resolved =
      run !== null &&
      (run.endedAt !== null ||
        (n.kind === "blocked" && run.loop?.parked == null && (run.loop?.unparkedAt ?? 0) > n.at) ||
        (n.kind === "blocked" && confirmedResumeAfter(store, run, n.at)) ||
        run.loop?.phase === "done" ||
        (pr !== undefined && pr.state !== "open") ||
        (ticket !== null &&
          boardOf(ticket.repoId).some(
            (b) => b.issueNumber === ticket.number && (b.closed || b.state === "done"),
          )));
    const approvalPending = run !== null && pendingRunApproval(store, run, pr);
    const subjectClosed =
      pr !== undefined &&
      pr.state !== "open" &&
      (pr.mergedAt ?? (pr.state === "closed" ? pr.updatedAt : 0)) >= n.at &&
      run?.loop?.parked?.kind !== "budget" &&
      run?.loop?.parked?.kind !== "account" &&
      (run === null || store.seatSession(run.agentId)?.state !== "stopped");
    if (
      (n.kind === "blocked" || n.kind === "review") &&
      noteItem.owner !== OWNER_CONTROLLER &&
      resolved &&
      !approvalPending &&
      (subjectClosed || !protectedDecisionItem(store, { ...noteItem, acked: false }, config, now))
    )
      continue;
    out.push(noteItem);
  }

  for (const e of store.crewErrors()) {
    out.push(
      item({
        key: `${CREW_ERROR_KEY}${e.id}`,
        kind: "error",
        agentId: e.agentId,
        repoId: repoOfSeat(e.agentId),
        text: e.text,
        at: e.at,
      }),
    );
  }

  const holder = lock.holder;
  const holderRow = holder === null ? undefined : rows.find((r) => r.id === holder.seatId);
  if (holder !== null && holderRow?.hudState === "stalled" && lock.waiting.length > 0) {
    const waiting = [...new Set(lock.waiting.map((w) => seatCallSign(w.seatId)))];
    out.push(
      item({
        key: `lock:${holder.runId}:${holder.since}`,
        kind: "lock",
        agentId: holder.seatId,
        repoId: holderRow.repoId,
        text: lockBlockedText(waiting, seatCallSign(holder.seatId)),
        at: holderRow.lastOutputAt ?? holder.since,
      }),
    );
  }
  return out;
}
