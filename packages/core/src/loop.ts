/** The first loop's texts: what a seat is told when `mc report_evidence` is taken or refused. */
import { clockHm } from "./hud.ts";
import { COMMIT_PATHS_NAMED, REFERENCE_ADVICE } from "./mcp.ts";
import type { MoveColumn } from "./repos.ts";
import {
  currentReview,
  failedAttempts,
  fixesSent,
  fixKey,
  fixText,
  headMovedNoteKey,
  headMovedText,
  type LoopReviewFacts,
  nextAttempt,
  REVIEW_ATTEMPTS,
  REVIEW_ROUNDS,
  readyHardRuleText,
  readyNoteKey,
  readyRuledText,
  readyText,
  readyWaivedText,
  reviewFailedParkText,
  reviewParkText,
  reviewRulingParkText,
} from "./review.ts";
import type { SeatState } from "./runtime.ts";
import type { MergeStep, RunLoop } from "./types.ts";

/** The run has no loop state: Mission Control is not driving it. */
export const EVIDENCE_NO_LOOP =
  "Not recorded: Mission Control is not driving this run, so there is no one to report to.";
/** The run's loop is parked, waiting on the operator. */
export const EVIDENCE_PARKED =
  "Not recorded: this run is parked and waiting on the operator; Mission Control will message you when it resumes.";
/** The last push is in CI. */
export const EVIDENCE_IN_CI =
  "CI is running on your last push; Mission Control will message you the result.";
/** The worktree holds changes no commit has. */
export const evidenceUncommittedText = (paths: readonly string[]): string => {
  const shown = paths.slice(0, COMMIT_PATHS_NAMED).join(", ");
  const more =
    paths.length > COMMIT_PATHS_NAMED ? ` and ${paths.length - COMMIT_PATHS_NAMED} more` : "";
  return `Not recorded: uncommitted changes in ${shown}${more}. Commit them with mc commit, then report again.`;
};
/** No commit since the last report, or the newest commit is the one CI failed on. */
export const EVIDENCE_NO_COMMIT =
  "Not recorded: there is no new commit since your last report (or CI already failed on your newest one). Commit your change with mc commit, then report again. A note that starts with Ruling: needs no commit.";
/** The note would notify or reference something on GitHub, or holds a secret (`what` says which). */
export const evidenceTextText = (what: string): string =>
  `Not recorded: the note is posted to GitHub and must not notify anyone, reference another item or hold a secret (${what}); reword it, then report again. ${REFERENCE_ADVICE}`;
/** The note is stored. */
export const EVIDENCE_RECORDED =
  "Recorded. Mission Control is pushing and will message you when CI has run.";
/** A note starting with this reports a ruling, not a change: it needs no new commit. */
export const EVIDENCE_RULING_PREFIX = "Ruling:";

/** A failed CI run is retried this many times before the run parks. */
export const CI_TRIES = 3;
/** The push or PR is refused this many times before the run parks. */
export const REFUSAL_TRIES = 3;
/** CI may stay pending this long on a pushed sha. */
export const CI_PENDING_MAX_MS = 30 * 60_000;
/** The push, the PR or the first CI report is waited for this long. */
export const NO_CI_AFTER_MS = 10 * 60_000;

/** The engine reconciles every looped run this often. */
export const ENGINE_TICK_MS = 60_000;
/** Seats' queues are refilled to this many issues. */
export const QUEUE_DEPTH = 3;
/** A queue row taken this long ago whose run never began is given back. */
export const TAKE_STALE_MS = 5 * 60_000;
/** A CI failure's excerpt is the last this many lines of the failed log, cut to this many bytes. */
export const CI_EXCERPT_LINES = 80;
export const CI_EXCERPT_MAX = 8192;

/** With no reset time, a rate-limited seat is tried once per this long. */
export const RATE_LIMIT_RETRY_MS = 3_600_000;

/** The `cardFor` mark of a phase and epoch: the card move for it is done. */
export const cardMark = (phase: string, epoch: number): string => `${phase}:${epoch}`;
/** The key of a run's blocked note for one epoch. */
export const blockedNoteKey = (runId: string, epoch: number): string => `blocked:${runId}:${epoch}`;

/** `{sha7}` is the first 7 characters of the failed sha; the excerpt follows. */
export const CI_FAILED_TEXT = `CI failed on {sha7}. Fix it, commit, and call mc report_evidence again. If it is a flaky test that is not yours, report with a note starting "${EVIDENCE_RULING_PREFIX}" and say why; the operator will decide. The failing output:\n`;
export const NO_NEW_COMMIT_TEXT = `No new commit since CI failed on {sha7}. Fix it and commit first, then report; or report with a note starting "${EVIDENCE_RULING_PREFIX}" if the failure is not yours.`;
/** How a failed merge step is named in the park reason; the server parks it with kind `merge-step`. */
export const MERGE_STEP_WORDS = {
  ready: "mark ready",
  merge: "merge",
  close: "close the issue",
  "delete-remote": "delete the remote branch",
} as const;
export const mergeStepFailedText = (step: string, why: string): string => `${step} failed: ${why}`;
/** The gate parks a run for these; the reason says which. */
export const gateStrayParkText = (call: string, paths: readonly string[]): string =>
  `changes outside ${call}'s area: ${paths.join(", ")}`;
