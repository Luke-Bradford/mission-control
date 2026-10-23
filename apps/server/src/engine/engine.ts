/**
 * The engine drives each looped run from report to merged. It holds no state a restart would
 * lose: every pass rebuilds a snapshot from stored facts, asks `reconcile` (the pure function in
 * `@mc/core`) what to do, stores the run's new loop, then runs the actions. An action that fails
 * is logged and comes out again on the next pass; the lines it sends are keyed, so a repeat is
 * never written twice.
 *
 * Triggers (each runs `reconcileRun` on the run's own chain, one pass at a time): a seat leaving
 * a turn, `report_evidence`, a run ending, the GitHub poll, and the 60 s tick. It is off when
 * crew is disabled, in a preview, or with `MC_NO_LOOP_WRITES=1` (`enabled`).
 */
import {
  asideEventText,
  BLOCKING_SEVERITIES,
  blockedNoteKey,
  CI_FAILED_TEXT,
  COMMS_MC,
  cardMark,
  carriedFrom,
  cleanupBranchNoteKey,
  closedIssueText,
  deletedLocalText,
  deletedRemoteText,
  ENGINE_TICK_MS,
  EVIDENCE_RULING_PREFIX,
  fillLoopText,
  fixSentText,
  hardRulesBySettingKey,
  hardRulesUnsetNoteKey,
  hardRulesUnsetText,
  hudColumnOf,
  type LoopAction,
  type LoopReviewFacts,
  type LoopSnapshot,
  localNotDeletedText,
  MERGE_STEP_WORDS,
  type MergeStep,
  MINOR_CLEARED,
  MINOR_POSTED,
  mainConflictText,
  mergedMainText,
  mergedText,
  mergeStepFailedText,
  minorNotPostedText,
  modeOfSeat,
  NEW_LOOP,
  parkedEventText,
  REFUSAL_TRIES,
  type RepoId,
  type RepoRules,
  type ReviewFact,
  type ReviewRow,
  type Run,
  type RunLoop,
  readyMarkedText,
  reconcile,
  reviewCarriedText,
  reviewDroppedText,
  reviewEventKey,
  reviewFailedText,
  reviewFor,
  reviewQueuedText,
  reviewRunStep,
  reviewStartedText,
  reviewStatusOf,
  seatCallSign,
  seatDef,
  TAKE_STALE_MS,
  wakeFailedText,
  wokenEventText,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import type { CcConfig, CrewSeatConfig } from "../config.ts";
import type { Move, MoveResult } from "../github-board.ts";
import { issueOf } from "../mcp/tools.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { wakeDueAsideRun } from "./aside.ts";
import {
  CI_LOG_UNREADABLE,
  EMPTY_LOG,
  MERGE_HEAD_MOVED,
  NO_FAILED_RUN,
  type Publisher,
} from "./publish.ts";
import { accountAtStop, isTransientStart, seatMayTake } from "./queue.ts";
import type { RepoRulesError } from "./rules.ts";

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
  /** Asks for a GitHub poll now (after a merge, so the boards show it before the next one). */
  pollGithub?: () => void;
  /** A repo's board rules (read at origin/HEAD); an error is a note in `status()`. */
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
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
   * `opts.kinds` limits the park kinds that may be lifted, checked when the run's turn comes; FLIGHT
   * never lifts a budget park. Resolves true only when it un-parked the run.
   */
  onOperatorMessage(
    runId: string,
    by?: "CAPCOM" | "FLIGHT",
    opts?: { kinds?: readonly string[] },
  ): Promise<boolean>;
  status(): { on: boolean; note: string | null };
  /** How many CI excerpts are held for a busy seat (a test seam). */
  excerptsHeld(): number;
}

/** onChain key for superviseReviews (never a run id). */
const REVIEWS_CHAIN = "\0reviews";

/**
 * The review seat for a seat's runs: the first review-loop seat (config order) of its crew session
 * that is not retiring; null when there is none (the operator reviews). With a `role` (the run's
 * profile names one), the first such seat of that role is preferred.
 */
