/**
 * The engine drives each looped run from report to merged. It holds no state a restart would
 * lose for reconciliation: every pass rebuilds a snapshot from stored facts, asks `reconcile`
 * (the pure function in `@mc/core`) what to do, stores the new loop, then runs the actions. A failure
 * is logged and comes out again on the next pass; the lines it sends are keyed, so a repeat is
 * never written twice.
 *
 * Triggers (each runs `reconcileRun` on the run's own chain, one pass at a time): a seat leaving
 * a turn, `report_evidence`, a run ending, the GitHub poll, and the 60 s tick. It is off when
 * crew is disabled, in a preview, or with `MC_NO_LOOP_WRITES=1` (`enabled`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  AWAY_BUG_VERIFIED,
  AWAY_DOC_PATH,
  AWAY_FIXTURE_DIR,
  AWAY_STATUS_ADDED,
  AWAY_TEST_PATH,
  AWAY_WRITES_REFUSED,
  asideEventText,
  asideForReworkEventText,
  asideInCiEventText,
  awayBugDecisionAbout,
  awayDiffSafe,
  awayTicketType,
  BLOCKING_SEVERITIES,
  blockedNoteKey,
  CI_FAILED_EVENT_PREFIX,
  CI_FAILED_TEXT,
  CI_PASSED_EVENT_PREFIX,
  CI_RERUN_FAILED_EVENT_PREFIX,
  CI_RERUN_FAILED_TEXT,
  COMMS_CAPCOM,
  COMMS_MC,
  COMMS_MESSAGE_MAX,
  CONTROLLER_CHECK_PARK,
  CONTROLLER_CHECK_USE_ROUTE,
  cardMark,
  carriedFrom,
  checkState,
  ciVerdict,
  cleanupBranchNoteKey,
  closedIssueText,
  commsMirror,
  conflictCommsText,
  conflictKey,
  conflictText,
  controllerCheckFailText,
  controllerCheckParkText,
  controllerCheckUnreadableText,
  deletedLocalText,
  deletedRemoteText,
  ENGINE_TICK_MS,
  EVIDENCE_REMIND_MS,
  EVIDENCE_RULING_PREFIX,
  effectiveHardRules,
  evidenceNoteKey,
  FLIGHT_ANSWER_WAIT_MS,
  FLIGHT_FLOOR_ENFORCING_PATHS,
  fillLoopText,
  fixCommsText,
  fixKey,
  fixSentText,
  fixText,
  gateView,
  hardRulesBySettingKey,
  hardRulesUnsetNoteKey,
  hardRulesUnsetText,
  hudColumnOf,
  isDollarCapReason,
  isReviewBudgetFailure,
  type LoopAction,
  type LoopReviewFacts,
  type LoopSnapshot,
  localNotDeletedText,
  MC_PUSH_CHECKS,
  MC_RUN_ENDED,
  MC_SYNC_DIRTY,
  MC_SYNC_NOT_WORKING,
  MC_SYNC_OFF,
  MC_SYNC_UP_TO_DATE,
  MERGE_HOLD_PARK,
  MERGE_HOLD_USE_ROUTE,
  MERGE_STEP_WORDS,
  type MergeStep,
  MINOR_CLEARED,
  MINOR_POSTED,
  mainConflictText,
  mergedMainText,
  mergedText,
  mergeHoldParkText,
  mergeStepFailedText,
  minorIssueFailedText,
  minorNotPostedText,
  modeOfSeat,
  NEW_LOOP,
  parkedEventText,
  pendingSeatWork,
  pendingWakeText,
  REFUSAL_TRIES,
  REVIEW_STATUS_CONTEXT,
  REVIEW_STATUS_WAIVED,
  type RepoId,
  type RepoRules,
  type ReviewFact,
  type ReviewRow,
  RULING_PARK,
  type Run,
  type RunLoop,
  readyMarkedText,
  reconcile,
  rerunFailedKey,
  reviewCarriedText,
  reviewDroppedText,
  reviewEventKey,
  reviewFailedText,
  reviewFor,
  reviewQueuedText,
  reviewRunStep,
  reviewStartedText,
  reviewStatusOf,
  reviewTokenBudgetOf,
  STDERR_TEXT_MAX,
  STUCK_PARK,
  SYNC_MAIN_GAP_MS,
  seatCallSign,
  seatDef,
  syncFailedText,
  syncMergedText,
  syncTooSoonText,
  TAKE_STALE_MS,
  type TicketView,
  ticketControllerCheck,
  UAT_PARK,
  UAT_USE_ROUTE,
  uatParkText,
  uatSendBackText,
  wakeFailedText,
  wokenEventText,
  writerSyncConflictText,
} from "@mc/core";
import { runAccountId } from "../account-bindings.ts";
import { activeAway } from "../away.ts";
import type { ChangeBus } from "../bus.ts";
import { type CcConfig, type CrewSeatConfig, flightPowersOf, seatUnavailable } from "../config.ts";
import { pausedSeat, reviewPausedMs } from "../crew-pause.ts";
import { mergeFloorApproval } from "../flight-approvals.ts";
import type { Move, MoveResult } from "../github-board.ts";
import {
  MACHINE_CAPACITY_DEFAULTS,
  machineCapacity,
  machineCapacitySince,
} from "../machine-capacity.ts";
import { issueOf } from "../mcp/tools.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { reworkDueBesides, wakeDueAsideRun } from "./aside.ts";
import { releaseDependents } from "./dependencies.ts";
import {
  CI_LOG_UNREADABLE,
  EMPTY_LOG,
  MERGE_CONFLICTING,
  MERGE_HEAD_MOVED,
  MERGE_WAITS_ON_MAIN,
  NO_FAILED_RUN,
  type Publisher,
  READY_UNDO_FAILED,
  UPDATE_UP_TO_DATE,
  type UpdateBranchResult,
} from "./publish.ts";
import { accountAtStop, isTransientStart, maxOpenRunsOf, seatMayTake } from "./queue.ts";
import { hardRulesBy, type RepoRulesError } from "./rules.ts";
import { overrunText, tickLogOf } from "./ticks.ts";

/** Why the PR step found no PR when the branch tip is not the pushed commit. */
export const TIP_MOVED = "the branch's tip is not the pushed commit, or could not be read";

/** What `ciExcerpt` says when it has no excerpt to give: not kept, but asked for again. */
const NOT_EXCERPTS = [NO_FAILED_RUN, CI_LOG_UNREADABLE, EMPTY_LOG];

/** An ended run's loop is still reconciled for this long after the end. */
export const ENDED_RECONCILE_MS = 7 * 24 * 60 * 60_000;
/** A pass that changed what the next one acts on runs again at once, up to this many times. */
const MAX_ROUNDS = 4;

export interface EngineDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor: Pick<
    Supervisor,
    | "on"
    | "send"
    | "resumeRun"
    | "resumeDeferredRuns"
    | "seat"
    | "seatFacts"
    | "endRunByEngine"
    | "startReview"
    | "busy"
    | "setAside"
    | "wakeRun"
  >;
  publisher: Publisher;
  /** `moveCard`, bound to the GitHub client, the store, the config and the poll. */
  board: { move: (m: Move) => Promise<MoveResult> };
  /** Reads a ticket (its body holds an optional `## Controller check`). */
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  /** Asks for a GitHub poll now (after a merge, so the boards show it before the next one). */
  pollGithub?: () => void;
  /** A repo's board rules (at the gate's main sha, or origin/HEAD); errors are notes in `status()`. */
  rules: (repoId: RepoId, mainSha?: string) => Promise<RepoRules | RepoRulesError>;
  /** Rebuilds the writer seats' queues from the board (each tick). */
  refillQueues: () => Promise<void>;
  /** Starts the seat's next queued ticket; it does nothing for a seat that may not take one. */
  takeNext: (seatId: string) => Promise<void>;
  /** false: crew is off, or this is a preview, or loop writes are disabled. */
  enabled: boolean;
  /** Whether this process may act on crew right now (it holds the crew lock); default true. */
  crewOn?: () => boolean;
  hubStartedAt: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Which check refused `onOperatorMessage`; `operatorRefusalText` says it in words. */
export type OperatorRefusal =
  | "engine-off"
  | "not-parked"
  | "pr-closed"
  | "held"
  | "wrong-action"
  | "not-permitted"
  | "head-moved"
  | "pr-not-open"
  | "second-review-done"
  | "no-second-reviewer"
  | "floor-enforced"
  | "before-lift"
  | "rework-undelivered"
  | "use-controller-check"
  | "use-merge-hold"
  | "use-uat"
  | "dollar-cap"
  | "engine-error";

export type MergeHoldBy = "CAPCOM" | "FLIGHT";
export type MergeHoldResult = { ok: true } | { ok: false; text: string };

export type OperatorResult = { lifted: true } | { lifted: false; reason: OperatorRefusal };

const OPERATOR_REFUSAL_TEXT: Record<OperatorRefusal, string> = {
  "engine-off": "the loop engine is off",
  "not-parked": "the run is not parked, or its park has ended",
  "pr-closed": "the PR is closed, so the park cannot be lifted",
  held: "the run is held: its seat is stopped or paused, the park is a budget park, a question is overdue, or its account is at its stop",
  "wrong-action": "this action cannot settle this kind of park",
  "not-permitted": "this action is not allowed for the caller",
  "head-moved": "the pushed head moved or is not the PR's head; refresh and check the head again",
  "pr-not-open": "the PR is not open",
  "second-review-done": "a second review was already requested on this head",
  "no-second-reviewer": "no reviewer on another account than the first review's is available",
  "floor-enforced":
    "a blocking review on floor-enforcing paths cannot be accepted past; only the controller can merge it",
  "before-lift": "the operator's message could not be stored",
  "rework-undelivered": "the rework request could not be delivered to the seat",
  "use-controller-check": CONTROLLER_CHECK_USE_ROUTE,
  "use-merge-hold": MERGE_HOLD_USE_ROUTE,
  "use-uat": UAT_USE_ROUTE,
  "dollar-cap":
    "the run reached its template's dollar cap, and its Claude process keeps the cap it started with; end the run and start the ticket again",
  "engine-error": "the engine hit an error; see the hub log",
};

export function operatorRefusalText(reason: OperatorRefusal): string {
  return OPERATOR_REFUSAL_TEXT[reason];
}

export interface Engine {
  /** Untakes stale queue rows, subscribes to the supervisor and reconciles every looped run. */
  start(): void;
  stop(): void;
  /** One minute's pass: every active looped run, the ended ones that are not settled, the sweep. */
  tick(): Promise<void>;
  reconcileRun(runId: string): Promise<void>;
  /** After a poll: every active looped run of the repo. */
  reconcileRepo(repoId: RepoId): Promise<void>;
  /**
   * The operator wrote to the run's seat: a parked run (unless ended or its PR was closed) resumes.
   * A message after review findings sends the author back to working; only an explicit `accept` waives them.
   * `opts.kinds` limits the park kinds that may be lifted, checked when the run's turn comes; FLIGHT
   * never lifts a budget park. Resolves `lifted: true` only when it un-parked the run; otherwise `reason` is the first check that refused.
   */
  onOperatorMessage(
    runId: string,
    by?: "CAPCOM" | "FLIGHT",
    opts?: {
      kinds?: readonly string[];
      action?: "lift" | "rereview" | "accept" | "rework" | "second_review";
      /** Stores operator work after lift guards pass but before the resumed run can wake. */
      beforeLift?: () => Promise<boolean>;
      /** A short FLIGHT fix list, appended after RETRO's findings for the author; for `second_review`, FLIGHT's reason. */
      note?: string;
    },
  ): Promise<OperatorResult>;
  /**
   * The operator's verdict on a run parked on its ticket's controller check. `pass` (only while the
   * PR head is still the parked head) lets the next pass merge; `fail` sends the note to the seat
   * as rework and ends the park.
   */
  controllerCheck(
    runId: string,
    verdict: "pass" | "fail",
    sha: string,
    note?: string,
  ): Promise<OperatorResult>;
  /**
   * The operator's verdict on a run parked for acceptance (UAT). `accept` (only while the PR head is
   * still the parked head) lets the next pass merge through the usual gates; `send_back` sends the
   * note to the seat as a new rework round and ends the park.
   */
  uat(
    runId: string,
    verdict: "accept" | "send_back",
    sha: string,
    note?: string,
  ): Promise<OperatorResult>;
  /**
   * Holds the run's merge: the engine does not merge it, even after a clean review and green CI,
   * until the hold is released; it parks as `merge-hold` when it would otherwise merge. The
   * controller (CAPCOM) may replace any hold; FLIGHT only sets one when none is held.
   */
  holdMerge(runId: string, by: MergeHoldBy, reason: string): Promise<MergeHoldResult>;
  /** Releases the hold. FLIGHT cannot release one the controller set; the controller can release any. */
  releaseMergeHold(runId: string, by: MergeHoldBy): Promise<MergeHoldResult>;
  /**
   * FLIGHT settles a run parked on a CI ruling. The first call has the hub re-run the failed jobs
   * on the ruled sha (once per sha); later
   * calls read the result: a pass accepts the ruling and the run goes to review, a fail sends the
   * author the failure.
   */
  clearFlight(runId: string, expectedSha?: string): Promise<boolean>;
  rerunCi(runId: string): Promise<{ ok: boolean; text: string }>;
  acceptRuling(runId: string): Promise<AcceptRulingResult>;
  /** Merges main into the run's branch now, with the engine's own merge (hub-made, never the seat's). */
  syncMain(runId: string): Promise<SyncMainResult>;
  /** Writer-requested local sync, capped per run; reports conflicts and dependency install refusals. */
  writerSyncMain(runId: string): Promise<{ text: string; isError?: boolean }>;
  /** The paths the run's worktree holds uncommitted; null when it has no worktree or it cannot be read. */
  uncommitted(runId: string): Promise<string[] | null>;
  status(): { on: boolean; note: string | null };
  /** How many CI excerpts are held for a busy seat (a test seam). */
  excerptsHeld(): number;
}

export type AcceptRulingResult =
  | { kind: "rerun"; sha: string }
  | { kind: "pending"; sha: string }
  | { kind: "accepted"; sha: string }
  | { kind: "refused"; sha: string }
  | { kind: "not"; text: string };

export type SyncMainResult =
  | { kind: "merged"; sha: string; mainSha: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "current"; mainSha: string }
  | { kind: "refused"; text: string };

/** onChain key for superviseReviews (never a run id). */
const REVIEWS_CHAIN = "\0reviews";

/**
 * The review seat for a seat's runs: the first review-loop seat (config order) of its crew session
 * that is not retiring; null when there is none (the operator reviews). With a `role` (the run's
 * profile names one), the first such seat of that role is preferred. With `avail`, the first of those
 * whose account is not at its stop and has no review starting or running is preferred. When every
 * available reviewer is busy, the first non-stopped seat keeps the queued review; when every account
 * is at its stop, the first stands, so its reviews wait rather than vanish. With `avail.avoid`, seats
 * in it are passed over while any other seat qualifies (a review that went over its token budget on a
 * seat is retried on another).
 */
export function reviewerOf(
  config: CcConfig,
  seatId: string,
  role?: string,
  avail?: {
    store: Store;
    now: number;
    avoid?: ReadonlySet<string>;
    /** Seats on this account are never chosen (a second review runs on another account). */
    exceptAccount?: string;
  },
): CrewSeatConfig | null {
  const session = (config.crew?.sessions ?? []).find((s) => s.seats.some((x) => x.id === seatId));
  // An unavailable reviewer is still required; its queued reviews wait for model discovery.
  const seats = (session?.seats ?? []).filter(
    (x) => !x.retiring && seatDef(x).loop === "review" && x.accountId !== avail?.exceptAccount,
  );
  const ofRole = seats.filter((x) => x.role === role);
  const pool = ofRole.length > 0 ? ofRole : seats;
  if (avail === undefined) return pool[0] ?? null;
  const notStopped = pool.filter(
    (x) => !accountAtStop(config, avail.store, x.accountId, avail.now),
  );
  const busy = new Set(
    avail.store.reviewsIn(["starting", "running"]).map((review) => review.seatId),
  );
  const others = notStopped.filter((x) => !avail.avoid?.has(x.id));
  const from = others.length > 0 ? others : notStopped;
  return from.find((x) => !busy.has(x.id)) ?? from[0] ?? pool[0] ?? null;
}