export const GATE_FOREIGN_COMMITS_PARK = "commits on the branch that Mission Control did not make";
/** The flag note while a merge-ready PR is behind main. */
export const behindNoteKey = (runId: string, sha: string): string => `behind:${runId}:${sha}`;
export const behindMainText = (ref: string, pr: number, mainSha: string): string =>
  `${ref}: PR #${pr} is behind main (${mainSha.slice(0, 7)}), so Mission Control has not merged it; it merges once the branch contains main`;
/** The Activity row for a park. */
export const parkedEventText = (reason: string): string => `parked: ${reason}`;
export const RESUME_TEXT =
  "Carry on with {ref}: Mission Control restarted, or your rate limit has reset. When the work is committed, call mc report_evidence.";
export const NUDGE_TEXT =
  "No report yet for {ref}. When the work is committed, call mc report_evidence with a note; if you are blocked, say why.";

/** Fills `{name}` placeholders of a loop text; an unknown name is left as written. */
export const fillLoopText = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);

/** The HUD's line for each loop phase (`loopText`). */
export const LOOP_TEXT_WORKING = "Working on {ref}";
export const LOOP_TEXT_CI = "CI on {sha7}";
/** CI with no pushed sha recorded. */
export const LOOP_TEXT_CI_REF = "CI on {ref}";
export const LOOP_TEXT_REVIEW_PR = "In review · PR #{n}";
export const LOOP_TEXT_REVIEW = "In review";
export const LOOP_TEXT_PARKED = "Blocked: {reason}";
export const LOOP_TEXT_DONE_PR = "Done · PR #{n}";
export const LOOP_TEXT_DONE = "Done";
/** `ref` of a run with no ticket. */
export const LOOP_NO_TICKET_REF = "the ticket";

/** What a crew row says about a looped run's step; `ref` is the row's ticket, or null. */
export const loopText = (ref: string | null, loop: RunLoop): string => {
  const at = ref ?? LOOP_NO_TICKET_REF;
  switch (loop.phase) {
    case "working":
      return fillLoopText(LOOP_TEXT_WORKING, { ref: at });
    case "ci":
      return loop.pushFor === null
        ? fillLoopText(LOOP_TEXT_CI_REF, { ref: at })
        : fillLoopText(LOOP_TEXT_CI, { sha7: loop.pushFor.slice(0, 7) });
    case "review":
      return loop.prNumber === null
        ? LOOP_TEXT_REVIEW
        : fillLoopText(LOOP_TEXT_REVIEW_PR, { n: String(loop.prNumber) });
    case "parked":
      return fillLoopText(LOOP_TEXT_PARKED, { reason: loop.parked?.reason ?? "" });
    case "done":
      return loop.prNumber === null
        ? LOOP_TEXT_DONE
        : fillLoopText(LOOP_TEXT_DONE_PR, { n: String(loop.prNumber) });
  }
};

/** A run's loop before anything has happened. */
export const NEW_LOOP: RunLoop = {
  phase: "working",
  reportedEvidenceId: 0,
  prNumber: null,
  pushStartedAt: null,
  pushFor: null,
  unparkedAt: null,
  ciFails: 0,
  ciFailedSha: null,
  relayedSha: null,
  transient: 0,
  lastRefusal: null,
  epoch: 0,
  budgetExtra: 0,
  parked: null,
  touches: null,
  cardFor: null,
  reviewWaivedSha: null,
  prBody: null,
  aside: null,
};

/** A run in review leaves its seat when the session has a review seat. */
export const asideEventText = (call: string): string =>
  `in review; ${call} is free for its next ticket`;
export const wokenEventText = (call: string): string => `back to ${call} for rework`;
export const wakeFailedText = (reason: string): string =>
  `could not go back to its seat: ${reason}`;
export const reworkFirstText = (call: string, ref: string): string =>
  `${call} has rework waiting on ${ref}; that goes first`;
export const ticketInReviewText = (ref: string): string =>
  `${ref} is in review; it comes back to its seat when it needs rework`;
export const NOT_ASIDE = "the run is not waiting on its review";