export function reviewerOf(config: CcConfig, seatId: string, role?: string): CrewSeatConfig | null {
  const session = (config.crew?.sessions ?? []).find((s) => s.seats.some((x) => x.id === seatId));
  const seats = (session?.seats ?? []).filter((x) => !x.retiring && seatDef(x).loop === "review");
  return seats.find((x) => x.role === role) ?? seats[0] ?? null;
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

export function createEngine(deps: EngineDeps): Engine {
  const { config, store, bus, supervisor, publisher } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`engine: ${line}\n`));
  const chains = new Map<string, Promise<void>>();
  const ruleNotes = new Map<RepoId, string>();
  /** Whether each repo's rules set `hard_rules` at their last good read. */
  const hardRulesSet = new Map<RepoId, boolean>();
  /** When each run last had a transient refusal counted: one counts per tick, however often it is tried. */
  const lastTransient = new Map<string, number>();
  /** Transient refusals of each run's local branch delete, and when the last was counted (in memory: a restart tries afresh). */
  const localTries = new Map<string, { n: number; at: number }>();
  /** A CI failure's excerpt, kept until its line is claimed, so a busy seat costs one gh read. */
  const excerpts = new Map<string, string>();
  /** Transient refusals of each review's PR-body edit (in memory: a restart tries afresh). */
  const bodyTries = new Map<number, number>();
  /** The mc/review status last set for each run, as `<sha>:<state>:<description>` (in memory: a restart sets it once more). */
  const reviewStatuses = new Map<string, string>();
  /** The last failure logged for each run's review status, so a lasting failure is logged once. */
  const reviewStatusFailures = new Map<string, string>();
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

  /** The run's PR: the stored number, else the PR on its branch opened since the run began. */
  function findPr(run: Run, loop: RunLoop): ReturnType<Store["pullRequests"]>[number] | null {
    const prs = store.pullRequests(run.repoId);
    if (loop.prNumber !== null) return prs.find((p) => p.number === loop.prNumber) ?? null;
    if (run.branch === null) return null;
    return (
      prs
        .filter((p) => p.branch === run.branch && p.createdAt >= run.startedAt)
        .sort((a, b) => b.number - a.number)[0] ?? null
    );
  }

  async function rulesFor(repoId: RepoId): Promise<RepoRules | null> {
    const r = await deps.rules(repoId);
    if (r instanceof Error) {
      ruleNotes.set(repoId, r.message);
      hardRulesSet.delete(repoId);
      return null;
    }
    ruleNotes.delete(repoId);
    hardRulesSet.set(repoId, r.hardRulesSet);
    // kept for Needs you, which says who a hard-rule flag waits on without reading the rules
    const bySetting = hardRulesBySettingKey(repoId);
    if (store.getSetting(bySetting) !== r.hardRulesBy) {
      store.setSetting(bySetting, r.hardRulesBy);
      bus.emit("attention");
    }
    noteHardRules(repoId, r.hardRulesSet);
    return r;
  }

  /** The one note for a `merge` repo whose rules leave `hard_rules` unset; cleared once they set it. */
  function noteHardRules(repoId: RepoId, set: boolean): void {
    if (config.repos.find((r) => r.id === repoId)?.autonomy !== "merge") return;
    const key = hardRulesUnsetNoteKey(repoId);
    const open = store.notes().some((n) => n.key === key);
    if (set && open) {
      store.clearNote(key, now());
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
      bus.emit("attention");
    }
  }

  function saveLoop(runId: string, loop: RunLoop, stored: RunLoop | null | undefined): void {
    if (JSON.stringify(loop) === JSON.stringify(stored)) return;
    store.setRunLoop(runId, loop);
    bus.emit("agents");
  }

  /**
   * Whether the hub may merge in the repo: a `merge` workspace whose rules set `hard_rules`. The
   * last read of the rules answers (the tick and the pass's other reads keep it fresh), so a pass
   * awaits only for a repo not read yet. Unreadable rules are not an answer: no merge.
   */
  function mayMerge(repoId: RepoId): boolean | Promise<boolean> {
    if (config.repos.find((r) => r.id === repoId)?.autonomy !== "merge") return false;
    const known = hardRulesSet.get(repoId);
    if (known !== undefined) return known;
    return rulesFor(repoId).then(() => hardRulesSet.get(repoId) === true);
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
    const item = store.board(run.repoId).find((b) => b.issueNumber === issue);
    const pushed = store.runPush(run.id);
    const turnEnded = row?.lastTurnEndedAt ?? null;
    const reviewer = reviewerOf(config, run.agentId, reviewRoleOf(run));
    let review: LoopReviewFacts | null = null;
    if (reviewer !== null) {
      const rows = store.reviewsOfRun(run.id).map(reviewFact);
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
        inTurn: !current || facts === null ? true : facts.inTurn,
        lastTurnEndedAt:
          current && turnEnded !== null && turnEnded >= run.startedAt ? turnEnded : null,
        resumedAt: current ? (facts?.resumedAt ?? null) : null,
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
            },
      autoMerge: config.repos.find((r) => r.id === run.repoId)?.autonomy === "merge",
      hardRulesSet: mergeAllowed,
      card: item === undefined ? null : hudColumnOf(item),
      claimed: store.claimedKeys(run.id),
      openNotes: store.openNoteKeys(run.id),
      lastEngineLineAt: store.lastEngineLineAt(run.id),
      tokens: run.tokens === null ? 0 : run.tokens.input + run.tokens.output,
      budget: config.crew?.runTokenBudget ?? Number.MAX_SAFE_INTEGER,
      ended: ended ? { reason: endReason(run) } : null,
      review,
      asideOk: reviewer !== null,
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

  /** The actions only a `merge` workspace takes, whatever the loop planned. */
  const MERGE_STEP_KINDS: ReadonlySet<string> = new Set([
    "mark-ready",
    "merge",
    "close-issue",
    "delete-remote-branch",
    "delete-local-branch",
    "update-branch",
  ]);

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
     * step (`step`) parks it as `merge-step`, after the same count of transient ones.
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
        if (step === undefined || cur.transient < REFUSAL_TRIES) {
          if (cur.transient >= REFUSAL_TRIES) out.again = true;
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
    if (MERGE_STEP_KINDS.has(a.kind) && repo?.autonomy !== "merge") return;
    switch (a.kind) {
      case "push": {
        const r = await publisher.push(run);
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
        const sent = await supervisor.send(run.id, a.key, a.text);
        if (sent === "sent" && a.key.startsWith("fix:")) {
          const id = Number(a.key.slice(a.key.lastIndexOf(":") + 1));
          const rv = store.review(id);
          if (rv !== null) {
            store.addLoopEvent(
              reviewEventKey(run.id, id, "fix"),
              run.id,
              fixSentText(rv.blocking, seatCallSign(run.agentId)),
              at,
            );
            handOff(rv.seatId, a.text);
          }
        }
        if (sent === "sent" && a.key.startsWith("conflict:")) handOff(COMMS_MC, a.text);
        return;
      }
      case "ci-excerpt": {
        const held = excerpts.get(a.key);
        const excerpt = held ?? (await publisher.ciExcerpt(repo?.github ?? "", a.sha));
        // only a real excerpt is kept: a failed read or an empty answer is asked for again
        if (!NOT_EXCERPTS.includes(excerpt)) excerpts.set(a.key, excerpt);
        const text = fillLoopText(CI_FAILED_TEXT, { sha7: a.sha.slice(0, 7) }) + excerpt;
        const sent = await supervisor.send(run.id, a.key, text);
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
        // stamped once gh has answered: a poll taken during the call still shows the old failure
        if (cur.rerun?.sha === a.sha) {
          cur.rerun.runs = runs ?? [];
          cur.rerun.at = now();
        }
        store.addLoopEvent(
          `${run.id}:rerun:${a.sha}`,
          run.id,
          runs === null || runs.length === 0
            ? `CI failed on ${a.sha.slice(0, 7)}; no run could be re-run`
            : `CI failed on ${a.sha.slice(0, 7)}; re-ran ${runs.map((r) => r.name).join(", ")}`,
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
        store.clearNote(a.key, at);
        bus.emit("attention");
        return;
      case "end-run":
        await supervisor.endRunByEngine(run.id);
        return;
      case "take-next": {
        // not while the seat holds another run (a merged PR found after the run was stopped)
        const holds = supervisor.seat(run.agentId)?.runId ?? null;
        if (holds === null || holds === run.id) await deps.takeNext(run.agentId);
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
        const reviewer = reviewerOf(config, run.agentId, reviewRoleOf(run));
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
        await endReviewRun(row);
        await kickReviews();
        return;
      }
      case "set-aside": {
        const worktree = supervisor.seat(run.agentId)?.worktree ?? null;
        if (worktree === null) return;
        // stored before the call: a restart in between finds the run on its seat, which clears it
        cur.aside = { worktree, wake: false };
        store.setRunLoop(run.id, cur);
        const r = await supervisor.setAside(run.id);
        if (r === null) {
          cur.aside = null;
          return;
        }
        const sha = store.runPush(run.id)?.sha ?? "";
        store.addLoopEvent(
          `${run.id}:${cur.epoch}:aside:${sha}`,
          run.id,
          asideEventText(seatCallSign(run.agentId)),
          at,
        );
        kickAside(run.agentId, run.id);
        // the freed seat takes its next ticket now, unless rework is due back on it first
        if (wakeDueAsideRun(store, run.agentId) === undefined) {
          deps.takeNext(run.agentId).catch((e: unknown) => {
            log(
              `${run.agentId}: take after set-aside failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        }
        return;
      }
      case "wake": {
        const accountId = seatConfig(run.agentId)?.accountId;
        if (accountId !== undefined && accountAtStop(config, store, accountId, at)) return;
        const oldest = wakeDueAsideRun(store, run.agentId);
        if (oldest !== undefined && oldest.id !== run.id) return;
        try {
          await supervisor.wakeRun(run.id);
        } catch (e) {
          // the seat is busy or the hub is stopping: the next pass tries again
          if (isTransientStart(e)) return;
          const message = e instanceof Error ? e.message : String(e);
          // (the supervisor ended the run: the next pass parks it ended)
          store.addLoopEvent(
            `${run.id}:wake-failed:${at}`,
            run.id,
            wakeFailedText(message.slice(0, 300)),
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
        // the run's own worktree: the aside run's, or its seat's while the seat holds it
        const seatRow = supervisor.seat(run.agentId);
        const worktree =
          cur.aside?.worktree ?? (seatRow?.runId === run.id ? seatRow.worktree : null);
        if (worktree === null || worktree === undefined) return;
        const r = await publisher.updateBranch(live(), a.mainSha, worktree);
        if (!r.ok) return refused(r);
        if (r.kind === "wait") return;
        cur.transient = 0;
        cur.lastRefusal = null;
        lastTransient.delete(run.id);
        out.again = true;
        if (r.kind === "merged") {
          // as a report moves the run to ci: the new commit is pushed, then judged afresh
          cur.phase = "ci";
          cur.pushFor = r.sha;
          cur.pushStartedAt = at;
          // a chain of merges collapses to the sha that was reviewed
          cur.carry = r.prSame
            ? { from: cur.carry?.to === r.parent ? cur.carry.from : r.parent, to: r.sha }
            : null;
          store.setRunLoop(run.id, cur);
          store.addLoopEvent(`${run.id}:update:${r.sha}`, run.id, mergedMainText(a.mainSha), at);
          const from = carriedFrom(cur.carry, cur.reviewWaivedSha, r.sha);
          if (
            from !== null &&
            reviewFor(store.reviewsOfRun(run.id).map(reviewFact), cur.epoch, r.sha, from) !== null
          ) {
            store.addLoopEvent(
              `${run.id}:carry:${r.sha}`,
              run.id,
              reviewCarriedText(from, r.sha),
              at,
            );
          }
        } else {
          cur.phase = "working";
          cur.mainMerge = { mainSha: a.mainSha, files: r.files };
          store.setRunLoop(run.id, cur);
          store.addLoopEvent(
            `${run.id}:update-conflict:${a.mainSha}`,
            run.id,
            mainConflictText(a.mainSha, r.files.length),
            at,
          );
        }
        return;
      }
      case "mark-ready": {
        const sha = store.runPush(run.id)?.sha;
        if (sha === undefined) return;
        const r = await publisher.markReady(live());
        if (!r.ok) return refused(r, "ready");
        stepDone("ready", sha, readyMarkedText(cur.prNumber));
        return;
      }
      case "merge": {
        const r = await publisher.merge(live(), a.sha);
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
          return refused(r, "merge");
        }
        stepDone("merge", a.sha, mergedText(cur.prNumber));
        deps.pollGithub?.();
        out.again = true;
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
        const reviewer = reviewerOf(config, run.agentId, reviewRoleOf(run));
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
    if (reviewerOf(config, run.agentId, reviewRoleOf(run)) === null) return;
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
    const may = repoId === undefined ? false : mayMerge(repoId);
    // (awaited only when the rules were not read yet: a pass otherwise starts in one turn)
    const mergeAllowed = typeof may === "boolean" ? may : await may;
    const run = store.run(runId);
    const stored = run?.loop;
    if (run === null || stored === undefined || stored === null) return;
    if (!seatKnown(run.agentId)) return;
    const at = now();
    const input: RunLoop = { ...stored };
    const pr = findPr(run, input);
    if (pr !== null && input.prNumber === null) input.prNumber = pr.number;
    const pushed = store.runPush(run.id);
    if (run.endedAt === null && pushed !== null && input.touches?.sha !== pushed.sha) {
      const rules = await rulesFor(run.repoId);
      if (rules !== null) {
        try {
          const paths = await publisher.hardRuleTouches(run, pushed.sha, rules.hardRules);
          input.touches = { sha: pushed.sha, paths };
        } catch (e) {
          log(
            `${runId}: could not read the hard-rule files: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    // in ci, a conflicting PR needs main's sha to merge it in, reviewer or not
    const conflicting = input.phase === "ci" && pr?.mergeable === "CONFLICTING";
    if (
      run.endedAt === null &&
      pushed !== null &&
      (input.phase === "review" || conflicting) &&
      pr?.state === "open" &&
      pr.headSha === pushed.sha &&
      config.repos.find((r) => r.id === run.repoId)?.autonomy === "merge" &&
      (conflicting || reviewerOf(config, run.agentId, reviewRoleOf(run)) !== null)
    ) {
      // origin's tip is read every pass; the other reads only when the sha or the tip changed
      const known = input.gate?.sha === pushed.sha ? input.gate : null;
      const g = await publisher.gateFacts(run, pushed.sha, known);
      if (g.ok) input.gate = { sha: pushed.sha, ...g.facts };
      else log(`${runId}: could not read the merge gate: ${g.text}`);
    }
    const snap = snapshot(run, input, at, mergeAllowed);
    if (snap === null) {
      // a run the loop cannot read is never woken: a stale flag must not hold up a younger rework
      if (input.aside?.wake) {
        input.aside = { ...input.aside, wake: false };
        saveLoop(runId, input, stored);
      }
      return;
    }
    const step = reconcile(snap);
    const cur = step.loop;
    const planned = { phase: cur.phase, epoch: cur.epoch };
    // a new commit in ci is a new push: its refusals are counted afresh
    if (cur.pushFor !== stored.pushFor) lastTransient.delete(run.id);
    // a run's held excerpts are for its current failure only, and none once it has ended
    for (const key of [...excerpts.keys()]) {
      if (!key.startsWith(`ci:${run.id}:`)) continue;
      const current = key === `ci:${run.id}:${cur.ciFailedSha}`;
      // (in ci, a new report is in flight: the line about the old failure is moot)
      if (run.endedAt !== null || cur.phase === "ci" || !current) excerpts.delete(key);
    }
    saveLoop(runId, cur, stored);
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
    saveLoop(runId, cur, store.run(runId)?.loop);
    await syncReviewStatus(runId);
    if (out.again && round + 1 < MAX_ROUNDS) await pass(runId, round + 1);
  }

  const reconcileRun = (runId: string): Promise<void> => {
    if (!live()) return Promise.resolve();
    return onChain(runId, () => pass(runId));
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

  async function sweepNotes(): Promise<void> {
    const at = now();
    for (const n of store.notes()) {
      const run = n.runId === null ? null : store.run(n.runId);
      if (run === null || run.endedAt === null) continue;
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
        .filter((s) => !s.retiring && seatDef(s).loop === "build")
        .filter((s) => seatMayTake(store, s.id))
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
  async function endReviewRun(row: ReviewRow): Promise<void> {
    if (row.runId === null) return;
    if (store.run(row.runId)?.endedAt === null) await supervisor.endRunByEngine(row.runId);
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

  /** Keeps the running reviews going, ends the finished ones' runs and starts the queued ones. */
  async function superviseReviews(): Promise<void> {
    if (!live()) return;
    // 1. the health of each running review
    for (const row of store.reviewsIn(["running"])) {
      if (row.runId === null) continue;
      const rrun = store.run(row.runId);
      if (rrun === null) continue;
      const author = store.run(row.authorRunId);
      const phase = author?.loop?.phase;
      if (author === null || author.endedAt !== null || phase === "done" || phase === "parked") {
        dropReview(row);
        await endReviewRun(row);
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
        startedAt: row.startedAt ?? row.createdAt,
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
          inTurn: holdsRun && facts !== null ? facts.inTurn : true,
          lastTurnEndedAt:
            holdsRun && turnEnded !== null && turnEnded >= rrun.startedAt ? turnEnded : null,
          resumedAt: holdsRun ? (facts?.resumedAt ?? null) : null,
          rateLimitedUntil: holdsRun ? (facts?.rateLimitedUntil ?? null) : null,
        },
        claimed: store.claimedKeys(rrun.id),
        lastEngineLineAt: store.lastEngineLineAt(rrun.id),
      });
      if (action === null) continue;
      if (action.kind === "send") {
        await supervisor.send(rrun.id, action.key, action.text);
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
      if (
        author === null ||
        row.seatId === reviewerOf(config, author.agentId, reviewRoleOf(author))?.id
      )
        continue;
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
    // 4. each free scratch seat starts its oldest wanted review
    const scratch = (config.crew?.sessions ?? [])
      .flatMap((s) => s.seats)
      .filter((x) => !x.retiring && modeOfSeat(x) === "scratch");
    for (const seat of scratch) {
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
        // an earlier start awaited: the seat may have been removed or retired since the list was taken
        const current = (config.crew?.sessions ?? [])
          .flatMap((x) => x.seats)
          .find((x) => x.id === seat.id);
        if (current === undefined || current.retiring) break;
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
            const failure = message.slice(0, 300);
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

  function kickReviews(): Promise<void> {
    if (!live()) return Promise.resolve();
    return onChain(REVIEWS_CHAIN, superviseReviews);
  }

  async function refreshRuleNotes(runs: Run[]): Promise<void> {
    for (const repoId of new Set(runs.map((r) => r.repoId))) await rulesFor(repoId);
  }

  return {
    start() {
      if (!deps.enabled || started) return;
      started = true;
      unsubscribe = supervisor.on((e) => {
        if (e.kind === "run-ended") kickAside(e.seatId);
        const rv = store.reviewOfRun(e.runId);
        if (rv !== null) {
          if (e.kind === "findings") {
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
      const runs = loopRuns();
      await Promise.all(runs.map((r) => reconcileRun(r.id)));
      await refreshRuleNotes(runs);
      await sweepNotes();
      untakeStale();
      await takeForSeats();
      await kickReviews();
    },

    reconcileRun,

    async reconcileRepo(repoId) {
      if (!live()) return;
      const runs = loopRuns().filter((r) => r.repoId === repoId && r.endedAt === null);
      await Promise.all(runs.map((r) => reconcileRun(r.id)));
    },

    onOperatorMessage(runId, by = "CAPCOM", opts) {
      if (!live()) return Promise.resolve(false);
      let lifted = false;
      return onChain(runId, async () => {
        const run = store.run(runId);
        const loop = run?.loop;
        if (run === null || loop === undefined || loop === null) return;
        const kind = loop.parked?.kind;
        if (
          run.endedAt !== null ||
          loop.phase !== "parked" ||
          loop.parked === null ||
          loop.parked.ended ||
          kind === "pr-closed" ||
          (by === "FLIGHT" && kind === "budget") ||
          (opts?.kinds !== undefined && (kind === undefined || !opts.kinds.includes(kind)))
        ) {
          return;
        }
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
          next.phase = "review";
          next.reviewWaivedSha = store.runPush(run.id)?.sha ?? null;
        } else if (kind === "ruling" || kind === "review-failed") {
          next.phase = "review";
        } else if (head !== null && pushed?.sha === head && pr?.state === "open") {
          // re-judged on the next pass; its clocks run from now
          next.phase = "ci";
          next.pushStartedAt = at;
          next.pushFor = head;
        } else {
          next.phase = "working";
        }
        store.setRunLoop(run.id, next);
        lastTransient.delete(run.id);
        store.addLoopEvent(`${run.id}:resumed:${next.epoch}`, run.id, `resumed by ${by}`, at);
        bus.emit("agents");
        lifted = true;
        await pass(run.id);
      }).then(() => lifted);
    },

    excerptsHeld: () => excerpts.size,

    status() {
      const notes = [...ruleNotes.values()];
      return { on: live(), note: notes.length === 0 ? null : notes.join("; ") };
    },
  };
}