/** The seats whose review of the run's pushed sha, this epoch, failed on its token budget. */
function budgetFailedSeats(store: Store, run: Run): Set<string> {
  const sha = store.runPush(run.id)?.sha;
  const epoch = run.loop?.epoch;
  const seats = new Set<string>();
  if (sha === undefined || epoch === undefined) return seats;
  for (const r of store.reviewsOfRun(run.id)) {
    if (
      r.sha === sha &&
      r.epoch === epoch &&
      r.state === "failed" &&
      isReviewBudgetFailure(r.failure)
    )
      seats.add(r.seatId);
  }
  return seats;
}

/** The review seat's role the run's profile asks for, if it has a profile. */
const reviewRoleOf = (run: Run): string | undefined => run.profile?.profile.reviewer.role;

const reviewFact = (r: ReviewRow): ReviewFact => ({
  id: r.id,
  sha: r.sha,
  epoch: r.epoch,
  attempt: r.attempt,
  state: r.state,
  blocking: r.blocking,
  minor: r.minor,
  failure: r.failure,
});

const endReason = (run: Run): string => {
  switch (run.endedBy) {
    case "operator":
      return "stopped";
    case "engine":
      return "finished";
    case "exit":
      return run.status === "failed" ? "the process crashed" : "the process exited";
    default:
      return "ended";
  }
};

/** What a read failure of the ticket at merge starts with, in the run's last refusal. */
const TICKET_UNREADABLE = "ticket could not be read: ";