/** One run's facts, read by the caller; `reconcile` reads no clock and does no I/O. */
export interface LoopSnapshot {
  runId: string;
  runStartedAt: number;
  loop: RunLoop;
  ticket: { ref: string; title: string; issue: number };
  now: number;
  /** The operator's IANA time zone, for the rate-limit reset time; null leaves the time out. */
  tz: string | null;
  hubStartedAt: number;
  seat: {
    call: string;
    state: SeatState;
    inTurn: boolean;
    lastTurnEndedAt: number | null;
    resumedAt: number | null;
    rateLimitedUntil: number | null;
    openQuestion: boolean;
    /** The seat row holds this unended run. */
    holdsRun: boolean;
  };
  /** The run's session has a review seat, so the run may leave its seat in review. */
  asideOk: boolean;
  /** The latest evidence. */
  evidence: { id: number; at: number; ruling: boolean } | null;
  evidenceCount: number;
  /** The newest run_commits sha. */
  headCommit: string | null;
  /** From run_pushes. */
  pushed: { sha: string; at: number } | null;
  pr: {
    number: number;
    state: "open" | "merged" | "closed";
    headSha: string | null;
    ci: "passing" | "failing" | "pending" | null;
    mergeable: string | null;
    polledAt: number;
    isDraft?: boolean;
  } | null;
  /** The repo is a `merge` workspace: the engine merges a PR that passes the gate. Absent: false. */
  autoMerge?: boolean;
  /** The card's column from the poll. */
  card: string | null;
  /** This run's seat_lines keys, with the time each was claimed. */
  claimed: Record<string, number>;
  /** This run's uncleared note keys. */
  openNotes: string[];
  lastEngineLineAt: number | null;
  tokens: number;
  budget: number;
  ended: { reason: string } | null;
  /** null or absent: no reviewer for this run's session (7a behaviour). */
  review?: LoopReviewFacts | null;
}

/** The Needs-you kinds the loop raises as notes. */
export type LoopNoteKind = "blocked" | "flag" | "review" | "ready" | "ratelimit";

export type LoopAction =
  | { kind: "push" }
  | { kind: "open-pr" }
  | { kind: "send"; key: string; text: string }
  | { kind: "ci-excerpt"; key: string; sha: string }
  | { kind: "move-card"; column: MoveColumn }
  | { kind: "note"; key: string; noteKind: LoopNoteKind; text: string }
  | { kind: "clear-note"; key: string }
  | { kind: "end-run" }
  | { kind: "take-next" }
  | { kind: "event"; text: string }
  | { kind: "request-review"; sha: string; attempt: number }
  | { kind: "supersede-review"; reviewId: number }
  | { kind: "pr-body"; reviewId: number }
  | { kind: "set-aside" }
  | { kind: "wake" }
  | { kind: "mark-ready" }
  | { kind: "merge"; sha: string }
  | { kind: "close-issue" }
  | { kind: "delete-remote-branch"; sha: string }
  | { kind: "delete-local-branch" };

interface Step {
  loop: RunLoop;
  actions: LoopAction[];
}

const sha7 = (sha: string): string => sha.slice(0, 7);

/** ` for <sha7>` for a text about a sha, or nothing when there is none. */
const forSha = (sha: string | null | undefined): string =>
  sha === null || sha === undefined ? "" : ` for ${sha7(sha)}`;

const minutes = (ms: number): number => Math.round(ms / 60_000);

const IN_PROGRESS = "In progress" satisfies MoveColumn;
const IN_REVIEW = "In review" satisfies MoveColumn;
const BLOCKED = "Blocked" satisfies MoveColumn;

/** ` until HH:MM` in the operator's zone; nothing without a zone or for a time that has no clock. */
function untilText(at: number | null, tz: string | null): string {
  if (at === null || tz === null) return "";
  try {
    return ` until ${clockHm(at, tz)}`;
  } catch {
    return "";
  }
}

const park = (loop: RunLoop, kind: string, reason: string): Step => ({
  loop: { ...loop, phase: "parked", parked: { kind, reason, ended: false } },
  actions: [{ kind: "event", text: parkedEventText(reason) }],
});

const unchanged = (loop: RunLoop): Step => ({ loop, actions: [] });

const nudgeKey = (s: LoopSnapshot): string => `nudge:${s.runId}:${s.loop.epoch}:${s.evidenceCount}`;

/** Working, or in review with a fix committed but not yet reported: the seat owes a report. */
const owesReport = (s: LoopSnapshot): boolean => {
  if (s.loop.phase === "working") return true;
  if (s.loop.phase !== "review") return false;
  if (s.headCommit !== (s.pushed?.sha ?? null)) return true;
  // the fix line for the current review was sent: the author owes a report
  const rv = reviewView(s, s.loop);
  return rv.blocked && rv.cur !== null && fixKey(s.runId, s.loop.epoch, rv.cur.id) in s.claimed;
};

/** What the review facts say about the pushed sha under `loop`; `on`: a review decides this pass. */
function reviewView(s: LoopSnapshot, loop: RunLoop) {
  const R = s.review ?? null;
  const P = s.pushed?.sha ?? null;
  const cur = R !== null && P !== null ? currentReview(R.rows, loop.epoch, P) : null;
  const waived = P !== null && (loop.reviewWaivedSha ?? null) === P;
  const on =
    R !== null &&
    P !== null &&
    loop.phase === "review" &&
    s.ended === null &&
    s.pr?.state === "open" &&
    s.pr.headSha === P &&
    !waived;
  const blocked = cur !== null && cur.state === "reported" && cur.blocking > 0;
  return { R, P, cur, waived, on, blocked };
}

/**
 * The merge gate's facts for the pushed sha in a `merge` workspace. `on`: the review, CI and head
 * facts hold, so the engine's reads (`gate`, `touches`) decide; each is null when missing or for
 * another sha.
 */
function gateView(s: LoopSnapshot, loop: RunLoop) {
  const rv = reviewView(s, loop);
  const P = rv.P;
  const on =
    s.autoMerge === true &&
    rv.R !== null &&
    P !== null &&
    loop.phase === "review" &&
    s.ended === null &&
    s.pr?.state === "open" &&
    s.pr.headSha === P &&
    s.headCommit === P &&
    s.pr.ci === "passing" &&
    loop.ciFailedSha !== P &&
    !rv.waived &&
    rv.cur !== null &&
    rv.cur.state === "reported" &&
    rv.cur.blocking === 0;
  const touches = P !== null && loop.touches?.sha === P ? loop.touches : null;
  const gate = P !== null && loop.gate?.sha === P ? loop.gate : null;
  const clear = touches !== null && touches.paths.length === 0;
  const passes =
    on && clear && gate?.containsMain === true && gate.hubOnly && gate.strays.length === 0;
  return { on, P, touches, gate, clear, passes };
}

/** The steps after a merge, in order, minus those already done. */
function afterMerge(s: LoopSnapshot): LoopAction[] {
  const done = s.loop.merging?.done ?? [];
  const todo = (step: MergeStep): boolean => !done.includes(step);
  const sha = s.loop.merging?.sha ?? s.pr?.headSha ?? s.pushed?.sha ?? null;
  const actions: LoopAction[] = [];
  if (todo("close")) actions.push({ kind: "close-issue" });
  if (todo("delete-remote") && sha !== null) actions.push({ kind: "delete-remote-branch", sha });
  actions.push({ kind: "end-run" });
  if (todo("delete-local")) actions.push({ kind: "delete-local-branch" });
  actions.push({ kind: "take-next" });
  return actions;
}