export function createEngine(deps: EngineDeps): Engine {
  const { config, store, bus, supervisor, publisher } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`engine: ${line}\n`));
  /** The run's review seat now: one whose account can start, else the first (see reviewerOf). */
  const reviewerFor = (run: Run): CrewSeatConfig | null => {
    // while FLIGHT's second review of the head is the one wanted, it runs on another account
    const sha = store.runPush(run.id)?.sha;
    const second = sha === undefined ? undefined : run.loop?.flightSecondReview?.[sha];
    return reviewerOf(config, run.agentId, reviewRoleOf(run), {
      store,
      now: now(),
      avoid: budgetFailedSeats(store, run),
      ...(second !== undefined && second.epoch === run.loop?.epoch
        ? { exceptAccount: second.firstAccountId }
        : {}),
    });
  };
  /** The input + output tokens a review run on this seat's account may use. */
  const reviewBudgetOf = (seatId: string): number => {
    const account = config.accounts.find((a) => a.id === seatConfig(seatId)?.accountId);
    return reviewTokenBudgetOf(account?.vendor ?? "claude", account?.reviewTokenBudget);
  };
  const chains = new Map<string, Promise<void>>();
  const ruleNotes = new Map<RepoId, string>();
  /** Whether each repo's rules set `hard_rules` at their last good read. */
  const hardRulesSet = new Map<RepoId, boolean>();
  /** Writer sync cap, per run; a restart clears it. */
  const lastSync = new Map<string, number>();
  /** When each run last had a transient refusal counted: one counts per tick, however often it is tried. */
  const lastTransient = new Map<string, number>();
  /** Transient refusals of each run's local branch delete, and when the last was counted (in memory: a restart tries afresh). */
  const localTries = new Map<string, { n: number; at: number }>();
  /** Consecutive failed reads of each run's ticket at merge (in memory: a restart tries afresh). */
  const ticketTries = new Map<string, { n: number; at: number; why: string }>();
  /** A CI failure's excerpt, kept until its line is claimed, so a busy seat costs one gh read. */
  const excerpts = new Map<string, string>();
  /** Transient refusals of each review's PR-body edit (in memory: a restart tries afresh). */
  const bodyTries = new Map<number, number>();
  /** The mc/review status last set for each run, as `<sha>:<state>:<description>` (in memory: a restart sets it once more). */
  const reviewStatuses = new Map<string, string>();
  /** The last failure logged for each run's review status, so a lasting failure is logged once. */
  const reviewStatusFailures = new Map<string, string>();
  /** Tick-local snapshots avoid repeated whole-table reads without leaking to external reconciles. */
  const tickCache = new AsyncLocalStorage<{
    prs: Map<RepoId, ReturnType<Store["pullRequests"]>>;
    notes: ReturnType<Store["notes"]>;
  }>();
  const prsFor = (repoId: RepoId): ReturnType<Store["pullRequests"]> => {
    const cache = tickCache.getStore();
    const cached = cache?.prs.get(repoId);
    if (cached !== undefined) return cached;
    const rows = store.pullRequests(repoId);
    cache?.prs.set(repoId, rows);
    return rows;
  };
  let started = false;
  let unsubscribe: (() => void) | null = null;

  const live = () => deps.enabled && started && (deps.crewOn?.() ?? true);

  const seatConfig = (seatId: string): CrewSeatConfig | undefined =>
    (config.crew?.sessions ?? []).flatMap((s) => s.seats).find((x) => x.id === seatId);

  /** Whether the seat is in the config: a seat removed from it leaves its runs alone. */
  const seatKnown = (seatId: string): boolean =>
    (config.crew?.sessions ?? []).some((s) => s.seats.some((x) => x.id === seatId));

  /** Runs `fn` after everything queued for the run; never rejects. */
  function onChain(runId: string, fn: () => Promise<void>): Promise<void> {
    const prev = chains.get(runId) ?? Promise.resolve();
    const p = prev.then(fn).catch((e: unknown) => {
      log(`${runId}: ${e instanceof Error ? e.message : String(e)}`);
    });
    chains.set(runId, p);
    void p.then(() => {
      if (chains.get(runId) === p) chains.delete(runId);
    });
    return p;
  }

  /** A missing CLI leaves the line unclaimed; the next pass sends it after the take-back. */
  async function send(runId: string, key: string, text: string) {
    const seatId = store.run(runId)?.agentId;
    if (seatId !== undefined && pausedSeat(store, seatId)) return "no-session" as const;
    const sent = await supervisor.send(runId, key, text);
    if (sent === "no-session") {
      const run = store.run(runId);
      const accountId = run === null ? undefined : seatConfig(run.agentId)?.accountId;
      if (
        run?.loop?.phase !== "parked" &&
        (accountId === undefined ||
          !accountAtStop(config, store, runAccountId(store, runId, accountId), now()))
      ) {
        await supervisor.resumeRun(runId);
      }
    }
    return sent;
  }

  /** Like `onChain`, resolving to what `fn` returned (`fallback` when it threw). */
  function onChainResult<T>(runId: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    let result = fallback;
    return onChain(runId, async () => {
      result = await fn();
    }).then(() => result);
  }

  /** The run's own worktree: the aside run's, or its seat's while the seat holds it. */
  function worktreeOf(run: Run, loop: RunLoop): string | null {
    const seatRow = supervisor.seat(run.agentId);
    return loop.aside?.worktree ?? (seatRow?.runId === run.id ? (seatRow.worktree ?? null) : null);
  }

  function flightHeld(run: Run): boolean {
    const seat = seatConfig(run.agentId);
    return (
      store.seatSession(run.agentId)?.state === "stopped" ||
      run.loop?.parked?.kind === "budget" ||
      store
        .openQuestions()
        .some(
          (q) =>
            q.runId === run.id && (q.passedAt !== null || now() - q.at >= FLIGHT_ANSWER_WAIT_MS),
        ) ||
      seat === undefined ||
      accountAtStop(config, store, runAccountId(store, run.id, seat.accountId), now())
    );
  }

  /** The same safety gate the planner uses before waking an otherwise idle seat. */
  function mayWakeSeat(run: Run): boolean {
    const loop = run.loop;
    const seat = seatConfig(run.agentId);
    if (
      loop === null ||
      loop === undefined ||
      loop.phase === "parked" ||
      !seatKnown(run.agentId) ||
      pausedSeat(store, run.agentId) ||
      flightHeld(run) ||
      seat === undefined ||
      accountAtStop(config, store, runAccountId(store, run.id, seat.accountId), now())
    )
      return false;
    const row = supervisor.seat(run.agentId);
    const facts = supervisor.seatFacts(run.agentId);
    return (
      row !== null &&
      row.runId === run.id &&
      row.state === "idle" &&
      facts?.inTurn !== true &&
      (facts?.rateLimitedUntil === null ||
        facts?.rateLimitedUntil === undefined ||
        facts.rateLimitedUntil <= now()) &&
      !supervisor.busy().some((b) => b.seatId === run.agentId)
    );
  }

  /** The run's PR: the stored number, else the PR on its branch opened since the run began. */
  function findPr(run: Run, loop: RunLoop): ReturnType<Store["pullRequests"]>[number] | null {
    const prs = prsFor(run.repoId);
    if (loop.prNumber !== null) return prs.find((p) => p.number === loop.prNumber) ?? null;
    if (run.branch === null) return null;
    return (
      prs
        .filter((p) => p.branch === run.branch && p.createdAt >= run.startedAt)
        .sort((a, b) => b.number - a.number)[0] ?? null
    );
  }

  /** Wake an idle seat exactly once for each hub record that arrived during its prior turn. */
  async function wakePendingWork(runId: string): Promise<void> {
    const run = store.run(runId);
    if (!run || run.endedAt !== null || !mayWakeSeat(run)) return;
    const row = supervisor.seat(run.agentId);
    if (!row) return;
    const woken = Object.keys(store.claimedKeys(run.id))
      .filter((key) => key.startsWith(`wake:${run.id}:`))
      .flatMap((key) => key.slice(`wake:${run.id}:`.length).split("|"));
    const claimed = store.claimedKeys(run.id);
    const epoch = run.loop?.epoch ?? 0;
    const work = pendingSeatWork({
      lastTurnStartedAt: row.lastTurnStartedAt ?? null,
      reviews: store.reviewsOfRun(run.id),
      events: store.loopEventsOfRun(run.id),
      messages: store
        .comms(row.lastTurnStartedAt ?? Number.MAX_SAFE_INTEGER, run.id)
        .filter((m) => m.to === run.agentId)
        .map((m) => ({ key: `${m.at}:${m.from}`, from: m.from, at: m.at })),
      woken,
      // the fix line carries the findings' text and wakes the seat itself, so a findings item
      // whose fix line is still unsent is left to it
    }).filter(
      (x) =>
        x.kind !== "findings" ||
        fixKey(run.id, epoch, Number(x.key.slice("review:".length))) in claimed,
    );
    if (work.length === 0) return;
    const key = `wake:${run.id}:${work.map((x) => x.key).join("|")}`;
    await send(
      run.id,
      key,
      pendingWakeText(work, run.ticket ?? "this run", config.operator.timezone),
    );
  }

  /** A green head without any evidence needs one prompt, then operator attention. */
  async function watchGreenEvidence(run: Run, notes = store.notes()): Promise<void> {
    const loop = run.loop;
    if (!loop || run.endedAt !== null) return;
    const prefix = `evidence-remind:${run.id}:`;
    const claimed = store.claimedKeys(run.id);
    const pr = findPr(run, loop);
    const head = pr?.headSha;
    const green = pr?.state === "open" && pr.ci === "passing" && !!head;
    const evidence = store.evidenceCount(run.id);
    const currentNote = head ? evidenceNoteKey(run.id, head) : null;
    for (const note of notes) {
      if (
        note.runId === run.id &&
        note.clearedAt === null &&
        note.key.startsWith(`evidence:${run.id}:`) &&
        (evidence > 0 || !green || note.key !== currentNote)
      ) {
        store.clearNote(note.key, now());
        bus.emit("attention");
      }
    }
    if (evidence > 0 || !pr || !head || !green) return;
    const remindKey = `${prefix}${head}`;
    const remindedAt = claimed[remindKey];
    if (remindedAt !== undefined) {
      if (now() - remindedAt < EVIDENCE_REMIND_MS) return;
      if (notes.some((n) => n.key === evidenceNoteKey(run.id, head))) return;
      store.raiseNote({
        key: evidenceNoteKey(run.id, head),
        kind: "flag",
        runId: run.id,
        seatId: run.agentId,
        repoId: run.repoId,
        text: `${run.ticket ?? "This run"}: CI is green on ${head.slice(0, 7)}, but ${seatCallSign(run.agentId)} has not reported evidence after a reminder.`,
        at: now(),
      });
      bus.emit("attention");
      return;
    }
    const passedAt = store
      .loopEventsOfRun(run.id)
      .filter((e) => e.text.startsWith(CI_PASSED_EVENT_PREFIX))
      .find((e) => {
        const sha = e.text.slice(CI_PASSED_EVENT_PREFIX.length).match(/^[0-9a-f]{7,}/i)?.[0];
        return sha !== undefined && head.startsWith(sha);
      })?.at;
    const greenKey = `evidence-green:${run.id}:${head}`;
    const since = passedAt ?? claimed[greenKey] ?? now();
    if (passedAt === undefined && claimed[greenKey] === undefined)
      store.claimLine(greenKey, {
        runId: run.id,
        seatId: run.agentId,
        origin: "engine",
        text: `CI green on ${head.slice(0, 7)}`,
        at: since,
      });
    if (now() - since < EVIDENCE_REMIND_MS) return;
    if (mayWakeSeat(run))
      await send(
        run.id,
        remindKey,
        `CI is green on ${head.slice(0, 7)}, but no evidence was reported for ${run.ticket ?? "this run"}. Please report evidence now.`,
      );
  }

  async function rulesFor(repoId: RepoId, mainSha?: string): Promise<RepoRules | null> {
    const r = await deps.rules(repoId, mainSha);
    if (r instanceof Error) {
      ruleNotes.set(repoId, r.message);
      hardRulesSet.delete(repoId);
      return null;
    }
    ruleNotes.delete(repoId);
    hardRulesSet.set(repoId, r.hardRulesSet);
    // kept for Needs you, which says who a hard-rule flag waits on without reading the rules
    const bySetting = hardRulesBySettingKey(repoId);
    if (store.getSetting(bySetting) !== hardRulesBy(r, flightPowersOf(config, repoId))) {
      store.setSetting(bySetting, hardRulesBy(r, flightPowersOf(config, repoId)));
      bus.emit("attention");
    }
    noteHardRules(repoId, r.hardRulesSet);
    return r;
  }

  /** The one note for a `merge` repo whose rules leave `hard_rules` unset; cleared once they set it. */
  function noteHardRules(repoId: RepoId, set: boolean): void {
    if (config.repos.find((r) => r.id === repoId)?.autonomy !== "merge") return;
    const key = hardRulesUnsetNoteKey(repoId);
    const cache = tickCache.getStore();
    const notes = cache?.notes ?? store.notes();
    const open = notes.some((n) => n.key === key);
    if (set && open) {
      store.clearNote(key, now());
      if (cache) cache.notes = cache.notes.filter((n) => n.key !== key);
      bus.emit("attention");
    } else if (!set && !open) {
      store.raiseNote({
        key,
        kind: "blocked",
        runId: null,
        seatId: null,
        repoId,
        text: hardRulesUnsetText(repoId),
        at: now(),
      });
      cache?.notes.push({
        key,
        kind: "blocked",
        runId: null,
        seatId: null,
        repoId,
        text: hardRulesUnsetText(repoId),
        at: now(),
        clearedAt: null,
        dismissedAt: null,
      });
      bus.emit("attention");
    }
  }

  function saveLoop(
    runId: string,
    loop: RunLoop,
    stored: RunLoop | null | undefined,
    at: number,
  ): void {
    if (JSON.stringify(loop) === JSON.stringify(stored)) return;
    store.setRunLoop(runId, loop, at);
    if (loop.phase === "done") bus.emit("attention");
    bus.emit("agents");
  }

  function snapshot(
    run: Run,
    loop: RunLoop,
    at: number,
    mergeAllowed: boolean,
  ): LoopSnapshot | null {
    const issue = issueOf(run);
    if (issue === null || run.ticket === null) return null;
    const ended = run.endedAt !== null;
    const row = supervisor.seat(run.agentId);
    const facts = supervisor.seatFacts(run.agentId);
    // a run that ended is not its seat's now: nothing may be written to the seat for it
    const current = !ended && row?.runId === run.id;
    const evidence = store.latestEvidence(run.id);
    const pr = findPr(run, loop);
    const repo = config.repos.find((r) => r.id === run.repoId);
    const verdict = ciVerdict(pr?.checks ?? [], repo?.requiredChecks ?? []);
    const item = store.board(run.repoId).find((b) => b.issueNumber === issue);
    const pushed = store.runPush(run.id);
    const turnEnded = row?.lastTurnEndedAt ?? null;
    const reviewer = reviewerFor(run);
    let review: LoopReviewFacts | null = null;
    if (reviewer !== null) {
      const rows = store.reviewsOfRun(run.id).map((row) => ({
        ...reviewFact(row),
        design: store.reviewChecks(row.id).find((check) => check.check === "design") ?? null,
      }));
      const cur = pushed
        ? reviewFor(
            rows,
            loop.epoch,
            pushed.sha,
            carriedFrom(loop.carry, loop.reviewWaivedSha, pushed.sha),
          )
        : null;
      review = {
        retro: seatCallSign(reviewer.id),
        rows,
        findings:
          cur !== null && cur.state === "reported" && cur.blocking > 0
            ? store
                .findingsOf(cur.id)
                .filter((f) => BLOCKING_SEVERITIES.includes(f.severity))
                .map((f) => ({
                  severity: f.severity,
                  file: f.file,
                  line: f.line,
                  summary: f.summary,
                  scenario: f.scenario,
                  fix: f.fix,
                }))
            : [],
      };
    }
    return {
      runId: run.id,
      runStartedAt: run.startedAt,
      loop,
      ticket: { ref: run.ticket, title: run.ticketTitle ?? item?.title ?? "", issue },
      now: at,
      tz: config.operator.timezone,
      hubStartedAt: deps.hubStartedAt,
      seat: {
        call: seatCallSign(run.agentId),
        // a run off its seat is on no seat: the row is another run's, and so is its rate limit
        state: loop.aside ? "stopped" : (row?.state ?? "stopped"),
        holdsRun: current,
        // With no CLI, plan between turns; only a due line asks the supervisor to resume.
        inTurn: !current || (facts?.inTurn ?? false),
        lastTurnEndedAt:
          current && turnEnded !== null && turnEnded >= run.startedAt ? turnEnded : null,
        resumedAt: current ? (facts?.resumedAt ?? null) : null,
        quietTurns: current ? (row?.quietTurns ?? 0) : 0,
        rateLimitedUntil: current ? (facts?.rateLimitedUntil ?? null) : null,
        openQuestion: store.openQuestions().some((q) => q.runId === run.id),
      },
      evidence:
        evidence === null
          ? null
          : {
              id: evidence.id,
              at: evidence.at,
              ruling: evidence.note.startsWith(EVIDENCE_RULING_PREFIX),
              note: evidence.note,
            },
      evidenceCount: store.evidenceCount(run.id),
      headCommit: store.newestRunCommit(run.id)?.sha ?? null,
      pushed,
      pr:
        pr === null
          ? null
          : {
              number: pr.number,
              state: pr.state,
              headSha: pr.headSha,
              ci: pr.ci,
              mergeable: pr.mergeable,
              polledAt: store.pullRequestReadAt(run.repoId, pr.number) ?? 0,
              isDraft: pr.isDraft,
              checks: {
                failing: verdict.failing,
                pending: verdict.pending,
                missing: verdict.missing,
              },
              reviewStatus:
                flightPowersOf(config, run.repoId) === "superuser" &&
                loop.reviewWaivedSha === pr.headSha &&
                reviewStatuses.get(run.id) !== `${pr.headSha}:success:${REVIEW_STATUS_WAIVED}`
                  ? "pending"
                  : checkState(pr.checks ?? [], REVIEW_STATUS_CONTEXT),
            },
      autoMerge:
        repo?.autonomy === "merge" && activeAway(store, at, config.operator.timezone) === null,
      hardRulesSet: mergeAllowed,
      flightPowers: flightPowersOf(config, run.repoId),
      flightHeld: flightHeld(run),
      floorApproved:
        pr !== null && mergeFloorApproval(store, pr.number, pr.headSha, at) !== undefined,
      card: item === undefined ? null : hudColumnOf(item),
      claimed: store.claimedKeys(run.id),
      openNotes: store.openNoteKeys(run.id),
      lastEngineLineAt: store.lastEngineLineAt(run.id),
      tokens: run.tokens === null ? 0 : run.tokens.input + run.tokens.output,
      budget: config.crew?.runTokenBudget ?? Number.MAX_SAFE_INTEGER,
      costUsd: run.costUsd,
      budgetUsd: run.vendor === "codex" ? null : (run.profile?.profile.budgetUsd ?? null),
      ended: ended ? { reason: endReason(run) } : null,
      review,
      asideOk: reviewer !== null,
      reworkDue: reworkDueBesides(store, run),
      ...(run.profile
        ? { limits: { tries: run.profile.profile.tries, rounds: run.profile.profile.rounds } }
        : {}),
    };
  }

  /** What a pass changed for the next one to act on at once. */
  interface Outcome {
    again: boolean;
    /** The pass parked the run: its remaining actions are for a run that is no longer going. */
    parked: boolean;
  }

  /**
   * What a merge of main into the run's branch (`r`, from `updateBranch`) changed, stored in `cur`
   * with its Activity rows: a merge moves the run to ci, a conflict back to the author.
   */
  function branchUpdated(
    run: Run,
    cur: RunLoop,
    mainSha: string,
    r: Extract<UpdateBranchResult, { ok: true; kind: "merged" | "conflict" }>,
    at: number,
  ): void {
    if (r.kind === "merged") {
      // as a report moves the run to ci: the new commit is pushed, then judged afresh
      cur.phase = "ci";
      cur.pushFor = r.sha;
      cur.pushStartedAt = at;
      // a chain of merges collapses to the sha that was reviewed
      cur.carry = r.prSame
        ? { from: cur.carry?.to === r.parent ? cur.carry.from : r.parent, to: r.sha }
        : null;
      if (r.prSame && cur.reviewWaivedSha === r.parent) cur.reviewWaivedSha = r.sha;
      store.setRunLoop(run.id, cur);
      store.addLoopEvent(`${run.id}:update:${r.sha}`, run.id, mergedMainText(mainSha), at);
      const from = carriedFrom(cur.carry, cur.reviewWaivedSha, r.sha);
      if (
        from !== null &&
        reviewFor(store.reviewsOfRun(run.id).map(reviewFact), cur.epoch, r.sha, from) !== null
      ) {
        store.addLoopEvent(`${run.id}:carry:${r.sha}`, run.id, reviewCarriedText(from, r.sha), at);
      }
    } else {
      cur.phase = "working";
      cur.mainMerge = { mainSha, files: r.files };
      store.setRunLoop(run.id, cur);
      store.addLoopEvent(
        `${run.id}:update-conflict:${mainSha}`,
        run.id,
        mainConflictText(mainSha, r.files.length),
        at,
      );
    }
  }

  async function safeAwayPr(run: Run, cur: RunLoop): Promise<string | null> {
    const away = activeAway(store, now(), config.operator.timezone);
    if (!away?.may.safePr || !away.may.pickUp || flightHeld(run)) return null;
    const rules = await rulesFor(run.repoId);
    const card = store.board(run.repoId).find((b) => b.issueNumber === issueOf(run));
    const type = card && rules ? awayTicketType(card, rules.templates) : null;
    const sha = store.runPush(run.id)?.sha;
    if (!rules?.hardRulesSet || type === null || !sha) return null;
    const diff = await publisher.awayDiff(run, sha);
    if (!diff || !awayDiffSafe(type, diff, rules, seatConfig(run.agentId)?.area ?? [])) return null;
    cur.awayBugDecision =
      type === "bug"
        ? {
            headSha: sha,
            about: awayBugDecisionAbout(run.ticket ?? "", diff.base, sha),
            testPaths: diff.changes
              .filter(
                (c) =>
                  c.status === AWAY_STATUS_ADDED &&
                  AWAY_TEST_PATH.test(c.path) &&
                  !AWAY_DOC_PATH.test(c.path) &&
                  !AWAY_FIXTURE_DIR.test(c.path),
              )
              .map((c) => c.path),
          }
        : null;
    if (type === "bug" && cur.awayBugDecision?.testPaths.length === 0) return null;
    if (
      type === "bug" &&
      !store
        .flightDecisions(run.startedAt, -1)
        .some(
          (d) =>
            d.kind === "note" &&
            d.about === awayBugDecisionAbout(run.ticket ?? "", diff.base, sha) &&
            d.decision === AWAY_BUG_VERIFIED &&
            (cur.awayBugDecision?.testPaths ?? []).some((path) => d.basis.includes(path)),
        )
    )
      return null;
    cur.awayBugDecision = null;
    const current = store.run(run.id);
    if (!current || flightHeld(current) || store.runPush(run.id)?.sha !== sha) return null;
    const snap = snapshot(current, cur, now(), rules.hardRulesSet);
    const latestAway = activeAway(store, now(), config.operator.timezone);
    if (!snap || !latestAway?.may.safePr || !latestAway.may.pickUp) return null;
    // No waiver or Minor findings qualify as a clean RETRO review while away.
    const review = reviewFor(snap.review?.rows ?? [], cur.epoch, sha, null);
    return review?.state === "reported" &&
      review.blocking === 0 &&
      review.minor === 0 &&
      cur.reviewWaivedSha !== sha &&
      gateView({ ...snap, autoMerge: true }, cur).passes
      ? sha
      : null;
  }

  /** The actions only a `merge` workspace takes, whatever the loop planned. */
  const MERGE_STEP_KINDS: ReadonlySet<string> = new Set([
    "mark-ready",
    "merge",
    "close-issue",
    "file-minor-issue",
    "delete-remote-branch",
    "delete-local-branch",
    "update-branch",
  ]);

  /** RETRO's latest reported findings as the author's fix list, else FLIGHT's own request. */
  function reworkFindings(runId: string, reason: string): string {
    const review = store
      .reviewsOfRun(runId)
      .filter((r) => r.state === "reported")
      .at(-1);
    const findings = review
      ? store.findingsOf(review.id).filter((f) => BLOCKING_SEVERITIES.includes(f.severity))
      : [];
    return review && findings.length > 0
      ? fixText({ retro: seatCallSign(review.seatId), sha: review.sha, findings })
      : `FLIGHT requests rework: ${reason}`;
  }

  /**
   * Whether the run's ticket holds this merge for the controller: null merges; otherwise `park` is
   * the reason to park with, or undefined when the ticket could not be read yet (tried next pass).
   * Fails closed: a ticket that is missing or unreadable parks after REFUSAL_TRIES, so the
   * operator can pass it. Once a run's ticket has listed a check, a pass is needed whatever it says later.
   */
  async function controllerCheckHold(
    run: Run,
    cur: RunLoop,
    sha: string,
  ): Promise<{ park?: string } | null> {
    const repo = config.repos.find((r) => r.id === run.repoId);
    const issue = issueOf(run);
    if (repo === undefined || issue === null) return null;
    if (cur.controllerCheck?.sha === sha && cur.controllerCheck.pass) return null;
    let ticket: TicketView | null = null;
    let why = "";
    try {
      ticket = await deps.fetchTicket(repo, issue);
      if (ticket === null) why = "the ticket was not found";
    } catch (e) {
      why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    if (ticket === null) {
      const at = now();
      const tries = ticketTries.get(run.id) ?? { n: 0, at: 0, why };
      // one counted per tick, as for a refused merge step
      if (tries.n === 0 || at - tries.at >= ENGINE_TICK_MS / 2) {
        tries.n += 1;
        tries.at = at;
        log(`${run.id}: could not read the ticket for its controller check: ${why}`);
      }
      tries.why = why;
      ticketTries.set(run.id, tries);
      cur.lastRefusal = `${TICKET_UNREADABLE}${why}`;
      if (tries.n < REFUSAL_TRIES) return {};
      ticketTries.delete(run.id);
      return { park: controllerCheckUnreadableText(sha, why) };
    }
    const failed = ticketTries.get(run.id);
    if (failed !== undefined) {
      ticketTries.delete(run.id);
    }
    if (cur.lastRefusal?.startsWith(TICKET_UNREADABLE)) cur.lastRefusal = null;
    const check = ticketControllerCheck(ticket);
    if (check !== null) cur.controllerCheckRequired = true;
    if (check === null && cur.controllerCheckRequired !== true) return null;
    return { park: controllerCheckParkText(sha, check ?? "") };
  }

  /**
   * Why the repo's `uat` rule makes this merge wait for the operator's acceptance: null merges.
   * A ticket label or a touched path matches; a diff that cannot be read counts as a match, so the
   * operator decides. Once the operator accepted this head it waits no more.
   */
  async function uatHold(run: Run, cur: RunLoop, sha: string): Promise<string | null> {
    if (cur.uat?.sha === sha && cur.uat.accepted) return null;
    const rules = await rulesFor(run.repoId);
    const { labels, paths } = rules?.uat ?? { labels: [], paths: [] };
    if (labels.length === 0 && paths.length === 0) return null;
    const issue = issueOf(run);
    const card = store.board(run.repoId).find((b) => b.issueNumber === issue);
    // without the ticket's labels the rule cannot be judged: the operator decides
    if (labels.length > 0 && card === undefined) return "its ticket's labels could not be read";
    const wanted = new Set(labels.map((l) => l.toLowerCase()));
    const label = card?.labels.find((l) => wanted.has(l.toLowerCase()));
    if (label !== undefined) return `ticket label ${label}`;
    if (paths.length === 0) return null;
    try {
      const touched = await publisher.hardRuleTouches(run, sha, paths);
      return touched.length === 0 ? null : `it changes ${touched[0]}`;
    } catch (e) {
      log(`${run.id}: could not read the diff for its uat rule: ${(e as Error).message}`);
      return "its diff could not be read";
    }
  }

  /**
   * The operator's note to the author of a run that was sent back (a failed controller check, a
   * send back at UAT). A run off its seat gets it through Comms and a pending line, and the engine
   * wakes it; otherwise it goes straight to the seat. False when it could not be delivered.
   */
  async function sendBack(
    run: Run,
    loop: RunLoop,
    next: RunLoop,
    text: string,
    key: string,
    mirror: string,
  ): Promise<boolean> {
    const row = {
      at: now(),
      from: COMMS_CAPCOM,
      to: run.agentId,
      ticket: run.ticket ?? null,
      ref: run.ticket ?? null,
      targetRunId: run.id,
      text: commsMirror(text, mirror),
    };
    if (loop.aside) {
      // off its seat (the seat may hold another run now): the note waits in Comms for the
      // run, and the engine wakes it, in working, once its seat is free
      const stored = store.addComms(row);
      if (stored === null) return false;
      // the pending line below carries the note to the seat: the inbox must not repeat it
      store.markCommsInboxRead(run.agentId, [stored.id]);
      next.pendingLine = { key, text };
      next.aside = { ...loop.aside, wake: true };
      return true;
    }
    const sent = await supervisor.send(run.id, key, text);
    // a paused seat reads it when it resumes: the verdict is recorded all the same
    if (sent !== "sent" && sent !== "dup" && !pausedSeat(store, run.agentId)) return false;
    const stored = store.addComms(row);
    // delivered by the line above: not again from the inbox
    if (stored !== null && (sent === "sent" || sent === "dup"))
      store.markCommsInboxRead(run.agentId, [stored.id]);
    return true;
  }

  async function act(
    a: LoopAction,
    run: Run,
    cur: RunLoop,
    planned: { phase: string; epoch: number },
    out: Outcome,
  ): Promise<void> {
    const at = now();
    const issue = issueOf(run) ?? 0;
    const repo = config.repos.find((r) => r.id === run.repoId);
    /**
     * A refused push or PR: a transient one is counted, any other parks the run. A refused merge
     * step (`step`) parks it as `merge-step`; housekeeping gets ten transient tries.
     */
    const refused = (
      r: { text: string; transient: boolean },
      step?: keyof typeof MERGE_STEP_WORDS,
    ): void => {
      if (r.transient) {
        // one counted per tick: a short outage must not use up the tries on its own
        const last = lastTransient.get(run.id);
        // (half a tick: ticks drift, and one arriving just short of the minute is the next one)
        if (last === undefined || at - last >= ENGINE_TICK_MS / 2) {
          cur.transient += 1;
          lastTransient.set(run.id, at);
        }
        cur.lastRefusal = r.text;
        const limit = cur.merging?.done.includes("merge") ? 10 : REFUSAL_TRIES;
        if (step === undefined || cur.transient < limit) {
          if (step === undefined && cur.transient >= REFUSAL_TRIES) out.again = true;
          // a merge step that did not go through stops the pass: the later steps wait for it
          if (step !== undefined) out.parked = true;
          return;
        }
      }
      const reason =
        step === undefined ? r.text : mergeStepFailedText(MERGE_STEP_WORDS[step], r.text);
      out.parked = true;
      cur.phase = "parked";
      cur.parked = { kind: step === undefined ? "refused" : "merge-step", reason, ended: false };
      store.addLoopEvent(
        `${run.id}:${cur.epoch}:parked:${cur.reportedEvidenceId}`,
        run.id,
        parkedEventText(reason),
        at,
      );
      out.again = true;
    };
    /** A line sent to the run's seat, recorded as a hand-off to it about the run's ticket. */
    const handOff = (from: string, text: string): void => {
      store.addComms({ at, from, to: run.agentId, ticket: run.ticket ?? null, text });
      bus.emit("agents");
    };
    /** The run as the merge steps see it: its stored row, with the loop this pass is writing. */
    const live = (): Run => ({ ...run, loop: cur });
    /** A merge step that went through: kept in the loop, with its Activity row. */
    const stepDone = (step: MergeStep, sha: string, text: string): void => {
      const same = cur.merging?.sha === sha;
      const done = same ? (cur.merging?.done ?? []) : [];
      cur.merging = { sha, done: done.includes(step) ? done : [...done, step] };
      cur.transient = 0;
      cur.lastRefusal = null;
      lastTransient.delete(run.id);
      store.addLoopEvent(`${run.id}:merge:${step}`, run.id, text, at);
    };
    const mergedSha = (): string =>
      cur.merging?.sha ?? findPr(run, cur)?.headSha ?? store.runPush(run.id)?.sha ?? "";
    const away = activeAway(store, now(), config.operator.timezone);
    if (away && a.kind === "merge") return;
    if (away && a.kind === "move-card" && !away.may.status) return;
    const checkedSha = away && a.kind === "mark-ready" ? await safeAwayPr(live(), cur) : null;
    if (away && a.kind === "mark-ready" && checkedSha === null) return;
    if (MERGE_STEP_KINDS.has(a.kind) && repo?.autonomy !== "merge") return;
    if (
      !away &&
      (a.kind === "merge" || a.kind === "mark-ready") &&
      flightPowersOf(config, run.repoId) === "superuser"
    ) {
      const current = store.run(run.id);
      if (current === null || flightHeld(current)) return;
      const snap = snapshot(current, cur, now(), hardRulesSet.get(run.repoId) === true);
      if (snap === null || !gateView(snap, cur).passes) return;
    }
    switch (a.kind) {
      case "push": {
        const r = await publisher.push(run);
        if (!r.ok && r.text.startsWith(MC_PUSH_CHECKS)) {
          // the seat has checks to run, not the operator a problem: tell the seat, once per head
          // and listing, and stay in this phase (the push is tried again when the seat has run them)
          const text = r.text;
          const sent = await send(run.id, `checks:${run.id}:${text}`, text);
          // a park for no progress then explains itself
          cur.lastRefusal = text;
          if (sent === "sent") {
            handOff(
              COMMS_MC,
              commsMirror(text, "Push checks failed; the full command list was sent to the seat."),
            );
            // running checks makes no commit, so the push clock starts over: a full window from the message
            cur.pushStartedAt = at;
          }
          return;
        }
        if (!r.ok) return refused(r);
        cur.transient = 0;
        lastTransient.delete(run.id);
        const sha = store.runPush(run.id)?.sha;
        if (sha !== undefined) {
          store.addLoopEvent(`${run.id}:pushed:${sha}`, run.id, `pushed ${sha.slice(0, 7)}`, at);
        }
        out.again = true;
        return;
      }
      case "open-pr": {
        const ticket = {
          issue,
          title:
            run.ticketTitle ??
            store.board(run.repoId).find((b) => b.issueNumber === issue)?.title ??
            "",
        };
        const r = await publisher.openPr(run, ticket, store.latestEvidence(run.id)?.note ?? "");
        if (!r.ok) return refused(r);
        cur.transient = 0;
        cur.lastRefusal = null;
        if (r.prNumber === null) {
          // no PR yet (the branch moved past the push, or the number was not read): look again
          if (r.tipMoved) {
            // kept for the park text, should this go on past the push's ten minutes
            cur.lastRefusal = TIP_MOVED;
          }
          out.again = true;
          return;
        }
        cur.prNumber = r.prNumber;
        store.addLoopEvent(`${run.id}:pr:${r.prNumber}`, run.id, `PR #${r.prNumber} opened`, at);
        return;
      }
      case "send": {
        const sent = await send(run.id, a.key, a.text);
        if (sent === "sent" && a.key.startsWith("fix:")) {
          const id = Number(a.key.slice(a.key.lastIndexOf(":") + 1));
          const review = store.review(id);
          if (review !== null) {
            store.addLoopEvent(
              reviewEventKey(run.id, id, "fix"),
              run.id,
              fixSentText(review.blocking, seatCallSign(run.agentId)),
              at,
            );
            handOff(
              review.seatId,
              fixCommsText({
                retro: seatCallSign(review.seatId),
                sha: review.sha,
                findings: store.findingsOf(review.id),
              }),
            );
          }
        }
        if (sent === "sent" && a.key.startsWith("conflict:"))
          handOff(COMMS_MC, commsMirror(a.text, conflictCommsText(cur.mainMerge?.files ?? [])));
        return;
      }
      case "ci-excerpt": {
        const held = excerpts.get(a.key);
        const excerpt = held ?? (await publisher.ciExcerpt(repo?.github ?? "", a.sha));
        // only a real excerpt is kept: a failed read or an empty answer is asked for again
        if (!NOT_EXCERPTS.includes(excerpt)) excerpts.set(a.key, excerpt);
        const head = a.again === true ? CI_RERUN_FAILED_TEXT : CI_FAILED_TEXT;
        const intro = fillLoopText(head, { sha7: a.sha.slice(0, 7) });
        const shortened = "\n[CI output shortened; inspect the CI log.]";
        const room = COMMS_MESSAGE_MAX - Array.from(intro + shortened).length;
        const text =
          Array.from(intro + excerpt).length <= COMMS_MESSAGE_MAX
            ? intro + excerpt
            : `${intro}${Array.from(excerpt).slice(0, Math.max(0, room)).join("")}${shortened}`;
        const sent = await send(run.id, a.key, text);
        if (sent === "sent") handOff(COMMS_MC, text);
        if (sent === "sent" || sent === "dup") {
          cur.relayedSha = a.sha;
          excerpts.delete(a.key);
        }
        return;
      }
      case "rerun-ci": {
        // once per sha: the loop marked it before this ran, so a refusal is not tried again
        const runs = await publisher.rerunFailed(repo?.github ?? "", a.sha);
        // jobs still going: no re-run spent, no event; the next failing poll asks again
        if (runs === "running") {
          if (cur.rerun?.sha === a.sha) cur.rerun = null;
          return;
        }
        // stamped once gh has answered: a poll taken during the call still shows the old failure
        if (cur.rerun?.sha === a.sha) {
          cur.rerun.runs = runs ?? [];
          cur.rerun.at = now();
        }
        store.addLoopEvent(
          `${run.id}:rerun:${a.sha}`,
          run.id,
          runs === null || runs.length === 0
            ? `${CI_FAILED_EVENT_PREFIX}${a.sha.slice(0, 7)}; no run could be re-run`
            : `${CI_FAILED_EVENT_PREFIX}${a.sha.slice(0, 7)}; re-ran ${runs.map((r) => r.name).join(", ")}`,
          at,
        );
        return;
      }
      case "move-card": {
        await deps.board.move({ runId: run.id, repoId: run.repoId, issue, column: a.column });
        // moved or failed (a failure is its Activity row): not tried again until the phase changes
        cur.cardFor = cardMark(planned.phase, planned.epoch);
        return;
      }
      case "note":
        store.raiseNote({
          key: a.key,
          kind: a.noteKind,
          runId: run.id,
          seatId: run.agentId,
          repoId: run.repoId,
          text: a.text,
          at,
        });
        bus.emit("attention");
        return;
      case "clear-note":
        // Collection failures wait for explicit resolution, including after loop reconciliation.
        if (a.key === `${run.id}:file-minor`) return;
        store.clearNote(a.key, at);
        bus.emit("attention");
        return;
      case "end-run":
        await supervisor.endRunByEngine(run.id);
        return;
      case "take-next": {
        // not while the seat holds another run (a merged PR found after the run was stopped)
        const holds = supervisor.seat(run.agentId)?.runId ?? null;
        if (!pausedSeat(store, run.agentId) && (holds === null || holds === run.id))
          await deps.takeNext(run.agentId);
        return;
      }
      case "event":
        store.addLoopEvent(
          `${run.id}:${cur.epoch}:${cur.reportedEvidenceId}:${a.text}`,
          run.id,
          a.text,
          at,
        );
        return;
      case "request-review": {
        const reviewer = reviewerFor(run);
        if (reviewer === null) return;
        if (cur.prNumber === null) {
          log(`${run.id}: no PR number to review`);
          return;
        }
        const round =
          1 +
          store
            .reviewsOfRun(run.id)
            .filter((r) => r.epoch === cur.epoch && r.state === "reported" && r.blocking > 0)
            .length;
        const id = store.requestReview({
          authorRunId: run.id,
          repoId: run.repoId,
          seatId: reviewer.id,
          prNumber: cur.prNumber,
          sha: a.sha,
          epoch: cur.epoch,
          attempt: a.attempt,
          round,
          at,
        });
        if (id !== null) {
          store.addLoopEvent(
            reviewEventKey(run.id, id, "queued"),
            run.id,
            reviewQueuedText(a.sha, seatCallSign(reviewer.id)),
            at,
          );
        }
        await kickReviews();
        return;
      }
      case "supersede-review": {
        const row = store.review(a.reviewId);
        if (row === null) return;
        dropReview(row);
        await endReviewRun(row, "superseded");
        await kickReviews();
        return;
      }
      case "set-aside": {
        const worktree = supervisor.seat(run.agentId)?.worktree ?? null;
        if (worktree === null) return;
        // stored before the call: a restart in between finds the run on its seat, which clears it
        // (a run set aside mid-build is due back as soon as the rework is out of the way)
        cur.aside = { worktree, wake: cur.phase === "working" };
        store.setRunLoop(run.id, cur);
        const r = await supervisor.setAside(run.id);
        if (r === null) {
          cur.aside = null;
          return;
        }
        const sha = store.runPush(run.id)?.sha ?? "";
        const call = seatCallSign(run.agentId);
        store.addLoopEvent(
          `${run.id}:${cur.epoch}:aside:${sha}`,
          run.id,
          cur.phase === "working"
            ? asideForReworkEventText(call)
            : cur.phase === "ci"
              ? asideInCiEventText(call)
              : asideEventText(call),
          at,
        );
        kickAside(run.agentId, run.id);
        // the freed seat takes its next ticket now, unless rework is due back on it first
        if (!pausedSeat(store, run.agentId) && wakeDueAsideRun(store, run.agentId) === undefined) {
          deps.takeNext(run.agentId).catch((e: unknown) => {
            log(
              `${run.agentId}: take after set-aside failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        }
        return;
      }
      case "wake": {
        if (pausedSeat(store, run.agentId)) return;
        const accountId = seatConfig(run.agentId)?.accountId;
        if (
          accountId !== undefined &&
          accountAtStop(config, store, runAccountId(store, run.id, accountId), at)
        )
          return;
        const oldest = wakeDueAsideRun(store, run.agentId);
        if (oldest !== undefined && oldest.id !== run.id) return;
        try {
          await supervisor.wakeRun(run.id);
        } catch (e) {
          // the seat is busy or the hub is stopping: the next pass tries again; the run holding the
          // seat is looked at now, to give way to this rework if its turn has ended
          if (isTransientStart(e)) {
            const holder = supervisor.seat(run.agentId)?.runId ?? null;
            if (
              holder !== null &&
              holder !== run.id &&
              store.run(holder)?.loop?.phase === "working"
            )
              void reconcileRun(holder);
            return;
          }
          const message = e instanceof Error ? e.message : String(e);
          // (the supervisor ended the run: the next pass parks it ended)
          store.addLoopEvent(
            `${run.id}:wake-failed:${at}`,
            run.id,
            wakeFailedText(Array.from(message).slice(0, STDERR_TEXT_MAX).join("")),
            at,
          );
          out.again = true;
          return;
        }
        cur.aside = null;
        store.addLoopEvent(
          `${run.id}:woken:${at}`,
          run.id,
          wokenEventText(seatCallSign(run.agentId)),
          at,
        );
        // the fix line goes now
        out.again = true;
        return;
      }
      case "update-branch": {
        const worktree = worktreeOf(run, cur);
        if (worktree === null) return;
        const r = await publisher.updateBranch(live(), a.mainSha, worktree);
        if (!r.ok) return refused(r);
        if (r.kind === "wait") return;
        cur.transient = 0;
        cur.lastRefusal = null;
        lastTransient.delete(run.id);
        out.again = true;
        branchUpdated(run, cur, a.mainSha, r, at);
        return;
      }
      case "mark-ready": {
        const sha = checkedSha ?? store.runPush(run.id)?.sha;
        if (sha === undefined) return;
        const r = await publisher.markReady(live(), away ? sha : undefined);
        if (!r.ok && away && r.text === READY_UNDO_FAILED) {
          cur.merging = { sha, done: ["ready"] };
          cur.lastRefusal = READY_UNDO_FAILED;
          deps.pollGithub?.();
          return;
        }
        if (!r.ok && away && r.text === MERGE_HEAD_MOVED) {
          deps.pollGithub?.();
          return;
        }
        if (!r.ok) return refused(r, "ready");
        stepDone("ready", sha, readyMarkedText(cur.prNumber));
        return;
      }
      case "merge": {
        // a hold from FLIGHT or the controller keeps the merge until it is released
        if (cur.mergeHold) {
          const hold = cur.mergeHold;
          const reason = mergeHoldParkText(hold.by, hold.reason);
          out.parked = true;
          cur.mergeHold = { ...hold, from: cur.phase === "parked" ? hold.from : cur.phase };
          cur.phase = "parked";
          cur.parked = { kind: MERGE_HOLD_PARK, reason, ended: false };
          store.addLoopEvent(
            `${run.id}:${cur.epoch}:parked:merge-hold:${hold.at}`,
            run.id,
            parkedEventText(reason),
            at,
          );
          out.again = true;
          return;
        }
        // a ticket's `## Controller check` holds the merge until the operator's pass on this head
        const check = await controllerCheckHold(run, cur, a.sha);
        if (check !== null) {
          out.parked = true;
          if (check.park === undefined) return;
          cur.controllerCheck = { sha: a.sha, from: cur.phase, pass: false };
          cur.phase = "parked";
          cur.parked = { kind: CONTROLLER_CHECK_PARK, reason: check.park, ended: false };
          store.addLoopEvent(
            `${run.id}:${cur.epoch}:parked:controller-check:${a.sha}`,
            run.id,
            parkedEventText(check.park),
            at,
          );
          out.again = true;
          return;
        }
        // the repo's `uat` rule holds the merge until the operator accepts this head
        const uatWhy = await uatHold(run, cur, a.sha);
        if (uatWhy !== null) {
          const reason = uatParkText(a.sha, uatWhy);
          out.parked = true;
          cur.uat = { sha: a.sha, from: cur.phase, accepted: false };
          cur.phase = "parked";
          cur.parked = { kind: UAT_PARK, reason, ended: false };
          store.addLoopEvent(
            `${run.id}:${cur.epoch}:parked:uat:${a.sha}`,
            run.id,
            parkedEventText(reason),
            at,
          );
          out.again = true;
          return;
        }
        const r = await publisher.merge(live(), a.sha);
        if (!r.ok && r.text === AWAY_WRITES_REFUSED) return;
        if (!r.ok && r.text === MERGE_HEAD_MOVED) {
          // the PR moved on since the gate: its facts are for a head that is gone, and the new
          // head goes through CI and review again; nothing is refused
          cur.gate = null;
          cur.touches = null;
          out.parked = true;
          deps.pollGithub?.();
          return;
        }
        if (!r.ok) {
          // main may have moved: the gate's facts are read afresh
          cur.gate = null;
          if (r.text === MERGE_CONFLICTING) {
            // Stop this pass and refresh GitHub so the conflict routes to update-branch. Any other
            // refusal (a branch policy, a required review) is counted and parks as before.
            store.addLoopEvent(
              `${run.id}:merge-conflict:${a.sha}`,
              run.id,
              MERGE_WAITS_ON_MAIN,
              at,
            );
            out.parked = true;
            deps.pollGithub?.();
            return;
          }
          return refused(r, "merge");
        }
        stepDone("merge", a.sha, mergedText(cur.prNumber));
        deps.pollGithub?.();
        out.again = true;
        return;
      }
      case "file-minor-issue": {
        const pr = cur.prNumber;
        let failure: string | null = null;
        try {
          const rules = await rulesFor(run.repoId);
          const r = await publisher.fileMinorFindings(live(), pr ?? 0, rules?.techDebtIssue);
          if (r.issueNumber !== undefined) cur.minorIssueNumber = r.issueNumber;
          if (!r.ok) failure = r.text;
          else if (r.issueNumber !== undefined) {
            const moved = await deps.board.move({
              runId: run.id,
              repoId: run.repoId,
              issue: r.issueNumber,
              column: "Backlog",
            });
            if (!moved.ok) failure = moved.reason;
          }
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        }
        if (failure !== null) {
          store.raiseNote({
            key: `${run.id}:file-minor`,
            kind: "flag",
            runId: run.id,
            seatId: run.agentId,
            repoId: run.repoId,
            text: minorIssueFailedText(pr ?? 0, failure),
            at,
          });
          bus.emit("attention");
        }
        stepDone(
          "file-minor",
          mergedSha(),
          failure === null
            ? "minor findings checked for Backlog"
            : minorIssueFailedText(pr ?? 0, failure),
        );
        return;
      }
      case "close-issue": {
        const r = await publisher.closeIssue(live());
        if (!r.ok) return refused(r, "close");
        stepDone("close", mergedSha(), closedIssueText(issue));
        return;
      }
      case "delete-remote-branch": {
        const r = await publisher.deleteRemoteBranch(live(), a.sha);
        if (!r.ok) return refused(r, "delete-remote");
        stepDone("delete-remote", a.sha, deletedRemoteText(run.branch ?? ""));
        return;
      }
      case "delete-local-branch": {
        // the branch goes once the run has ended; until then the step is not done
        if (store.run(run.id)?.endedAt === null) return;
        const branch = run.branch ?? "";
        const r = await publisher.deleteLocalBranch(live());
        if (r.ok) {
          localTries.delete(run.id);
          stepDone("delete-local", mergedSha(), deletedLocalText(branch));
          return;
        }
        if (r.transient) {
          // one counted per tick, as for a refused merge step; the step is tried again next tick
          const prev = localTries.get(run.id);
          const n = prev === undefined ? 1 : prev.n + (at - prev.at >= ENGINE_TICK_MS / 2 ? 1 : 0);
          localTries.set(run.id, { n, at: prev !== undefined && n === prev.n ? prev.at : at });
          if (n < REFUSAL_TRIES) return;
        }
        localTries.delete(run.id);
        // the run is over and merged: this is housekeeping, left to the operator
        stepDone("delete-local", mergedSha(), localNotDeletedText(branch, r.text));
        store.raiseNote({
          key: cleanupBranchNoteKey(run.id),
          kind: "blocked",
          runId: run.id,
          seatId: run.agentId,
          repoId: run.repoId,
          text: `${seatCallSign(run.agentId)}'s local branch ${branch} for run #${run.seq} could not be deleted (${r.text}); delete it by hand.`,
          at,
        });
        bus.emit("attention");
        return;
      }
      case "pr-body": {
        const row = store.review(a.reviewId);
        const reviewer = reviewerFor(run);
        if (row === null || reviewer === null) return;
        const r = await publisher.postMinorFindings(run, {
          id: row.id,
          sha: row.sha,
          retro: seatCallSign(reviewer.id),
        });
        const event = (text: string): void => {
          store.addLoopEvent(reviewEventKey(run.id, row.id, "pr-body"), run.id, text, at);
        };
        if (r.ok) {
          bodyTries.delete(row.id);
          cur.prBody = { reviewId: row.id, minor: row.minor };
          event(row.minor > 0 ? MINOR_POSTED : MINOR_CLEARED);
          return;
        }
        const tries = (bodyTries.get(row.id) ?? 0) + 1;
        if (!r.transient || tries >= REFUSAL_TRIES) {
          bodyTries.delete(row.id);
          // what the body really holds
          cur.prBody = { reviewId: row.id, minor: cur.prBody?.minor ?? 0 };
          event(minorNotPostedText(r.text));
        } else {
          bodyTries.set(row.id, tries);
        }
        return;
      }
    }
  }

  /** Keeps the mc/review commit status on the run's pushed sha in step with its review; never throws. */
  async function syncReviewStatus(runId: string): Promise<void> {
    await setReviewStatus(runId);
    // a run that has ended is done with its status: nothing of it is kept
    if (store.run(runId)?.endedAt != null) {
      reviewStatuses.delete(runId);
      reviewStatusFailures.delete(runId);
    }
  }

  /**
   * Logs a status failure unless it is the one logged last for the run: it is tried again every pass.
   * Compared on its first line, so a failure whose detail varies per call (a request id) logs once.
   */
  function noteStatusFailure(runId: string, text: string): void {
    const head = text.split("\n", 1)[0] ?? text;
    if (reviewStatusFailures.get(runId) === head) return;
    reviewStatusFailures.set(runId, head);
    log(`${runId}: review status not set: ${text}`);
  }

  async function setReviewStatus(runId: string): Promise<void> {
    const run = store.run(runId);
    const loop = run?.loop;
    if (run === null || loop === undefined || loop === null) return;
    // an ended run's status is final: no more writes for it (its ended passes would repeat one)
    if (run.endedAt != null) return;
    if (reviewerFor(run) === null) return;
    if (!config.repos.some((r) => r.id === run.repoId)) return;
    const sha = store.runPush(run.id)?.sha;
    if (sha === undefined) return;
    if (findPr(run, loop)?.state !== "open") return;
    const status = reviewStatusOf(
      store.reviewsOfRun(run.id).map(reviewFact),
      loop.epoch,
      sha,
      loop.reviewWaivedSha ?? null,
      carriedFrom(loop.carry, loop.reviewWaivedSha, sha),
    );
    if (status === null) return;
    const mark = `${sha}:${status.state}:${status.description}`;
    if (reviewStatuses.get(run.id) === mark) return;
    try {
      const r = await publisher.setReviewStatus(run, sha, status.state, status.description);
      if (r.ok) {
        reviewStatuses.set(run.id, mark);
        reviewStatusFailures.delete(run.id);
      } else noteStatusFailure(run.id, r.text);
    } catch (e) {
      noteStatusFailure(run.id, e instanceof Error ? e.message : String(e));
    }
  }

  async function pass(runId: string, round = 0): Promise<void> {
    // read before the run's row is, so no await sits between the row and the loop saved from it
    const repoId = store.run(runId)?.repoId;
    let rules = repoId === undefined ? null : await rulesFor(repoId);
    const run = store.run(runId);
    const stored = run?.loop;
    if (run === null || stored === undefined || stored === null) return;
    if (!seatKnown(run.agentId) || pausedSeat(store, run.agentId)) return;
    const at = now();
    const input: RunLoop = { ...stored };
    const pr = findPr(run, input);
    if (pr !== null && input.prNumber === null) input.prNumber = pr.number;
    if (pr?.state === "merged" && !input.merging?.done.includes("merge")) {
      if (input.merging)
        input.merging = { ...input.merging, done: [...input.merging.done, "merge"] };
      input.transient = 0;
      lastTransient.delete(runId);
    }
    if (
      activeAway(store, at, config.operator.timezone) &&
      pr?.state === "open" &&
      input.merging?.done.includes("ready") &&
      (input.merging.sha !== pr.headSha || input.lastRefusal === READY_UNDO_FAILED)
    ) {
      // A failed rollback must be retried even when the cached PR still says draft.
      if (!pr.isDraft || input.lastRefusal === READY_UNDO_FAILED) {
        const result = await publisher.markDraft({ ...run, loop: input });
        if (!result.ok) {
          log(`${runId}: could not restore draft: ${result.text}`);
          return;
        }
      }
      input.merging = null;
      if (input.lastRefusal === READY_UNDO_FAILED) input.lastRefusal = null;
      input.awayBugDecision = null;
      saveLoop(runId, input, stored, at);
      deps.pollGithub?.();
      return;
    }
    const pushed = store.runPush(run.id);
    const flightPowers = flightPowersOf(config, run.repoId);
    if (
      input.flightClearedSha &&
      pushed &&
      input.flightClearedSha !== pushed.sha &&
      !(input.carry?.from === input.flightClearedSha && input.carry.to === pushed.sha)
    )
      input.flightClearedSha = null;
    // in ci, a conflicting PR needs main's sha to merge it in, reviewer or not
    const conflicting = input.phase === "ci" && pr?.mergeable === "CONFLICTING";
    if (
      run.endedAt === null &&
      pushed !== null &&
      (input.phase === "review" || conflicting) &&
      pr?.state === "open" &&
      pr.headSha === pushed.sha &&
      config.repos.find((r) => r.id === run.repoId)?.autonomy === "merge" &&
      (conflicting || reviewerFor(run) !== null)
    ) {
      // Origin's tip is read every pass; cached strays also depend on the seat area.
      const area = [...(seatConfig(run.agentId)?.area ?? [])];
      const known =
        input.gate?.sha === pushed.sha && JSON.stringify(input.gate.area) === JSON.stringify(area)
          ? input.gate
          : null;
      if (known === null) input.gate = null;
      const g = await publisher.gateFacts(run, pushed.sha, known);
      if (g.ok) {
        input.gate = { sha: pushed.sha, ...g.facts, area };
        rules = await rulesFor(run.repoId, g.facts.mainSha);
      } else {
        input.gate = null;
        log(`${runId}: could not read the merge gate: ${g.text}`);
      }
    }
    const hardRulesHash =
      rules === null
        ? null
        : createHash("sha256").update(JSON.stringify(rules.hardRules)).digest("hex");
    if (
      run.endedAt === null &&
      pushed !== null &&
      (input.touches?.sha !== pushed.sha ||
        input.touches.flightPowers !== flightPowers ||
        input.touches.hardRulesHash !== hardRulesHash)
    ) {
      input.touches = null; // unreadable rules must not reuse the old clearance
      if (rules !== null) {
        try {
          const paths = await publisher.hardRuleTouches(
            run,
            pushed.sha,
            effectiveHardRules(rules, flightPowers),
          );
          input.touches = {
            sha: pushed.sha,
            paths,
            flightPowers,
            hardRulesHash: hardRulesHash ?? undefined,
          };
        } catch (e) {
          log(
            `${runId}: could not read the hard-rule files: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    if (flightPowers === "superuser" && pushed?.sha === input.reviewWaivedSha)
      await syncReviewStatus(runId);
    const mergeAllowed =
      config.repos.find((r) => r.id === repoId)?.autonomy === "merge" &&
      rules?.hardRulesSet === true;
    const snap = snapshot(run, input, at, mergeAllowed);
    if (snap === null) {
      // a run the loop cannot read is never woken: a stale flag must not hold up a younger rework
      if (input.aside?.wake) {
        input.aside = { ...input.aside, wake: false };
        saveLoop(runId, input, stored, at);
      }
      return;
    }
    const step = reconcile(snap);
    const cur = step.loop;
    if (
      config.repos.find((r) => r.id === run.repoId)?.autonomy === "merge" &&
      activeAway(store, now(), config.operator.timezone)?.may.safePr &&
      cur.phase === "review" &&
      pr?.state === "open" &&
      pr.isDraft &&
      pushed &&
      !(cur.merging?.sha === pushed.sha && cur.merging.done.includes("ready"))
    ) {
      step.actions.push({ kind: "mark-ready" });
    }
    const planned = { phase: cur.phase, epoch: cur.epoch };
    // a new commit in ci is a new push: its refusals are counted afresh
    if (cur.pushFor !== stored.pushFor) lastTransient.delete(run.id);
    // a run's held excerpts are for its current failure only, and none once it has ended
    for (const key of [...excerpts.keys()]) {
      if (!key.startsWith(`ci:${run.id}:`) && !key.startsWith(`rerun:${run.id}:`)) continue;
      const current =
        key === `ci:${run.id}:${cur.ciFailedSha}` ||
        key === rerunFailedKey(run.id, cur.ciFailedSha ?? "");
      // (in ci, a new report is in flight: the line about the old failure is moot)
      if (run.endedAt !== null || cur.phase === "ci" || !current) excerpts.delete(key);
    }
    saveLoop(runId, cur, stored, at);
    // The run's card is not the ended run's to move once another run has the ticket.
    const newer = run.endedAt !== null && store.hasNewerRunOnTicket(run);
    const out: Outcome = { again: false, parked: false };
    for (const a of step.actions) {
      if (out.parked) break;
      // a note that was cleared because it is no longer wanted is not raised again
      if (
        a.kind === "note" &&
        a.noteKind === "blocked" &&
        run.endedAt !== null &&
        blockedGone(run)
      ) {
        continue;
      }
      if (newer && a.kind === "move-card") continue;
      try {
        await act(a, run, cur, planned, out);
      } catch (e) {
        log(`${runId}: ${a.kind} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    saveLoop(runId, cur, store.run(runId)?.loop, at);
    await syncReviewStatus(runId);
    if (out.again && round + 1 < MAX_ROUNDS) await pass(runId, round + 1);
  }

  const ticks = tickLogOf(store);

  const reconcileRun = (runId: string): Promise<void> => {
    if (!live()) return Promise.resolve();
    return onChain(runId, async () => {
      const run = store.run(runId);
      const done = ticks.step(`reconcile ${run?.repoId} ${runId} ${run?.loop?.phase ?? "no loop"}`);
      try {
        await pass(runId);
      } finally {
        done();
      }
    });
  };

  /** Whether an ended run's Blocked move and note are settled, or no longer wanted. */
  function endedSettled(run: Run, loop: RunLoop): boolean {
    // a merged run in a merge workspace still owes its local branch (a crash after end-run)
    if (
      config.repos.find((r) => r.id === run.repoId)?.autonomy === "merge" &&
      loop.merging !== undefined &&
      loop.merging !== null &&
      !loop.merging.done.includes("delete-local")
    ) {
      return false;
    }
    // (another run has the ticket: the card is that run's now, and nothing here may move it)
    if (loop.phase === "done" || store.hasNewerRunOnTicket(run)) return true;
    if (!loop.parked?.ended || loop.cardFor !== cardMark("parked", loop.epoch)) return false;
    return (
      store.openNoteKeys(run.id).includes(blockedNoteKey(run.id, loop.epoch)) || blockedGone(run)
    );
  }

  /** Whether an ended run's blocked note is no longer wanted: its PR is done, its card moved on, or a newer run took the ticket. */
  function blockedGone(run: Run): boolean {
    const issue = issueOf(run);
    if (issue === null) return false;
    const pr = findPr(run, run.loop ?? NEW_LOOP);
    if (pr !== null && pr.state !== "open") return true;
    if (store.hasNewerRunOnTicket(run)) return true;
    const repo = config.repos.find((r) => r.id === run.repoId);
    const item = store.board(run.repoId).find((b) => b.issueNumber === issue);
    // Only a card the hub moved to Blocked can have left it: a draft repo's card is never moved,
    // and a move that failed leaves the card wherever it was.
    const movedThere = store
      .boardMovesOfRun(run.id)
      .some((m) => m.column === "Blocked" && m.state === "done");
    return (
      repo?.autonomy === "merge" &&
      movedThere &&
      item !== undefined &&
      hudColumnOf(item) !== "Blocked"
    );
  }

  /** Whether the run's PR is merged (found on GitHub, or by the merge step). */
  function mergedRun(run: Run): boolean {
    const loop = run.loop ?? NEW_LOOP;
    return findPr(run, loop)?.state === "merged" || (loop.merging?.done ?? []).includes("merge");
  }

  async function sweepNotes(notes = store.notes()): Promise<void> {
    const at = now();
    for (const n of notes) {
      const run = n.runId === null ? null : store.run(n.runId);
      if (run === null || run.endedAt === null) continue;
      if (n.key === `${run.id}:file-minor`) continue;
      // a merged run's leftover branch waits (its PR is done by design) until the branch is gone
      if (n.runId !== null && n.key === cleanupBranchNoteKey(n.runId)) {
        if (await publisher.localBranchGone(run)) {
          store.clearNote(n.key, at);
          bus.emit("attention");
        }
        continue;
      }
      // (and a merged run's cleanup note: the PR is done, so the branch it names still waits)
      if (n.key === `cleanup:${run.id}` && mergedRun(run)) continue;
      if (n.kind === "blocked" ? blockedGone(run) : n.kind !== "question") {
        store.clearNote(n.key, at);
        bus.emit("attention");
      }
    }
  }

  /** Gives back the takes older than `TAKE_STALE_MS`; `all`: every one (no take is in flight at boot). */
  function untakeStale(all = false): void {
    for (const row of store.staleTakes(all ? Number.POSITIVE_INFINITY : now() - TAKE_STALE_MS)) {
      if (!seatKnown(row.seatId)) continue;
      const runId = supervisor.seat(row.seatId)?.runId ?? null;
      const active = runId === null ? null : store.run(runId);
      if (active?.ticket === `${row.repoId}#${row.issue}` && active.endedAt === null) continue;
      store.untake(row.seatId, row.repoId, row.issue);
    }
  }

  function loopRuns(): Run[] {
    return store.loopRuns(now() - ENDED_RECONCILE_MS).filter((r) => {
      if (r.loop === undefined || r.loop === null) return false;
      return r.endedAt === null || !endedSettled(r, r.loop);
    });
  }

  /** Refills the queues, then each writer seat that is idle with no run takes its next ticket. */
  async function takeForSeats(): Promise<void> {
    try {
      await deps.refillQueues();
    } catch (e) {
      log(`refill: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const seats = (config.crew?.sessions ?? []).flatMap((s) => s.seats);
    await Promise.all(
      seats
        .filter((s) => !s.retiring && !seatUnavailable(s) && seatDef(s).loop === "build")
        .filter((s) => !pausedSeat(store, s.id) && seatMayTake(store, s.id, maxOpenRunsOf(config)))
        .map((s) =>
          deps.takeNext(s.id).catch((e: unknown) => {
            log(`take ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
          }),
        ),
    );
  }

  /** Supersedes a review that is still going or waiting; true when it was. */
  function dropReview(row: ReviewRow): boolean {
    const at = now();
    const ok = store.setReviewState(row.id, ["queued", "starting", "running"], "superseded", {
      at,
    });
    if (ok) {
      store.addLoopEvent(
        reviewEventKey(row.authorRunId, row.id, "dropped"),
        row.authorRunId,
        reviewDroppedText(row.sha),
        at,
      );
    }
    return ok;
  }

  /** Ends the review's run when it has one that has not ended. */
  async function endReviewRun(row: ReviewRow, reason?: "superseded"): Promise<void> {
    if (row.runId === null) return;
    if (store.run(row.runId)?.endedAt === null) await supervisor.endRunByEngine(row.runId, reason);
  }

  /** Whether the review's author run is in review on the sha the hub pushed, its PR open at that head. */
  function reviewWanted(row: ReviewRow): boolean {
    const author = store.run(row.authorRunId);
    const loop = author?.loop;
    if (author === null || loop === undefined || loop === null) return false;
    if (author.endedAt !== null || loop.epoch !== row.epoch) return false;
    const head = store.runPush(author.id)?.sha;
    if (head === undefined) return false;
    const own = head === row.sha && loop.phase === "review";
    // a review of the sha the head carries stays wanted through the merge's `ci` phase
    const carried =
      carriedFrom(loop.carry, loop.reviewWaivedSha, head) === row.sha &&
      (loop.phase === "review" || loop.phase === "ci");
    if (!own && !carried) return false;
    const pr = findPr(author, loop);
    return pr !== null && pr.state === "open" && (pr.headSha === row.sha || pr.headSha === head);
  }

  async function reviewWaitsForOlderPr(row: ReviewRow): Promise<boolean> {
    const author = store.run(row.authorRunId);
    if (author === null) return true;
    const prs = prsFor(author.repoId);
    const ownAuthor = prs.find((pr) => pr.number === row.prNumber)?.author;
    const older = prs.filter(
      (pr) =>
        pr.state !== "closed" &&
        pr.number < row.prNumber &&
        !(ownAuthor != null && pr.author != null && pr.author === ownAuthor),
    );
    if (older.length === 0) return false;
    try {
      const rules = await rulesFor(author.repoId);
      if (rules === null) return true;
      const hardRules = effectiveHardRules(rules, flightPowersOf(config, author.repoId));
      const own = await publisher.reviewPr(author, row.prNumber);
      if (
        own === null ||
        own.state !== "open" ||
        (own.headSha !== row.sha && own.headSha !== store.runPush(author.id)?.sha)
      )
        return true;
      const baseFor = (number: number, head: string, base: string): string => {
        const key = `review-base:${author.repoId}:${number}:${head}`;
        const saved = store.getSetting(key);
        if (saved !== null) return saved;
        store.setSetting(key, base);
        return base;
      };
      const paths = await publisher.hardRuleTouches(
        author,
        row.sha,
        hardRules,
        undefined,
        baseFor(row.prNumber, own.headSha, own.baseSha),
      );
      if (JSON.stringify(await publisher.reviewPr(author, row.prNumber)) !== JSON.stringify(own))
        return true;
      const snapshots = new Map<number, string>();
      const candidates = older.flatMap((pr) => {
        const run = store.runsOnBranch(author.repoId, pr.branch).find((r) => r.id !== author.id);
        return run === undefined ? [] : [{ pr, run }];
      });
      const terminalKey = (number: number) => `review-merged:${author.repoId}:${number}`;
      const reads = await Promise.all(
        candidates.map(async ({ pr, run }) => {
          const saved = store.getSetting(terminalKey(pr.number));
          const snapshot: Awaited<ReturnType<Publisher["reviewPr"]>> =
            saved === null ? await publisher.reviewPr(run, pr.number) : JSON.parse(saved);
          if (snapshot?.state === "merged") {
            store.setSetting(terminalKey(pr.number), JSON.stringify(snapshot));
          } else if (snapshot !== null) {
            snapshots.set(pr.number, JSON.stringify(snapshot));
          }
          return { pr: { ...pr, ...snapshot }, run, snapshot };
        }),
      );
      let waiting = false;
      for (const { pr, run, snapshot } of reads) {
        if (snapshot === null) return true;
        if (pr.state === "closed") continue;
        if (
          pr.state === "merged" &&
          pr.mergeCommitSha &&
          (await publisher.isDescendant(
            author,
            pr.mergeCommitSha,
            store.runPush(author.id)?.sha ?? row.sha,
          ))
        )
          continue;
        const base = baseFor(pr.number, snapshot.headSha, snapshot.baseSha);
        const key = `review-touches:v2:${author.repoId}:${pr.number}:${pr.headSha}:${base}:${pr.state}:${pr.mergeCommitSha}:${JSON.stringify(hardRules)}`;
        const saved = store.getSetting(key);
        let touched: string[];
        if (saved !== null) {
          touched = (JSON.parse(saved) as { headSha: string; files: string[] }).files;
        } else if (pr.headSha === null || !seatKnown(run.agentId)) {
          // A known run whose seat disappeared cannot establish disjointness.
          touched = paths;
        } else {
          if (pr.state === "merged" && !pr.mergeCommitSha) return true;
          touched = await publisher.hardRuleTouches(
            run,
            pr.headSha,
            hardRules,
            pr.state === "merged" ? (pr.mergeCommitSha ?? undefined) : undefined,
            base,
          );
          store.setSetting(key, JSON.stringify({ headSha: pr.headSha, files: touched }));
        }
        const shared = touched.filter((path) => paths.includes(path));
        if (shared.length === 0) continue;
        if (pr.state === "merged") {
          if (
            pr.mergeCommitSha &&
            (await publisher.isDescendant(
              author,
              pr.mergeCommitSha,
              store.runPush(author.id)?.sha ?? row.sha,
            ))
          )
            continue;
          // Queue on the author's chain: review supervision can itself be called from a pass.
          // Never release this row until ancestry is proved, even if updating fails or waits.
          void onChain(author.id, async () => {
            if (!live() || !reviewWanted(row)) return;
            const current = store.run(author.id);
            const loop = current?.loop;
            if (!current || !loop || !pr.mergeCommitSha) return;
            const worktree = worktreeOf(current, loop);
            if (worktree === null) return;
            const gate = await publisher.gateFacts(current, row.sha, null);
            if (!gate.ok) return;
            const mainSha = gate.facts.mainSha;
            if (!(await publisher.isDescendant(current, pr.mergeCommitSha, mainSha))) return;
            if (!live()) return;
            const onSeat = supervisor.seat(current.agentId)?.runId === current.id;
            if (onSeat && supervisor.seatFacts(current.agentId)?.inTurn !== false) return;
            const result = await publisher.updateBranch(current, mainSha, worktree);
            if (result.ok && result.kind !== "wait") {
              branchUpdated(current, { ...loop }, mainSha, result, now());
            }
          });
          waiting = true;
          continue;
        }
        waiting = true;
        store.addLoopEvent(
          reviewEventKey(author.id, row.id, `waits:${pr.number}:${pr.headSha}`),
          author.id,
          `waits for #${pr.number} (shared: ${shared.join(", ")})`,
          now(),
        );
      }
      const revalidated = await Promise.all(
        [...snapshots].map(
          async ([number, snapshot]) =>
            JSON.stringify(await publisher.reviewPr(author, number)) === snapshot,
        ),
      );
      if (revalidated.some((unchanged) => !unchanged)) return true;
      if (JSON.stringify(await publisher.reviewPr(author, row.prNumber)) !== JSON.stringify(own))
        return true;
      return waiting;
    } catch (e) {
      log(
        `${author.id}: could not read review overlaps: ${e instanceof Error ? e.message : String(e)}`,
      );
      return true;
    }
  }

  /** Keeps the running reviews going, ends the finished ones' runs and starts the queued ones. */
  async function superviseReviews(): Promise<void> {
    if (!live()) return;
    await supervisor.resumeDeferredRuns?.();
    if (!live()) return;
    // 1. the health of each running review
    for (const row of store.reviewsIn(["running"])) {
      if (row.runId === null) continue;
      const rrun = store.run(row.runId);
      if (rrun === null) continue;
      const pausedMs = reviewPausedMs(store, row, now());
      if (pausedSeat(store, row.seatId)) continue;
      const author = store.run(row.authorRunId);
      const phase = author?.loop?.phase;
      if (author === null || author.endedAt !== null || phase === "done" || phase === "parked") {
        dropReview(row);
        await endReviewRun(row, "superseded");
        continue;
      }
      // a run that ended while its review is no longer wanted (the head moved) was cut short by
      // that, not a failure of its own
      if (rrun.endedAt !== null && !reviewWanted(row)) {
        dropReview(row);
        continue;
      }
      let seatRow: ReturnType<Supervisor["seat"]>;
      try {
        seatRow = supervisor.seat(row.seatId);
      } catch {
        continue;
      }
      const facts = supervisor.seatFacts(row.seatId);
      const holdsRun = seatRow?.runId === rrun.id && rrun.endedAt === null;
      const turnEnded = seatRow?.lastTurnEndedAt ?? null;
      const at = now();
      const action = reviewRunStep({
        reviewRunId: rrun.id,
        prNumber: row.prNumber,
        now: at,
        hubStartedAt: deps.hubStartedAt,
        startedAt: (row.startedAt ?? row.createdAt) + pausedMs,
        run: {
          startedAt: rrun.startedAt,
          ended: rrun.endedAt === null ? null : { reason: endReason(rrun) },
          tokens: rrun.tokens === null ? 0 : rrun.tokens.input + rrun.tokens.output,
        },
        seat: {
          holdsRun,
          starting: supervisor
            .busy()
            .some((b) => b.seatId === row.seatId && b.state === "starting"),
          state: seatRow?.state ?? "stopped",
          inTurn: !holdsRun || (facts?.inTurn ?? false),
          lastTurnEndedAt:
            holdsRun && turnEnded !== null && turnEnded >= rrun.startedAt ? turnEnded : null,
          resumedAt: holdsRun ? (facts?.resumedAt ?? null) : null,
          rateLimitedUntil: holdsRun ? (facts?.rateLimitedUntil ?? null) : null,
        },
        claimed: store.claimedKeys(rrun.id),
        lastEngineLineAt: store.lastEngineLineAt(rrun.id),
        tokenBudget: reviewBudgetOf(row.seatId),
      });
      if (action === null) continue;
      if (action.kind === "send") {
        await send(rrun.id, action.key, action.text);
        continue;
      }
      if (store.setReviewState(row.id, ["running"], "failed", { at, failure: action.reason })) {
        store.addLoopEvent(
          reviewEventKey(row.authorRunId, row.id, "failed"),
          row.authorRunId,
          reviewFailedText(seatCallSign(row.seatId), row.sha, action.reason),
          at,
        );
        await endReviewRun(row);
        void reconcileRun(row.authorRunId);
      }
    }
    // 2. a review that is over keeps no run
    for (const row of store.reviewsWithLiveRun()) {
      if (row.runId !== null) await supervisor.endRunByEngine(row.runId);
    }
    // 3. a queued review for a seat that is no longer its author's reviewer is dropped; the author's
    // next pass requests it again for the current one
    for (const row of store.reviewsIn(["queued"])) {
      const author = store.run(row.authorRunId);
      if (author === null || row.seatId === reviewerFor(author)?.id) continue;
      const at = now();
      if (store.setReviewState(row.id, ["queued"], "superseded", { at })) {
        store.addLoopEvent(
          reviewEventKey(row.authorRunId, row.id, "dropped"),
          row.authorRunId,
          reviewDroppedText(row.sha),
          at,
        );
        void reconcileRun(author.id);
      }
    }
    // 4. each free scratch seat starts its oldest wanted review. Existing reviews continue.
    const capacityConfig = config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS;
    if (
      machineCapacity(
        store.machineSamples(machineCapacitySince(now(), capacityConfig)),
        now(),
        capacityConfig,
      ).blocked
    )
      return;
    const scratch = (config.crew?.sessions ?? [])
      .flatMap((s) => s.seats)
      .filter((x) => !x.retiring && !seatUnavailable(x) && modeOfSeat(x) === "scratch");
    for (const seat of scratch) {
      if (pausedSeat(store, seat.id)) continue;
      const held = supervisor.seat(seat.id)?.runId ?? null;
      const heldRun = held === null ? null : store.run(held);
      const free = heldRun === null || heldRun.endedAt !== null;
      if (!free || supervisor.busy().some((b) => b.seatId === seat.id)) continue;
      if (accountAtStop(config, store, seat.accountId, now())) continue;
      for (const row of store.reviewsIn(["queued"]).filter((r) => r.seatId === seat.id)) {
        if (!reviewWanted(row)) {
          dropReview(row);
          continue;
        }
        if (await reviewWaitsForOlderPr(row)) continue;
        if (!reviewWanted(row)) {
          dropReview(row);
          continue;
        }
        // an earlier start awaited: the seat may have been removed or retired since the list was taken
        const current = (config.crew?.sessions ?? [])
          .flatMap((x) => x.seats)
          .find((x) => x.id === seat.id);
        if (
          current === undefined ||
          current.retiring ||
          seatUnavailable(current) ||
          pausedSeat(store, seat.id)
        )
          break;
        if (!store.setReviewState(row.id, ["queued"], "starting", { at: now() })) continue;
        let runId: string | null = null;
        try {
          ({ runId } = await supervisor.startReview(seat.id, row.id));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          log(`${seat.id}: could not start review ${row.id}: ${message}`);
          if (isTransientStart(e)) {
            store.setReviewState(row.id, ["starting"], "queued", { at: now() });
          } else {
            const failure = Array.from(message).slice(0, STDERR_TEXT_MAX).join("");
            if (store.setReviewState(row.id, ["starting"], "failed", { at: now(), failure })) {
              store.addLoopEvent(
                reviewEventKey(row.authorRunId, row.id, "failed"),
                row.authorRunId,
                reviewFailedText(seatCallSign(seat.id), row.sha, failure),
                now(),
              );
            }
          }
        }
        if (runId !== null) {
          if (store.setReviewState(row.id, ["starting"], "running", { at: now(), runId })) {
            store.addLoopEvent(
              reviewEventKey(row.authorRunId, row.id, "started"),
              row.authorRunId,
              reviewStartedText(seatCallSign(seat.id), row.sha),
              now(),
            );
          } else {
            await supervisor.endRunByEngine(runId);
          }
        }
        void reconcileRun(row.authorRunId);
        break;
      }
    }
  }

  /** The seat is free (a run ended or left it): its runs waiting off it are looked at again. */
  function kickAside(seatId: string, except?: string): void {
    if (!live()) return;
    for (const r of store.asideRuns()) {
      if (r.agentId === seatId && r.id !== except) void reconcileRun(r.id);
    }
  }

  /** A reported second review is logged as a FLIGHT decision with both verdicts. */
  function logSecondReview(rv: ReviewRow): void {
    const author = store.run(rv.authorRunId);
    const second = author?.loop?.flightSecondReview?.[rv.sha];
    const row = store.review(rv.id);
    if (author === null || second === undefined || second.epoch !== rv.epoch) return;
    if (row?.state !== "reported") return;
    const first = store.review(second.firstReviewId);
    const said = (r: ReviewRow | null): string =>
      r?.verdict ? `spec ${r.verdict.spec}, quality ${r.verdict.quality}` : "no verdict";
    store.addFlightDecision({
      at: now(),
      kind: "settle",
      seatId: author.agentId,
      targetRunId: author.id,
      ref: null,
      questionId: null,
      about: "second_review",
      decision: `Second review ${row.blocking > 0 ? "holds" : "passes"} (${said(row)}); the first held (${said(first)})`,
      basis: second.reason,
    });
  }

  function kickReviews(): Promise<void> {
    if (!live()) return Promise.resolve();
    return onChain(REVIEWS_CHAIN, superviseReviews);
  }

  async function refreshRuleNotes(runs: Run[]): Promise<void> {
    for (const repoId of new Set(runs.map((r) => r.repoId))) await rulesFor(repoId);
  }

  const engine: Engine = {
    start() {
      if (!deps.enabled || started) return;
      started = true;
      unsubscribe = supervisor.on((e) => {
        if (e.kind === "run-ended") {
          lastSync.delete(e.runId);
          ticketTries.delete(e.runId);
          kickAside(e.seatId);
        }
        const rv = store.reviewOfRun(e.runId);
        if (rv !== null) {
          if (e.kind === "findings") {
            logSecondReview(rv);
            // The author run (aside or not) is looked at now, so its rework is flagged before a
            // slow review start can let the seat take a new ticket; once is enough (a second
            // pass would only retry a transient step ahead of its tick).
            void reconcileRun(rv.authorRunId);
            void kickReviews();
            return;
          }
          void kickReviews().then(() => reconcileRun(rv.authorRunId));
          return;
        }
        if (e.kind === "run-ended" && e.endedBy === "engine") return;
        if (e.kind === "idle") void wakePendingWork(e.runId);
        void reconcileRun(e.runId);
      });
      // Nothing is read or written unless this process runs crew (it holds the lock): boot must
      // never fail on engine state, and the tick picks the work up once the lock is held.
      if (!live()) return;
      try {
        untakeStale(true);
        // no review start is in flight at boot
        for (const row of store.reviewsIn(["starting"])) {
          const started = store.runOfReview(row.id);
          if (started === null) {
            store.setReviewState(row.id, ["starting"], "queued", { at: now() });
          } else {
            store.setReviewState(row.id, ["starting"], "running", {
              at: now(),
              runId: started.id,
            });
          }
        }
        for (const r of loopRuns()) void reconcileRun(r.id);
        void sweepNotes().catch((e: unknown) => {
          log(`start: ${e instanceof Error ? e.message : String(e)}`);
        });
        void kickReviews();
      } catch (e) {
        log(`start: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },

    async tick() {
      if (!live()) return;
      const startedAt = now();
      ticks.begin(startedAt);
      let timer: ReturnType<typeof setTimeout> | null = null;
      // a tick past its interval is logged once, with what it is on (the scheduler skips the next)
      const noteOverrun = () => {
        const steps = ticks.overrun();
        if (steps !== null) log(overrunText(startedAt, steps));
      };
      // work that blocks the event loop starves the timer, so each step also checks the clock
      const phase = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
        const done = ticks.step(label);
        try {
          return await fn();
        } finally {
          if (now() - startedAt >= ENGINE_TICK_MS) noteOverrun();
          done();
        }
      };
      try {
        timer = setTimeout(noteOverrun, ENGINE_TICK_MS);
        timer.unref();
        const notes = await phase("load notes", () => store.notes());
        const cache = { prs: new Map<RepoId, ReturnType<Store["pullRequests"]>>(), notes };
        await tickCache.run(cache, async () => {
          const runs = await phase("list runs", loopRuns);
          await phase("wake pending work", () =>
            Promise.all(runs.map((r) => wakePendingWork(r.id))),
          );
          await phase("watch green evidence", () =>
            Promise.all(
              store
                .runsActiveSince(now())
                .filter((r) => r.loop !== null && r.loop !== undefined)
                .map((run) => watchGreenEvidence(run, notes)),
            ),
          );
          await Promise.all(runs.map((r) => reconcileRun(r.id)));
          await phase("refresh rule notes", () => refreshRuleNotes(runs));
          await phase("sweep notes", () => sweepNotes(notes));
          await phase("untake stale", untakeStale);
          await phase("release dependents", () =>
            releaseDependents({
              store,
              config,
              now,
              move: deps.board.move,
              syncMain: engine.syncMain,
              rules: deps.rules,
              fetchTicket: deps.fetchTicket,
              prsFor,
              ...(deps.pollGithub ? { pollGithub: deps.pollGithub } : {}),
              log,
            }),
          );
          await phase("take for seats", takeForSeats);
          await phase("kick reviews", kickReviews);
        });
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (now() - startedAt >= ENGINE_TICK_MS) noteOverrun();
        ticks.end(now());
      }
    },

    reconcileRun,

    async reconcileRepo(repoId) {
      if (!live()) return;
      const runs = loopRuns().filter((r) => r.repoId === repoId && r.endedAt === null);
      await Promise.all(runs.map((r) => reconcileRun(r.id)));
    },

    onOperatorMessage(runId, by = "CAPCOM", opts) {
      if (!live()) return Promise.resolve({ lifted: false, reason: "engine-off" });
      // a pass that throws before deciding leaves this: the error is logged by the chain
      let result: OperatorResult = { lifted: false, reason: "engine-error" };
      const refuse = (reason: OperatorRefusal): void => {
        result = { lifted: false, reason };
      };
      return onChain(runId, async () => {
        const run = store.run(runId);
        const loop = run?.loop;
        if (run === null || loop === undefined || loop === null) return refuse("not-parked");
        if (pausedSeat(store, run.agentId)) return refuse("held");
        const kind = loop.parked?.kind;
        if (
          run.endedAt !== null ||
          loop.phase !== "parked" ||
          loop.parked === null ||
          loop.parked.ended
        )
          return refuse("not-parked");
        if (kind === "pr-closed") return refuse("pr-closed");
        if (by === "FLIGHT" && kind === "budget") return refuse("held");
        if (kind === "budget" && isDollarCapReason(loop.parked.reason)) return refuse("dollar-cap");
        // only the controller's verdict settles a controller check, for every caller
        if (kind === CONTROLLER_CHECK_PARK) return refuse("use-controller-check");
        if (kind === UAT_PARK) return refuse("use-uat");
        if (kind === MERGE_HOLD_PARK) return refuse("use-merge-hold");
        if (by === "FLIGHT" && kind === "review-failed" && opts?.action !== "rereview")
          return refuse("wrong-action");
        if (opts?.kinds !== undefined && (kind === undefined || !opts.kinds.includes(kind)))
          return refuse("wrong-action");
        if (by === "FLIGHT" && flightHeld(run)) return refuse("held");
        let secondOf: { firstReviewId: number; firstAccountId: string } | null = null;
        if (opts?.action !== undefined) {
          if (
            (by === "CAPCOM" && opts.action !== "accept") ||
            (by === "FLIGHT" && flightPowersOf(config, run.repoId) !== "superuser")
          )
            return refuse("not-permitted");
          const pushed = store.runPush(run.id);
          const pr = findPr(run, loop);
          if (!pushed) return refuse("head-moved");
          if (opts.action !== "lift" && pr?.state !== "open") return refuse("pr-not-open");
          if (opts.action !== "lift" && pr?.headSha !== pushed.sha) return refuse("head-moved");
          if (opts.action === "lift") {
            if (kind !== "stuck") return refuse("wrong-action");
            const head = store.newestRunCommit(run.id)?.sha;
            if (!head || !(await publisher.isDescendant(run, pushed.sha, head)))
              return refuse("head-moved");
          } else if (
            kind !== "review" &&
            kind !== "review-ruling" &&
            !(kind === "review-failed" && opts.action === "rereview")
          )
            return refuse("wrong-action");
          if (opts.action === "second_review") {
            if (loop.flightSecondReview?.[pushed.sha] !== undefined)
              return refuse("second-review-done");
            const first = store
              .reviewsOfRun(run.id)
              .filter((r) => r.sha === pushed.sha && r.state === "reported")
              .at(-1);
            // only a blocking review on the floor paths needs a reviewer FLIGHT does not control
            if (!first || first.blocking === 0) return refuse("wrong-action");
            const paths = await publisher.hardRuleTouches(
              run,
              pushed.sha,
              FLIGHT_FLOOR_ENFORCING_PATHS,
            );
            if (paths.length === 0) return refuse("wrong-action");
            const firstAccountId = seatConfig(first.seatId)?.accountId ?? "";
            if (
              reviewerOf(config, run.agentId, reviewRoleOf(run), {
                store,
                now: now(),
                exceptAccount: firstAccountId,
              }) === null
            )
              return refuse("no-second-reviewer");
            secondOf = { firstReviewId: first.id, firstAccountId };
          }
          if (opts.action === "accept") {
            const review = store
              .reviewsOfRun(run.id)
              .filter((r) => r.sha === pushed.sha && r.state === "reported")
              .at(-1);
            if (!review || review.blocking > 0) {
              const paths = await publisher.hardRuleTouches(
                run,
                pushed.sha,
                FLIGHT_FLOOR_ENFORCING_PATHS,
              );
              if (paths.length > 0) return refuse("floor-enforced");
            }
          }
          if (flightHeld(store.run(run.id) ?? run)) return refuse("held");
        }
        if (opts?.beforeLift !== undefined && !(await opts.beforeLift()))
          return refuse("before-lift");
        const at = now();
        const head = store.newestRunCommit(run.id)?.sha ?? null;
        const pushed = store.runPush(run.id);
        const pr = findPr(run, loop);
        const next: RunLoop = {
          ...loop,
          epoch: loop.epoch + 1,
          parked: null,
          ciFails: 0,
          transient: 0,
          lastRefusal: null,
          unparkedAt: at,
        };
        if (kind === "budget") {
          next.budgetExtra += config.crew?.runTokenBudget ?? 0;
        }
        if (kind === "review" || kind === "review-ruling") {
          const staysInReview = opts?.action === "accept" || opts?.action === "second_review";
          next.phase = staysInReview ? "review" : "working";
          if (!staysInReview) {
            next.reviewWaivedSha = null;
            next.flightClearedSha = null;
          }
        } else if (kind === "ruling" || kind === "review-failed") {
          next.phase = "review";
        } else if (head !== null && pushed?.sha === head && (pr === null || pr.state === "open")) {
          // re-judged on the next pass (an open PR is read, a missing one is opened again);
          // its clocks run from now
          next.phase = "ci";
          next.pushStartedAt = at;
          next.pushFor = head;
        } else {
          next.phase = "working";
        }
        if (opts?.action === "accept") {
          next.reviewWaivedSha = pushed?.sha ?? null;
          next.flightClearedSha = pushed?.sha ?? null;
          next.phase = "review";
        } else if (opts?.action === "second_review" && secondOf !== null && pushed) {
          next.reviewWaivedSha = null;
          next.flightClearedSha = null;
          next.phase = "review";
          next.flightSecondReview = {
            ...loop.flightSecondReview,
            [pushed.sha]: { epoch: next.epoch, ...secondOf, reason: opts.note ?? "" },
          };
        } else if (opts?.action === "rereview" || opts?.action === "rework") {
          next.reviewWaivedSha = null;
          next.flightClearedSha = null;
          next.phase = opts.action === "rereview" ? "review" : "working";
          if (opts.action === "rework") {
            if (pushed)
              next.flightReworks = {
                ...loop.flightReworks,
                [pushed.sha]: (loop.flightReworks?.[pushed.sha] ?? 0) + 1,
              };
            const findings = reworkFindings(run.id, loop.parked.reason);
            const message =
              opts.note === undefined ? findings : `${findings}\n\nFLIGHT fix list: ${opts.note}`;
            // a run set aside is woken first; its seat on another run (a 409) queues the rework
            let queue = false;
            if (next.aside) {
              try {
                await supervisor.wakeRun(run.id);
                next.aside = null;
              } catch (e) {
                if ((e as { status?: unknown }).status !== 409) return refuse("rework-undelivered");
                queue = true;
              }
            }
            if (queue && next.aside) {
              // the rework waits in Comms for this run, and the engine wakes it, in working, once
              // its seat is free (as a failed controller check does)
              const stored = store.addComms({
                at,
                // the rework is FLIGHT's request, filed from its seat
                from:
                  config.crew?.sessions
                    .flatMap((x) => x.seats)
                    .find((x) => seatDef(x).loop === "watch")?.id ?? COMMS_CAPCOM,
                to: run.agentId,
                ticket: run.ticket ?? null,
                ref: run.ticket ?? null,
                targetRunId: run.id,
                text: commsMirror(
                  message,
                  "FLIGHT requested rework; the full request was sent to the seat.",
                ),
              });
              if (stored === null) return refuse("rework-undelivered");
              store.markCommsInboxRead(run.agentId, [stored.id]);
              next.pendingLine = { key: `${run.id}:flight-rework:${next.epoch}`, text: message };
              next.aside = { ...next.aside, wake: true };
            } else {
              const sent = await supervisor.send(
                run.id,
                `${run.id}:flight-rework:${next.epoch}`,
                message,
              );
              if (sent !== "sent" && sent !== "dup") return refuse("rework-undelivered");
            }
          }
        }
        if (next.aside) next.aside = { ...next.aside, wake: true };
        store.setRunLoop(run.id, next);
        lastTransient.delete(run.id);
        store.addLoopEvent(`${run.id}:resumed:${next.epoch}`, run.id, `resumed by ${by}`, at);
        bus.emit("agents");
        result = { lifted: true };
        await pass(run.id);
      }).then(() => result);
    },

    controllerCheck(runId, verdict, sha, note) {
      let result: OperatorResult = { lifted: false, reason: "engine-error" };
      const refuse = (reason: OperatorRefusal): void => {
        result = { lifted: false, reason };
      };
      if (!live()) return Promise.resolve({ lifted: false, reason: "engine-off" });
      return onChain(runId, async () => {
        const run = store.run(runId);
        const loop = run?.loop;
        if (run === null || !loop) return refuse("not-parked");
        const held = loop.controllerCheck;
        if (
          run.endedAt !== null ||
          loop.phase !== "parked" ||
          loop.parked?.kind !== CONTROLLER_CHECK_PARK ||
          loop.parked.ended ||
          !held
        )
          return refuse("not-parked");
        // the verdict is for the head the operator looked at
        if (sha.length < 7 || !held.sha.startsWith(sha.toLowerCase())) return refuse("head-moved");
        const at = now();
        const short = held.sha.slice(0, 7);
        if (verdict === "pass") {
          const pushed = store.runPush(run.id);
          const pr = findPr(run, loop);
          if (pr?.state !== "open") return refuse("pr-not-open");
          if (pushed?.sha !== held.sha || pr.headSha !== held.sha) return refuse("head-moved");
          store.setRunLoop(run.id, {
            ...loop,
            phase: held.from,
            parked: null,
            controllerCheck: { ...held, pass: true },
          });
          store.addLoopEvent(
            `${run.id}:${loop.epoch}:controller-check:${held.sha}:pass`,
            run.id,
            `controller check passed on ${short}`,
            at,
          );
        } else {
          const next: RunLoop = {
            ...loop,
            epoch: loop.epoch + 1,
            phase: "working",
            parked: null,
            controllerCheck: null,
            ciFails: 0,
            transient: 0,
            lastRefusal: null,
            unparkedAt: at,
            reviewWaivedSha: null,
            flightClearedSha: null,
          };
          const text = controllerCheckFailText(held.sha, note);
          const key = `${run.id}:controller-check-fail:${held.sha}:${loop.epoch}`;
          if (
            !(await sendBack(
              run,
              loop,
              next,
              text,
              key,
              "Controller check failed; the full note was sent to the seat.",
            ))
          )
            return refuse("rework-undelivered");
          store.setRunLoop(run.id, next);
          store.addLoopEvent(
            `${run.id}:${loop.epoch}:controller-check:${held.sha}:fail`,
            run.id,
            `controller check failed on ${short}: sent back for rework`,
            at,
          );
        }
        lastTransient.delete(run.id);
        bus.emit("agents");
        bus.emit("attention");
        result = { lifted: true };
        await pass(run.id);
      }).then(() => result);
    },

    uat(runId, verdict, sha, note) {
      let result: OperatorResult = { lifted: false, reason: "engine-error" };
      const refuse = (reason: OperatorRefusal): void => {
        result = { lifted: false, reason };
      };
      if (!live()) return Promise.resolve({ lifted: false, reason: "engine-off" });
      return onChain(runId, async () => {
        const run = store.run(runId);
        const loop = run?.loop;
        if (run === null || !loop) return refuse("not-parked");
        const held = loop.uat;
        if (
          run.endedAt !== null ||
          loop.phase !== "parked" ||
          loop.parked?.kind !== UAT_PARK ||
          loop.parked.ended ||
          !held
        )
          return refuse("not-parked");
        // the verdict is for the head the operator looked at
        if (sha.length < 7 || !held.sha.startsWith(sha.toLowerCase())) return refuse("head-moved");
        const at = now();
        const short = held.sha.slice(0, 7);
        if (verdict === "accept") {
          // an acceptance is for the head the operator looked at; a send back is allowed on a moved head
          const pushed = store.runPush(run.id);
          const pr = findPr(run, loop);
          if (pr?.state !== "open") return refuse("pr-not-open");
          if (pushed?.sha !== held.sha || pr.headSha !== held.sha) return refuse("head-moved");
          store.setRunLoop(run.id, {
            ...loop,
            phase: held.from,
            parked: null,
            uat: { ...held, accepted: true },
          });
          store.addLoopEvent(
            `${run.id}:${loop.epoch}:uat:${held.sha}:accept`,
            run.id,
            `accepted by the operator on ${short}`,
            at,
          );
        } else {
          const next: RunLoop = {
            ...loop,
            epoch: loop.epoch + 1,
            phase: "working",
            parked: null,
            uat: null,
            ciFails: 0,
            transient: 0,
            lastRefusal: null,
            unparkedAt: at,
            reviewWaivedSha: null,
            flightClearedSha: null,
          };
          if (
            !(await sendBack(
              run,
              loop,
              next,
              uatSendBackText(held.sha, note ?? ""),
              `${run.id}:uat-send-back:${held.sha}:${loop.epoch}`,
              "Sent back at acceptance; the full note was sent to the seat.",
            ))
          )
            return refuse("rework-undelivered");
          store.setRunLoop(run.id, next);
          store.addLoopEvent(
            `${run.id}:${loop.epoch}:uat:${held.sha}:send-back`,
            run.id,
            `sent back by the operator on ${short}`,
            at,
          );
        }
        lastTransient.delete(run.id);
        bus.emit("agents");
        bus.emit("attention");
        result = { lifted: true };
        await pass(run.id);
      }).then(() => result);
    },

    holdMerge(runId, by, reason) {
      const refuse = (text: string): MergeHoldResult => ({ ok: false, text });
      return onChainResult<MergeHoldResult>(runId, refuse("the engine hit an error"), async () => {
        if (!live()) return refuse("the loop engine is off");
        const run = store.run(runId);
        const loop = run?.loop;
        if (run === null || !loop || run.endedAt !== null)
          return refuse("the run is not an active looped run");
        if (loop.prNumber !== undefined && findPr(run, loop)?.state === "merged")
          return refuse("the run's PR is already merged");
        if (loop.merging?.done.includes("merge")) return refuse("the run's PR is already merged");
        if (loop.mergeHold && loop.mergeHold.by === "CAPCOM" && by !== "CAPCOM")
          return refuse("the controller already holds this run's merge");
        const at = now();
        // a run already parked on the hold keeps the phase it left, and its park names the new holder
        const parkedOnHold = loop.phase === "parked" && loop.parked?.kind === MERGE_HOLD_PARK;
        const from = loop.mergeHold?.from;
        store.setRunLoop(runId, {
          ...loop,
          mergeHold: { by, reason, at, ...(from ? { from } : {}) },
          ...(parkedOnHold && loop.parked
            ? { parked: { ...loop.parked, reason: mergeHoldParkText(by, reason) } }
            : {}),
        });
        store.addLoopEvent(
          `${runId}:merge-hold:${at}`,
          runId,
          `merge held by ${by}: ${reason}`,
          at,
        );
        bus.emit("agents");
        return { ok: true };
      });
    },

    releaseMergeHold(runId, by) {
      const refuse = (text: string): MergeHoldResult => ({ ok: false, text });
      return onChainResult<MergeHoldResult>(runId, refuse("the engine hit an error"), async () => {
        if (!live()) return refuse("the loop engine is off");
        const run = store.run(runId);
        const loop = run?.loop;
        const hold = loop?.mergeHold;
        if (run === null || !loop || !hold) return refuse("the run's merge is not held");
        if (hold.by === "CAPCOM" && by !== "CAPCOM")
          return refuse("the controller set this hold; only the controller can release it");
        const at = now();
        const next: RunLoop = { ...loop, mergeHold: null };
        if (loop.phase === "parked" && loop.parked?.kind === MERGE_HOLD_PARK) {
          next.phase = hold.from ?? "ci";
          next.parked = null;
          next.unparkedAt = at;
          next.transient = 0;
          next.lastRefusal = null;
        }
        store.setRunLoop(runId, next);
        store.addLoopEvent(
          `${runId}:merge-hold-release:${at}`,
          runId,
          `merge hold released by ${by}`,
          at,
        );
        lastTransient.delete(runId);
        bus.emit("agents");
        await pass(runId);
        return { ok: true };
      });
    },

    clearFlight(runId, expectedSha) {
      return onChainResult(runId, false, async () => {
        if (!live()) return false;
        await pass(runId);
        const run = store.run(runId);
        if (
          !run?.loop ||
          run.endedAt !== null ||
          flightPowersOf(config, run.repoId) !== "superuser" ||
          flightHeld(run)
        )
          return false;
        const sha = run.loop.awaitingFlight;
        if (
          !sha ||
          (expectedSha !== undefined && sha !== expectedSha) ||
          sha !== store.runPush(runId)?.sha
        )
          return false;
        store.setRunLoop(runId, { ...run.loop, flightClearedSha: sha, awaitingFlight: null });
        await pass(runId);
        return true;
      });
    },

    rerunCi(runId) {
      const no = (text: string) => ({ ok: false, text });
      return onChainResult(runId, no("The engine is off."), async () => {
        const run = store.run(runId);
        if (
          !live() ||
          !run?.loop ||
          run.endedAt !== null ||
          flightPowersOf(config, run.repoId) !== "superuser" ||
          flightHeld(run)
        )
          return no("Run is held or unavailable.");
        const pr = findPr(run, run.loop);
        const sha = pr?.headSha;
        if (
          pr?.state !== "open" ||
          !sha ||
          store.runPush(runId)?.sha !== sha ||
          pr.ci !== "failing"
        )
          return no("No failed CI on this run's current head.");
        const github = config.repos.find((r) => r.id === run.repoId)?.github ?? "";
        const result = await publisher.rerunRuling(github, sha);
        if (!result.ok) return no(result.text);
        return { ok: true, text: `Re-ran failed CI on ${sha.slice(0, 7)}.` };
      });
    },

    acceptRuling(runId) {
      const not = (text: string): AcceptRulingResult => ({ kind: "not", text });
      return onChainResult(runId, not("the loop engine is off"), async () => {
        if (!live()) return not("the loop engine is off");
        const run = store.run(runId);
        const loop = run?.loop;
        if (
          run == null ||
          loop == null ||
          run.endedAt !== null ||
          loop.phase !== "parked" ||
          loop.parked?.kind !== RULING_PARK ||
          loop.parked.ended
        ) {
          return not("the run is not parked on a CI ruling");
        }
        const sha = loop.ciFailedSha;
        const pr = findPr(run, loop);
        if (
          sha === null ||
          store.runPush(run.id)?.sha !== sha ||
          pr?.state !== "open" ||
          pr.headSha !== sha
        ) {
          return not("the ruled commit is no longer its open PR's head");
        }
        const github = config.repos.find((r) => r.id === run.repoId)?.github ?? "";
        const at = now();
        const rerun = loop.rulingRerun?.sha === sha ? loop.rulingRerun : null;
        if (rerun === null) {
          const r = await publisher.rerunRuling(github, sha);
          if (!r.ok) return not(r.text);
          store.setRunLoop(run.id, {
            ...loop,
            rulingRerun: { sha, runs: r.runs, outcome: "pending" },
          });
          store.addLoopEvent(
            `${run.id}:ruling-rerun:${sha}`,
            run.id,
            `FLIGHT re-ran the failed CI jobs on ${sha.slice(0, 7)}`,
            at,
          );
          bus.emit("agents");
          return { kind: "rerun", sha };
        }
        if (rerun.outcome !== "pending") {
          return not(
            `${sha.slice(0, 7)} was already re-run once; pass this ruling to the operator`,
          );
        }
        const state = await publisher.rerunState(github, sha, rerun.runs);
        if (!state.ok) return not(state.text);
        if (state.outcome === "pending") return { kind: "pending", sha };
        const passed = state.outcome === "passed";
        const next: RunLoop = {
          ...loop,
          epoch: loop.epoch + 1,
          parked: null,
          // review, though the stored poll may still say failing: only the author's failure is cleared
          phase: passed ? "review" : "working",
          ciFails: 0,
          ciFailedSha: passed ? null : sha,
          transient: 0,
          lastRefusal: null,
          unparkedAt: at,
          rulingRerun: { ...rerun, outcome: state.outcome },
        };
        store.setRunLoop(run.id, next);
        store.addLoopEvent(
          `${run.id}:ruling-rerun:${sha}:${state.outcome}`,
          run.id,
          passed
            ? `${CI_PASSED_EVENT_PREFIX}the re-run of ${sha.slice(0, 7)}; FLIGHT accepted the ruling`
            : `${CI_RERUN_FAILED_EVENT_PREFIX}${sha.slice(0, 7)}`,
          at,
        );
        bus.emit("agents");
        if (passed) deps.pollGithub?.();
        await pass(run.id);
        return { kind: passed ? "accepted" : "refused", sha };
      });
    },

    async writerSyncMain(runId) {
      const refused = (text: string) => ({ text, isError: true });
      if (!live()) return refused(MC_SYNC_OFF);
      return onChainResult<{ text: string; isError?: boolean }>(
        runId,
        refused(syncFailedText("the sync did not run")),
        async () => {
          if (!live()) return refused(MC_SYNC_OFF);
          const run = store.run(runId);
          const row = run === null ? null : store.seatSession(run.agentId);
          if (run === null || run.endedAt !== null || row?.runId !== runId) {
            lastSync.delete(runId);
            return refused(MC_RUN_ENDED);
          }
          const loop = run.loop;
          if (loop == null) return refused(MC_SYNC_OFF);
          if (loop.phase !== "working" || loop.aside) return refused(MC_SYNC_NOT_WORKING);
          if (row.worktree === null) return refused(MC_RUN_ENDED);
          if (loop.mainMerge && (await publisher.mergeHead(run, row.worktree))) {
            return { text: writerSyncConflictText(loop.mainMerge.files) };
          }
          const at = now();
          const last = lastSync.get(runId);
          if (last !== undefined && at - last < SYNC_MAIN_GAP_MS) {
            return refused(syncTooSoonText(Math.ceil((last + SYNC_MAIN_GAP_MS - at) / 60_000)));
          }
          const tip = await publisher.mainTip(run);
          if (!tip.ok) return refused(syncFailedText(tip.text));
          const r = await publisher.updateBranch(run, tip.sha, row.worktree);
          if (!r.ok) {
            if (r.text !== UPDATE_UP_TO_DATE) return refused(syncFailedText(r.text));
            return { text: MC_SYNC_UP_TO_DATE };
          }
          if (r.kind === "wait") return refused(MC_SYNC_DIRTY);
          if (store.run(runId)?.endedAt === null) lastSync.set(runId, at);
          const latestLoop = store.run(runId)?.loop;
          if (!latestLoop) return refused(MC_RUN_ENDED);
          if (r.kind === "merged") {
            store.setRunLoop(runId, { ...latestLoop, mainMerge: null });
            store.addLoopEvent(`${runId}:update:${r.sha}`, runId, mergedMainText(tip.sha), at);
          } else {
            store.setRunLoop(runId, {
              ...latestLoop,
              mainMerge: { mainSha: tip.sha, files: r.files },
            });
            store.claimLine(conflictKey(runId, tip.sha), {
              runId,
              seatId: run.agentId,
              origin: "engine",
              text: conflictText(r.files),
              at,
            });
            store.addLoopEvent(
              `${runId}:update-conflict:${tip.sha}`,
              runId,
              mainConflictText(tip.sha, r.files.length),
              at,
            );
          }
          bus.emit("agents");
          return {
            text:
              r.kind === "merged"
                ? [syncMergedText(tip.sha, r.sha), r.installNote].filter(Boolean).join("\n")
                : writerSyncConflictText(r.files),
          };
        },
      );
    },

    syncMain(runId) {
      const refused = (text: string): SyncMainResult => ({ kind: "refused", text });
      return onChainResult(runId, refused("the loop engine is off"), async () => {
        if (!live()) return refused("the loop engine is off");
        const run = store.run(runId);
        const loop = run?.loop;
        if (run == null || loop == null || run.endedAt !== null) {
          return refused("Mission Control is not driving this run");
        }
        if (config.repos.find((r) => r.id === run.repoId)?.autonomy !== "merge") {
          return refused("its repo is a draft workspace");
        }
        const parkedOn = (kind: string) =>
          loop.phase === "parked" && loop.parked?.kind === kind && !loop.parked.ended;
        const parkedOnConflict = parkedOn("conflict");
        // a push or PR GitHub does not show: the merge is the new push, so the old one need not match
        const parkedStuck = parkedOn(STUCK_PARK);
        if (loop.phase !== "ci" && loop.phase !== "review" && !parkedOnConflict && !parkedStuck) {
          return refused("the run is not in CI or review, or parked on a conflict or a stuck push");
        }
        if (loop.mainMerge) return refused("a merge of main already waits on the seat");
        const newest = store.newestRunCommit(run.id)?.sha;
        const pushed = store.runPush(run.id);
        if (!parkedStuck && (pushed === null || newest !== pushed.sha)) {
          return refused("the branch has unpushed commits");
        }
        const tip = parkedStuck ? (newest ?? pushed?.sha) : pushed?.sha;
        if (tip === undefined) return refused("the branch has no recorded commit");
        const worktree = worktreeOf(run, loop);
        if (worktree === null) return refused("the run has no worktree");
        const onSeat = supervisor.seat(run.agentId)?.runId === run.id;
        if (onSeat && supervisor.seatFacts(run.agentId)?.inTurn !== false) {
          return refused("its seat is in a turn");
        }
        const g = await publisher.gateFacts(run, tip, null);
        if (!g.ok) return refused(g.text);
        const mainSha = g.facts.mainSha;
        if (g.facts.containsMain) return { kind: "current", mainSha };
        const at = now();
        const cur: RunLoop = { ...loop };
        const r = await publisher.updateBranch({ ...run, loop: cur }, mainSha, worktree);
        if (!r.ok) return refused(r.text);
        if (r.kind === "wait") return refused("the worktree has uncommitted changes");
        if (parkedOnConflict || parkedStuck) {
          cur.epoch += 1;
          cur.parked = null;
          cur.unparkedAt = at;
          store.addLoopEvent(`${run.id}:resumed:${cur.epoch}`, run.id, "resumed by FLIGHT", at);
        }
        cur.transient = 0;
        cur.lastRefusal = null;
        lastTransient.delete(run.id);
        branchUpdated(run, cur, mainSha, r, at);
        bus.emit("agents");
        await pass(run.id);
        return r.kind === "merged"
          ? { kind: "merged", sha: r.sha, mainSha }
          : { kind: "conflict", files: r.files };
      });
    },

    uncommitted(runId) {
      return onChainResult<string[] | null>(runId, null, async () => {
        const run = store.run(runId);
        if (run == null || run.endedAt !== null) return null;
        const worktree = worktreeOf(run, run.loop ?? NEW_LOOP);
        if (worktree === null) return null;
        const paths = await publisher.worktreeChanges(run, worktree);
        return Array.isArray(paths) ? paths : null;
      });
    },

    excerptsHeld: () => excerpts.size,

    status() {
      const notes = [...ruleNotes.values()];
      return { on: live(), note: notes.length === 0 ? null : notes.join("; ") };
    },
  };
  return engine;
}