/** The state step: the first matching row of the table changes the loop. */
function stateStep(s: LoopSnapshot): Step {
  const { loop, pr, evidence, headCommit, pushed, now, seat } = s;
  const prNumber = pr?.number ?? loop.prNumber;
  const merged = pr?.state === "merged" || (loop.merging?.done ?? []).includes("merge");

  if (merged && loop.phase !== "done") {
    return {
      loop: { ...loop, phase: "done" },
      actions:
        s.autoMerge === true
          ? [...afterMerge(s), { kind: "event", text: "merged" }]
          : [{ kind: "end-run" }, { kind: "take-next" }, { kind: "event", text: "merged" }],
    };
  }
  if (loop.phase === "done") {
    return {
      loop,
      actions: s.autoMerge === true ? afterMerge(s) : [{ kind: "end-run" }, { kind: "take-next" }],
    };
  }
  if (s.ended !== null && !loop.parked?.ended) {
    return {
      loop: {
        ...loop,
        phase: "parked",
        parked: { kind: "ended", reason: `run ended (${s.ended.reason})`, ended: true },
      },
      actions: [],
    };
  }
  if (loop.phase === "parked") return unchanged(loop);
  if (pr?.state === "closed") {
    return park(loop, "pr-closed", `PR #${prNumber} was closed without merging`);
  }

  const rv = reviewView(s, loop);
  const reporting = loop.phase === "working" || loop.phase === "review";
  if (
    loop.phase === "review" &&
    rv.R !== null &&
    rv.P !== null &&
    evidence !== null &&
    evidence.id > loop.reportedEvidenceId &&
    evidence.ruling &&
    headCommit === rv.P &&
    rv.blocked &&
    !rv.waived
  ) {
    return park(
      { ...loop, reportedEvidenceId: evidence.id },
      "review-ruling",
      reviewRulingParkText(seat.call, rv.R.retro, rv.P),
    );
  }
  if (reporting && evidence !== null && evidence.id > loop.reportedEvidenceId) {
    const seen = { ...loop, reportedEvidenceId: evidence.id };
    if (headCommit !== null && headCommit === loop.ciFailedSha) {
      if (evidence.ruling) {
        return park(
          seen,
          "ruling",
          `${seat.call} ruled on the CI failure on ${sha7(headCommit)} instead of fixing it; see its last report`,
        );
      }
      return unchanged({ ...seen, phase: "working" });
    }
    if (headCommit === null) {
      return park(
        seen,
        "nothing",
        `${seat.call} reported, but nothing was committed, so there is nothing to push`,
      );
    }
    return {
      loop: {
        ...seen,
        phase: "ci",
        pushStartedAt: now,
        pushFor: headCommit,
        transient: 0,
        lastRefusal: null,
      },
      actions: [{ kind: "event", text: "reported; pushing" }],
    };
  }

  if (rv.on && rv.R !== null && rv.P !== null && rv.cur !== null) {
    const { R, P, cur } = rv;
    if (cur.state === "failed") {
      const n = failedAttempts(R.rows, loop.epoch, P);
      if (n >= REVIEW_ATTEMPTS) {
        return park(
          loop,
          "review-failed",
          reviewFailedParkText(R.retro, P, n, cur.failure ?? "unknown"),
        );
      }
    } else if (
      rv.blocked &&
      !(fixKey(s.runId, loop.epoch, cur.id) in s.claimed) &&
      fixesSent(s.claimed, s.runId, loop.epoch) + 1 >= REVIEW_ROUNDS
    ) {
      return park(loop, "review", reviewParkText(R.retro, P));
    }
  }

  // A hard-rule touch is the operator's to merge, so the strays it brings are not a park.
  const gv = gateView(s, loop);
  if (gv.on && gv.clear && gv.gate !== null) {
    if (gv.gate.strays.length > 0) {
      return park(loop, "gate", gateStrayParkText(seat.call, gv.gate.strays));
    }
    if (!gv.gate.hubOnly) return park(loop, "gate", GATE_FOREIGN_COMMITS_PARK);
  }

  if (loop.phase === "ci") {
    // A commit made while in ci is a new push: its clock and its refusals start over.
    if (typeof loop.pushFor === "string" && loop.pushFor !== headCommit) {
      return unchanged({
        ...loop,
        pushFor: headCommit,
        pushStartedAt: now,
        transient: 0,
        lastRefusal: null,
      });
    }
    if (loop.transient >= REFUSAL_TRIES) {
      return park(loop, "refused", loop.lastRefusal ?? "the push or PR was refused");
    }
    if (pushed === null || pr === null || pushed.sha !== headCommit || pr.headSha !== pushed.sha) {
      if (loop.pushStartedAt !== null && now - loop.pushStartedAt > NO_CI_AFTER_MS) {
        return park(
          loop,
          "stuck",
          `the push or PR${forSha(headCommit ?? pushed?.sha)} has not shown up on GitHub after ${minutes(NO_CI_AFTER_MS)} minutes${loop.lastRefusal === null ? "" : ` (${loop.lastRefusal})`}`,
        );
      }
      return unchanged(loop);
    }
    const short = sha7(pushed.sha);
    if (pr.mergeable === "CONFLICTING") {
      return park(loop, "conflict", `PR #${pr.number} conflicts with main`);
    }
    if (pr.ci === "passing") {
      return {
        loop: { ...loop, phase: "review", ciFails: 0 },
        actions: [{ kind: "event", text: `CI passed on ${short}` }],
      };
    }
    if (pr.ci === "failing") {
      if (loop.ciFailedSha === pushed.sha) return unchanged({ ...loop, phase: "working" });
      const failed = { ...loop, ciFails: loop.ciFails + 1, ciFailedSha: pushed.sha };
      if (failed.ciFails >= CI_TRIES) {
        return park(failed, "ci", `CI failed ${failed.ciFails} times; last on ${short}`);
      }
      return {
        loop: { ...failed, phase: "working" },
        actions: [{ kind: "event", text: `CI failed on ${short}` }],
      };
    }
    // a run the operator un-parked is judged from the un-park, not from a push made before it
    const since = Math.max(pushed.at, loop.unparkedAt ?? 0);
    if (pr.ci === "pending" && now - since > CI_PENDING_MAX_MS) {
      return park(
        loop,
        "ci-pending",
        `CI pending for ${minutes(CI_PENDING_MAX_MS)} minutes on ${short}`,
      );
    }
    if (pr.ci === null && pr.polledAt - since > NO_CI_AFTER_MS) {
      return park(loop, "no-ci", `no CI reported for ${short}`);
    }
    return unchanged(loop);
  }

  if (loop.phase === "working" && s.tokens > s.budget + loop.budgetExtra) {
    return park(loop, "budget", `over its ${s.budget + loop.budgetExtra}-token budget`);
  }
  if (owesReport(s)) {
    const t = s.claimed[nudgeKey(s)];
    if (
      t !== undefined &&
      seat.state === "idle" &&
      !seat.inTurn &&
      !seat.openQuestion &&
      seat.lastTurnEndedAt !== null &&
      seat.lastTurnEndedAt > t
    ) {
      return park(loop, "silent", "stopped twice without reporting");
    }
  }
  return unchanged(loop);
}

type DesiredNote = { noteKind: LoopNoteKind; text: string };

/** The note keys the loop wants open, with their kind and text. */
function desiredNotes(s: LoopSnapshot, loop: RunLoop): Map<string, DesiredNote> {
  const notes = new Map<string, DesiredNote>();
  const { ticket, runId, pushed, seat } = s;
  if (loop.phase === "parked") {
    notes.set(blockedNoteKey(runId, loop.epoch), {
      noteKind: "blocked",
      text: `${ticket.ref} parked: ${loop.parked?.reason ?? "parked"}`,
    });
  }
  // an ended run keeps only its blocked note: the seat's rate limit belongs to its next run
  if (loop.parked?.ended) return notes;
  const rv = reviewView(s, loop);
  if (rv.R !== null) {
    if (loop.phase === "review" && s.ended === null && rv.P !== null) {
      const n = s.pr?.number ?? loop.prNumber;
      const head = s.pr?.headSha ?? null;
      if (n !== null) {
        if (head !== null && head !== rv.P) {
          notes.set(headMovedNoteKey(runId, head), {
            noteKind: "flag",
            text: headMovedText(ticket.ref, n, head, rv.P),
          });
        } else if (rv.waived) {
          notes.set(readyNoteKey(runId, rv.P), {
            noteKind: "ready",
            text: readyWaivedText(ticket.ref, n, rv.P),
          });
        } else if (rv.cur !== null && rv.cur.state === "reported" && rv.cur.blocking === 0) {
          const gv = gateView(s, loop);
          if (!gv.on) {
            notes.set(readyNoteKey(runId, rv.P), {
              noteKind: "ready",
              text:
                loop.ciFailedSha === rv.P
                  ? readyRuledText(ticket.ref, n, rv.R.retro, rv.P)
                  : readyText(ticket.ref, n, rv.R.retro, rv.P, rv.cur.minor),
            });
          } else if (gv.touches !== null && gv.touches.paths.length > 0) {
            notes.set(readyNoteKey(runId, rv.P), {
              noteKind: "ready",
              text: readyHardRuleText(ticket.ref, n, gv.touches.paths),
            });
          } else if (gv.clear && gv.gate !== null && !gv.gate.containsMain) {
            notes.set(behindNoteKey(runId, rv.P), {
              noteKind: "flag",
              text: behindMainText(ticket.ref, n, gv.gate.mainSha),
            });
          }
          // otherwise the gate passes or its reads are due: the operator has nothing to do
        }
      }
    }
  } else if (loop.phase === "review" && pushed !== null) {
    const n = s.pr?.number ?? loop.prNumber;
    const what = n === null ? "the PR" : `PR #${n}`;
    // reached from a ruling on the sha CI failed on: CI did not pass on it
    const ruled = loop.ciFailedSha === pushed.sha;
    notes.set(`review:${runId}:${pushed.sha}`, {
      noteKind: "review",
      text: ruled
        ? `${ticket.ref}: ${what} needs your review (${seat.call} ruled on the CI failure on ${sha7(pushed.sha)} instead of fixing it)`
        : `${ticket.ref}: ${what} is ready for review (CI passed on ${sha7(pushed.sha)})`,
    });
  }
  if (loop.touches !== null && loop.touches.paths.length > 0) {
    notes.set(`flag:${runId}:hard-rules:${loop.touches.sha}`, {
      noteKind: "flag",
      text: `${ticket.ref} touches hard-rule files: ${loop.touches.paths.join(", ")}`,
    });
  }
  if (seat.state === "parked") {
    notes.set(`ratelimit:${runId}`, {
      noteKind: "ratelimit",
      text: `${seat.call} is rate-limited${untilText(seat.rateLimitedUntil, s.tz)}`,
    });
  }
  return notes;
}

/** Whether a review's blocking findings are due to the author as a fix line under `loop`. */
export function fixDue(s: LoopSnapshot, loop: RunLoop): boolean {
  const rv = reviewView(s, loop);
  return (
    rv.on &&
    rv.R !== null &&
    rv.P !== null &&
    rv.cur !== null &&
    rv.blocked &&
    !(fixKey(s.runId, loop.epoch, rv.cur.id) in s.claimed) &&
    fixesSent(s.claimed, s.runId, loop.epoch) + 1 < REVIEW_ROUNDS
  );
}

/** Whether the run in review may leave its seat now. */
function asideDue(s: LoopSnapshot, loop: RunLoop): boolean {
  const { seat, pushed, pr } = s;
  return (
    s.asideOk &&
    !loop.aside &&
    s.ended === null &&
    loop.phase === "review" &&
    seat.holdsRun &&
    seat.state === "idle" &&
    !seat.inTurn &&
    !seat.openQuestion &&
    pushed !== null &&
    s.headCommit === pushed.sha &&
    loop.ciFailedSha !== pushed.sha &&
    pr?.state === "open" &&
    pr.headSha === pushed.sha &&
    !fixDue(s, loop) &&
    !owesReport({ ...s, loop })
  );
}

/** The one line due this pass, if any; the first due one wins. */
function dueLine(s: LoopSnapshot, loop: RunLoop): LoopAction | null {
  const { seat, claimed, runId, ticket } = s;
  if (seat.inTurn) return null;
  const free = (key: string): boolean => !(key in claimed);
  const working = loop.phase === "working";
  const reporting = working || loop.phase === "review";

  const rv = reviewView(s, loop);
  if (fixDue(s, loop) && rv.R !== null && rv.P !== null && rv.cur !== null) {
    return {
      kind: "send",
      key: fixKey(runId, loop.epoch, rv.cur.id),
      text: fixText({ retro: rv.R.retro, sha: rv.P, findings: rv.R.findings }),
    };
  }

  if (working && loop.ciFailedSha !== null && loop.relayedSha !== loop.ciFailedSha) {
    const key = `ci:${runId}:${loop.ciFailedSha}`;
    if (free(key)) return { kind: "ci-excerpt", key, sha: loop.ciFailedSha };
  }

  // A report on the failed sha, made after its excerpt reached the seat, with no commit behind it.
  if (
    working &&
    loop.ciFailedSha !== null &&
    s.headCommit === loop.ciFailedSha &&
    s.evidence !== null &&
    !s.evidence.ruling &&
    s.evidence.id === loop.reportedEvidenceId
  ) {
    const relayedAt = claimed[`ci:${runId}:${loop.ciFailedSha}`];
    const key = `nonew:${runId}:${s.evidence.id}`;
    if (relayedAt !== undefined && s.evidence.at > relayedAt && free(key)) {
      return {
        kind: "send",
        key,
        text: fillLoopText(NO_NEW_COMMIT_TEXT, { sha7: sha7(loop.ciFailedSha) }),
      };
    }
  }

  if (
    reporting &&
    seat.resumedAt !== null &&
    seat.resumedAt >= s.hubStartedAt &&
    (seat.lastTurnEndedAt ?? 0) < seat.resumedAt &&
    !seat.openQuestion
  ) {
    const key = `resume:${runId}:${s.hubStartedAt}`;
    // one "Carry on" is enough: a rate-limit line sent since the resume says the same
    const told = Object.entries(claimed).some(
      ([k, at]) => k.startsWith(`ratelimit:${runId}:`) && at >= (seat.resumedAt ?? 0),
    );
    if (free(key) && !told) {
      return { kind: "send", key, text: fillLoopText(RESUME_TEXT, { ref: ticket.ref }) };
    }
  }

  // Not while the loop is parked: the seat is waiting on the operator, not on a "carry on".
  if (
    seat.state === "parked" &&
    loop.phase !== "parked" &&
    (seat.rateLimitedUntil === null || s.now > seat.rateLimitedUntil)
  ) {
    // With no reset time the try is due one RATE_LIMIT_RETRY_MS after the last "carry on" of
    // any kind (this hub start's resume, or an earlier rate-limit line), never sooner; its key
    // names that time, so each try has its own.
    const prefix = `ratelimit:${runId}:`;
    const tries = [
      claimed[`resume:${runId}:${s.hubStartedAt}`],
      ...Object.entries(claimed).flatMap(([k, at]) => (k.startsWith(prefix) ? [at] : [])),
    ].filter((at): at is number => at !== undefined);
    const lastTry = tries.length === 0 ? null : Math.max(...tries);
    const key =
      seat.rateLimitedUntil === null
        ? `${prefix}after:${lastTry ?? 0}`
        : `${prefix}${seat.rateLimitedUntil}`;
    const waiting =
      seat.rateLimitedUntil === null && lastTry !== null && s.now - lastTry < RATE_LIMIT_RETRY_MS;
    if (free(key) && !waiting) {
      return { kind: "send", key, text: fillLoopText(RESUME_TEXT, { ref: ticket.ref }) };
    }
  }

  const looped = { ...s, loop };
  if (
    owesReport(looped) &&
    seat.state === "idle" &&
    !seat.openQuestion &&
    seat.lastTurnEndedAt !== null &&
    // a turn that ended before the report or an engine line (a resume too) is not a stop
    seat.lastTurnEndedAt > Math.max(s.runStartedAt, s.evidence?.at ?? 0, s.lastEngineLineAt ?? 0)
  ) {
    const key = nudgeKey(looped);
    if (free(key)) {
      return { kind: "send", key, text: fillLoopText(NUDGE_TEXT, { ref: ticket.ref }) };
    }
  }
  return null;
}

/** The desired-state step: the actions that make the world match the (new) loop. */
function desiredStep(s: LoopSnapshot, loop: RunLoop): LoopAction[] {
  const actions: LoopAction[] = [];
  const rv = reviewView(s, loop);
  if (rv.R !== null) {
    for (const row of rv.R.rows) {
      if (row.state !== "queued" && row.state !== "starting" && row.state !== "running") continue;
      const wanted =
        s.ended === null &&
        (loop.phase === "review" || loop.phase === "ci") &&
        row.epoch === loop.epoch &&
        row.sha === rv.P &&
        s.pr?.state === "open" &&
        (s.pr.headSha === null || s.pr.headSha === row.sha) &&
        (loop.reviewWaivedSha ?? null) !== row.sha;
      if (!wanted) actions.push({ kind: "supersede-review", reviewId: row.id });
    }
  }
  const notes = loop.phase === "done" ? new Map<string, DesiredNote>() : desiredNotes(s, loop);

  if (loop.phase !== "done") {
    const column =
      loop.phase === "review" ? IN_REVIEW : loop.phase === "parked" ? BLOCKED : IN_PROGRESS;
    if (loop.cardFor !== cardMark(loop.phase, loop.epoch))
      actions.push({ kind: "move-card", column });
  }
  for (const [key, { noteKind, text }] of notes) {
    if (!s.openNotes.includes(key)) actions.push({ kind: "note", key, noteKind, text });
  }
  for (const key of s.openNotes) {
    if (!notes.has(key)) actions.push({ kind: "clear-note", key });
  }
  if (loop.phase === "ci") {
    if (s.headCommit !== null && s.pushed?.sha !== s.headCommit) actions.push({ kind: "push" });
    else if (s.pushed !== null && s.pr === null) actions.push({ kind: "open-pr" });
  }
  if (rv.on && rv.R !== null && rv.P !== null) {
    const { R, P, cur } = rv;
    if (
      cur === null ||
      (cur.state === "failed" && failedAttempts(R.rows, loop.epoch, P) < REVIEW_ATTEMPTS)
    ) {
      actions.push({ kind: "request-review", sha: P, attempt: nextAttempt(R.rows, loop.epoch, P) });
    } else if (cur.state === "reported" && cur.blocking === 0) {
      const listed = loop.prBody?.minor ?? 0;
      if (loop.prBody?.reviewId !== cur.id && (cur.minor > 0 || listed > 0)) {
        actions.push({ kind: "pr-body", reviewId: cur.id });
      }
    }
  }
  const gv = gateView(s, loop);
  if (gv.passes && gv.P !== null) {
    const done = loop.merging?.done ?? [];
    if (s.pr?.isDraft !== false && !done.includes("ready")) actions.push({ kind: "mark-ready" });
    actions.push({ kind: "merge", sha: gv.P });
  }
  if (loop.phase !== "done") {
    // an aside run is off its seat: it comes back, or leaves it, instead of any line
    const line: LoopAction | null =
      loop.aside?.wake && s.ended === null
        ? { kind: "wake" }
        : asideDue(s, loop)
          ? { kind: "set-aside" }
          : dueLine(s, loop);
    if (line !== null) actions.push(line);
  }
  return actions;
}

/**
 * One pass of the first loop: the run's next loop state and the actions that make the world
 * match it. Anything a crashed or dropped pass left undone comes out again on the next pass.
 */
export function reconcile(s: LoopSnapshot): { loop: RunLoop; actions: LoopAction[] } {
  const step = stateStep(s);
  // a fresh loop sharing nothing with the input: the engine changes it after running the actions
  const { parked, touches, aside } = step.loop;
  const loop: RunLoop = {
    ...step.loop,
    parked: parked === null ? null : { ...parked },
    touches: touches === null ? null : { sha: touches.sha, paths: [...touches.paths] },
    ...(aside ? { aside: { ...aside } } : {}),
  };
  if (loop.aside) {
    if (s.seat.holdsRun) {
      // a restart mid set-aside or mid wake left the run on its seat
      loop.aside = null;
    } else if (s.ended === null) {
      // (a session with no review seat has no review to wait for: the run comes back)
      loop.aside.wake = loop.phase === "parked" || !s.asideOk || fixDue(s, loop);
    }
  }
  return { loop, actions: [...step.actions, ...desiredStep(s, loop)] };
}
