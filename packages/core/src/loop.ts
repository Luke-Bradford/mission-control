/** The first loop's texts: what a seat is told when `mc report_evidence` is taken or refused. */
import { clockHm } from "./hud.ts";
import { COMMIT_PATHS_NAMED, REFERENCE_ADVICE } from "./mcp.ts";
import { FLIGHT_FLOOR_PATHS } from "./repo-rules.ts";
import type { MoveColumn } from "./repos.ts";
import {
  carriedFrom,
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
  REVIEW_STATUS_CONTEXT,
  readyHardRuleText,
  readyNoteKey,
  readyRuledText,
  readyText,
  readyWaivedText,
  reviewFailedParkText,
  reviewFor,
  reviewParkText,
} from "./review.ts";
import type { SeatState } from "./runtime.ts";
import { globMatches } from "./runtime.ts";
import type { MergeStep, PrCheck, PullRequestView, RunLoop } from "./types.ts";

/** What a PR head's checks say about CI, with the names behind it. */
export interface CiVerdict {
  ci: PullRequestView["ci"];
  failing: string[];
  pending: string[];
  missing: string[];
}

const CHECK_RANK: Record<PrCheck["state"], number> = { passing: 0, pending: 1, failing: 2 };

function worstStates(checks: readonly PrCheck[]): Map<string, PrCheck["state"]> {
  const worst = new Map<string, PrCheck["state"]>();
  for (const c of checks) {
    const seen = worst.get(c.name);
    if (seen === undefined || CHECK_RANK[c.state] > CHECK_RANK[seen]) worst.set(c.name, c.state);
  }
  return worst;
}

/** The worst state of the checks with this name; null when there are none. */
export function checkState(checks: readonly PrCheck[], name: string): PrCheck["state"] | null {
  return worstStates(checks).get(name) ?? null;
}

/**
 * The CI verdict of a head's checks. `mc/review` is left out. With `required` set only those names
 * decide, and one not reported is missing; else every name does.
 */
export function ciVerdict(checks: readonly PrCheck[], required: readonly string[]): CiVerdict {
  const worst = worstStates(checks.filter((c) => c.name !== REVIEW_STATUS_CONTEXT));
  if (worst.size === 0) return { ci: null, failing: [], pending: [], missing: [] };
  const judged = required.length > 0 ? [...new Set(required)] : [...worst.keys()];
  const failing = judged.filter((n) => worst.get(n) === "failing");
  const pending = judged.filter((n) => worst.get(n) === "pending");
  const missing = judged.filter((n) => !worst.has(n));
  const ci =
    failing.length > 0
      ? "failing"
      : pending.length > 0 || missing.length > 0
        ? "pending"
        : "passing";
  return { ci, failing, pending, missing };
}

/** The run has no loop state: Mission Control is not driving it. */
export const EVIDENCE_NO_LOOP =
  "Not recorded: Mission Control is not driving this run, so there is no one to report to.";
/** The run's loop is parked, waiting on the operator. */
export const EVIDENCE_PARKED =
  "Not recorded: this run is parked and waiting on the operator; Mission Control will message you when it resumes.";
/** Parks a new committed report can clear without weakening an operator or budget hold. */
export const EVIDENCE_UNPARK_KINDS = ["review", "silent", "refused"] as const;

/** Whether a report of newly committed work is allowed to resume this park. */
export function evidenceCanUnpark(
  parked: RunLoop["parked"],
): parked is NonNullable<RunLoop["parked"]> {
  return (
    parked !== null &&
    !parked.ended &&
    (EVIDENCE_UNPARK_KINDS as readonly string[]).includes(parked.kind)
  );
}
/** The last push is in CI. */
export const EVIDENCE_IN_CI =
  "CI is running on your last push; Mission Control will message you the result.";
/** The worktree holds changes no commit has. */
export const evidenceUncommittedText = (paths: readonly string[]): string =>
  `Not recorded: uncommitted changes in ${pathsText(paths)}. Commit them with mc commit, then report again.`;
/** The first COMMIT_PATHS_NAMED paths, comma-separated, then "and {n} more". */
export const pathsText = (paths: readonly string[]): string => {
  const shown = paths.slice(0, COMMIT_PATHS_NAMED).join(", ");
  const more =
    paths.length > COMMIT_PATHS_NAMED ? ` and ${paths.length - COMMIT_PATHS_NAMED} more` : "";
  return `${shown}${more}`;
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
/** How long a green PR may wait without its seat recording evidence. */
export const EVIDENCE_REMIND_MS = 20 * 60_000;
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

/** Shared prefixes for CI activity events and parking reasons. */
export const CI_PASSED_EVENT_PREFIX = "CI passed on ";
export const CI_FAILED_EVENT_PREFIX = "CI failed on ";
export const CI_RERUN_FAILED_EVENT_PREFIX = "CI failed again on the re-run of ";
export const CI_PARK_FAILED_PREFIX = "CI failed ";

/** Failure outcomes shared by Overview and the FLIGHT ledger. */
export function isCiFailureEvent(text: string): boolean {
  return (
    !text.includes("no run could be re-run") &&
    (text.startsWith(CI_FAILED_EVENT_PREFIX) ||
      text.startsWith("CI flaked on ") ||
      text.startsWith(CI_RERUN_FAILED_EVENT_PREFIX) ||
      text.startsWith(parkedEventText(CI_PARK_FAILED_PREFIX)))
  );
}

/** `{sha7}` is the first 7 characters of the failed sha; the excerpt follows. */
export const CI_FAILED_TEXT = `${CI_FAILED_EVENT_PREFIX}{sha7}. Fix it, commit, and call mc report_evidence again. If it is a flaky test that is not yours, report with a note starting "${EVIDENCE_RULING_PREFIX}" and say why; the operator will decide. The failing output:\n`;
/** The park kind of a run whose author ruled on a CI failure instead of fixing it. */
export const RULING_PARK = "ruling";
/** The park kind of a run whose ticket lists a controller check; only the operator settles it. */
export const CONTROLLER_CHECK_PARK = "controller-check";
/** The heading (at line start, case-sensitive) that opens a ticket's controller-check section. */
export const CONTROLLER_CHECK_HEADING = "## Controller check";
const CONTROLLER_CHECK_RE = new RegExp(`^${CONTROLLER_CHECK_HEADING}[ \\t]*\\r?$`, "m");
/** The text of a ticket's controller-check section (up to the next heading); null without one. */
export function controllerCheckOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = CONTROLLER_CHECK_RE.exec(body);
  if (m === null) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,2} /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}
/** The park reason: the sha held and the ticket's controller-check text. */
export const controllerCheckParkText = (sha: string, check: string): string =>
  `controller check on ${sha.slice(0, 7)}${check === "" ? "" : `: ${check}`}`;
/** The rework line for a failed controller check; `note` is the controller's. */
export const controllerCheckFailText = (sha: string, note: string | undefined): string =>
  `The controller's check failed on ${sha.slice(0, 7)}.${note ? `\n\n${note}` : ""} Fix it, commit, and report again.`;
/** The key of the line sent when FLIGHT's re-run of the failed jobs on `sha` failed too. */
export const rerunFailedKey = (runId: string, sha: string): string => `rerun:${runId}:${sha}`;
/** `{sha7}` is the first 7 characters of the failed sha; the excerpt of the re-run's failure follows. */
export const CI_RERUN_FAILED_TEXT = `CI failed again on {sha7} when FLIGHT re-ran it, so your ruling was not accepted. Fix it, commit, and report again. The failing output:\n`;
export const NO_NEW_COMMIT_TEXT = `No new commit since CI failed on {sha7}. Fix it and commit first, then report; or report with a note starting "${EVIDENCE_RULING_PREFIX}" if the failure is not yours.`;
/** How a failed merge step is named in the park reason; the server parks it with kind `merge-step`. */
export const MERGE_STEP_WORDS = {
  ready: "mark ready",
  merge: "merge",
  close: "close the issue",
  "delete-remote": "delete the remote branch",
} as const satisfies Partial<Record<MergeStep, string>>;
/** The blocked note for a merged run's local branch that could not be deleted. */
export const cleanupBranchNoteKey = (runId: string): string => `cleanup-branch:${runId}`;
/** A housekeeping note (a branch or a worktree that could not be removed): the controller's. */
export const isCleanupNoteKey = (key: string): boolean =>
  key.startsWith("cleanup-") || key.startsWith("cleanup:");
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;

/** A stable browser-safe hash for a set of hard-rule files, regardless of order or duplicates. */
export const hardRulesFilesHash = (paths: readonly string[]): string => {
  let hash = FNV_64_OFFSET;
  for (const byte of new TextEncoder().encode(JSON.stringify([...new Set(paths)].sort()))) {
    hash = ((hash ^ BigInt(byte)) * FNV_64_PRIME) & FNV_64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
};
/** The flag note while a run's PR touches a particular set of hard-rule files. */
export const hardRulesFlagKey = (runId: string, paths: readonly string[]): string =>
  `flag:${runId}:hard-rules:${hardRulesFilesHash(paths)}`;
/** A run id may itself contain colons (`guido-1:20261021T165337Z`), so only the hash is anchored. */
export const isHardRulesFlagKey = (key: string): boolean =>
  /^flag:.+:hard-rules:(?:[0-9a-f]{16}|[0-9a-f]{40}(?:[0-9a-f]{24})?)$/.test(key);
/** The flag note for a CI failure that passed on its one re-run, per sha. */
export const flakeNoteKey = (runId: string, sha: string): string => `flake:${runId}:${sha}`;
/** A flake record is the controller's to follow up. */
export const isFlakeNoteKey = (key: string): boolean => key.startsWith("flake:");
/** The engine's own flag for a green head left without evidence; the planner leaves it alone. */
export const evidenceNoteKey = (runId: string, sha: string): string => `evidence:${runId}:${sha}`;
export const isEvidenceNoteKey = (key: string): boolean => key.startsWith("evidence:");
export const flakeText = (ref: string, sha: string, runs: { id: number; name: string }[]): string =>
  `${ref}: CI failed on ${sha.slice(0, 7)} and passed on re-run (a flake): ${
    runs.length === 0 ? "run not read" : runs.map((r) => `${r.name} run ${r.id}`).join(", ")
  }`;
/** The flag note when a merged PR's remote branch cannot be deleted for want of a sha to lease on. */
export const noShaDeleteNoteKey = (runId: string): string => `flag:${runId}:no-sha-delete`;
export const noShaDeleteText = (ref: string): string =>
  `${ref}: merged, but the remote branch could not be deleted (no sha to lease on); the operator can delete it`;
/** The Activity rows of the merge steps. */
const prRef = (pr: number | null): string => (pr === null ? "the PR" : `PR #${pr}`);
export const readyMarkedText = (pr: number | null): string => `marked ${prRef(pr)} ready`;
export const mergedText = (pr: number | null): string => `merged ${prRef(pr)} (merge commit)`;
export const closedIssueText = (issue: number): string => `closed #${issue}`;
export const deletedRemoteText = (branch: string): string => `deleted origin's ${branch}`;
export const deletedLocalText = (branch: string): string => `deleted the local branch ${branch}`;
export const localNotDeletedText = (branch: string, why: string): string =>
  `could not delete the local branch ${branch}: ${why}`;
export const mergeStepFailedText = (step: string, why: string): string => `${step} failed: ${why}`;
/** The gate parks a run for these; the reason says which. */
export const gateStrayParkText = (call: string, paths: readonly string[]): string =>
  `changes outside ${call}'s area: ${paths.join(", ")}`;
export const GATE_FOREIGN_COMMITS_PARK = "commits on the branch that Mission Control did not make";
/** The line a conflicted merge of main sends the seat, keyed so it goes once per main sha. */
export const conflictKey = (runId: string, mainSha: string): string =>
  `conflict:${runId}:${mainSha}`;
export const conflictText = (files: readonly string[]): string =>
  `Merging main into your branch conflicted in: ${files.join(", ")}. Resolve the conflict markers in those files, keeping what both sides meant, then call mc commit and mc report_evidence.`;
/** The Activity rows for merging main into a run's branch. */
export const mergedMainText = (mainSha: string): string =>
  `merged main ${mainSha.slice(0, 7)} into the branch`;
export const reviewCarriedText = (from: string, to: string): string =>
  `review of ${from.slice(0, 7)} carried to ${to.slice(0, 7)} (main merged, PR diff unchanged)`;
export const mainConflictText = (mainSha: string, n: number): string =>
  `merging main ${mainSha.slice(0, 7)} conflicted in ${n} ${n === 1 ? "file" : "files"}`;
/** The Activity row for a park. */
export const parkedEventText = (reason: string): string => `parked: ${reason}`;
export const RESUME_TEXT =
  "Carry on with {ref}: Mission Control restarted, or your rate limit has reset. There is no turn or time limit: work until it is done or truly blocked; if blocked, name the blocker. When the work is committed, call mc report_evidence.";
export const NUDGE_TEXT =
  "Carry on with {ref}: commit and report evidence when done. There is no turn or time limit; work until it is done or truly blocked, and name the blocker if so.";
export const NUDGE_TRIES = 3;

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
  awaitingFlight: null,
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
/** A run in CI leaves its seat once its PR is open and its turn has ended. */
export const asideInCiEventText = (call: string): string =>
  `in CI; ${call} is free for its next ticket`;
export const wokenEventText = (call: string): string => `back to ${call} for rework`;
export const wakeFailedText = (reason: string): string =>
  `could not go back to its seat: ${reason}`;
export const reworkFirstText = (call: string, ref: string): string =>
  `${call} has rework waiting on ${ref}; that goes first`;

/** A hub-recorded item that arrived while a seat was in a turn. */
export interface PendingSeatWork {
  key: string;
  kind: "findings" | "ci" | "message";
  at: number;
  text: string;
}

export interface PendingSeatWorkInput {
  lastTurnStartedAt: number | null;
  reviews: readonly {
    id: number;
    round: number;
    state: string;
    blocking: number;
    verdict: { spec: "pass" | "fail"; quality: "pass" | "fail" } | null;
    endedAt: number | null;
  }[];
  events: readonly { key: string; text: string; at: number }[];
  messages: readonly { key: string; from: string; at: number }[];
  woken: readonly string[];
}

/**
 * Purely classifies hub records which reached a seat after its current turn began.  Callers give
 * it only records for the seat's current run; `woken` is the durable set of earlier wake causes.
 */
export function pendingSeatWork(input: PendingSeatWorkInput): PendingSeatWork[] {
  const since = input.lastTurnStartedAt;
  if (since === null) return [];
  const out: PendingSeatWork[] = [];
  for (const r of input.reviews) {
    const failed = r.verdict?.spec === "fail" || r.verdict?.quality === "fail";
    if (
      r.state === "reported" &&
      r.blocking > 0 &&
      failed &&
      r.endedAt !== null &&
      r.endedAt >= since
    )
      out.push({
        key: `review:${r.id}`,
        kind: "findings",
        at: r.endedAt,
        text: `RETRO round ${r.round} findings`,
      });
  }
  for (const e of input.events) {
    if (e.at < since || !e.text.startsWith(CI_FAILED_EVENT_PREFIX)) continue;
    const sha =
      e.text.slice(CI_FAILED_EVENT_PREFIX.length).match(/^[0-9a-f]{7,}/i)?.[0] ?? "the PR head";
    out.push({
      key: `ci:${e.key}`,
      kind: "ci",
      at: e.at,
      text: `a CI failure on ${sha.slice(0, 7)}`,
    });
  }
  for (const m of input.messages) {
    if (m.at >= since && (m.from === "CAPCOM" || m.from === "flight-1"))
      out.push({
        key: `message:${m.key}`,
        kind: "message",
        at: m.at,
        text: `a message from ${m.from}`,
      });
  }
  const woken = new Set(input.woken);
  return out
    .filter((x) => !woken.has(x.key))
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** The one short line that restarts an idle seat for its newly-arrived work. */
export const pendingWakeText = (
  work: readonly PendingSeatWork[],
  ref: string,
  tz: string,
): string =>
  `Waking you: ${work.map((x) => `${x.text} (${clockHm(x.at, tz)})`).join(" and ")} are waiting for ${ref}.`;
export const ticketInReviewText = (ref: string): string =>
  `${ref} is in review; it comes back to its seat when it needs rework`;
export const NOT_ASIDE = "the run is not waiting on its review";
export const seatBusyText = (call: string): string =>
  `${call} is busy (waking a run or starting one); try again in a moment`;

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
  /** The run's session has a review seat, so the run may leave its seat in CI or review. */
  asideOk: boolean;
  /** The latest evidence. */
  evidence: { id: number; at: number; ruling: boolean; note?: string } | null;
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
    /** The names behind `ci`; absent or empty: the texts say none. */
    checks?: { failing: string[]; pending: string[]; missing: string[] };
    /** The state of `mc/review` on GitHub; null when not reported. Absent: not reported. */
    reviewStatus?: PrCheck["state"] | null;
  } | null;
  /** The repo is a `merge` workspace: the engine merges a PR that passes the gate. Absent: false. */
  autoMerge?: boolean;
  /**
   * The repo's rules set `hard_rules` themselves. Without it the gate never passes: the run stops
   * at "ready for a human". Absent: false.
   */
  hardRulesSet?: boolean;
  flightPowers?: "standard" | "superuser";
  flightHeld?: boolean;
  /** The run's profile limits: CI tries and review rounds. Absent: `CI_TRIES` and `REVIEW_ROUNDS`. */
  limits?: { tries: number; rounds: number };
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
  | { kind: "ci-excerpt"; key: string; sha: string; again?: boolean }
  | { kind: "rerun-ci"; sha: string }
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
  | { kind: "update-branch"; mainSha: string }
  | { kind: "mark-ready" }
  | { kind: "merge"; sha: string }
  | { kind: "close-issue" }
  | { kind: "file-minor-issue" }
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

/** Which fact kept a pushed run from reaching CI: the first of push, newest commit, PR, PR head. */
function missingWhy(
  headCommit: string | null,
  pushed: LoopSnapshot["pushed"],
  pr: LoopSnapshot["pr"],
): string {
  if (pushed === null) return "no push is recorded for the run";
  if (headCommit === null)
    return `no commit is recorded for the run, but ${sha7(pushed.sha)} is pushed`;
  if (pushed.sha !== headCommit) {
    return `the push is ${sha7(pushed.sha)}, not the newest commit ${sha7(headCommit)}`;
  }
  if (pr === null) return "no PR of the run has been read from GitHub";
  return `PR #${pr.number} has ${pr.headSha === null ? "no head" : `head ${sha7(pr.headSha)}`}, not ${sha7(pushed.sha)}`;
}

const IN_PROGRESS = "In progress" satisfies MoveColumn;
const IN_REVIEW = "In review" satisfies MoveColumn;
const BLOCKED = "Blocked" satisfies MoveColumn;
const DONE = "Done" satisfies MoveColumn;

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

const nudgePrefix = (s: LoopSnapshot): string =>
  `nudge:${s.runId}:${s.loop.epoch}:${s.evidenceCount}`;
const nudges = (s: LoopSnapshot): number[] =>
  Object.entries(s.claimed).flatMap(([key, at]) =>
    key === nudgePrefix(s) || key.startsWith(`${nudgePrefix(s)}:`) ? [at] : [],
  );
const nudgeKey = (s: LoopSnapshot): string => `${nudgePrefix(s)}:${nudges(s).length + 1}`;

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
  const from = P !== null ? carriedFrom(loop.carry, loop.reviewWaivedSha, P) : null;
  const cur = R !== null && P !== null ? reviewFor(R.rows, loop.epoch, P, from) : null;
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
  return { R, P, from, cur, waived, on, blocked };
}

/** Floors 2 and 7, with unreadable rules held for the operator. */
export function flightFloorBlocked(loop: Pick<RunLoop, "touches" | "gate">): boolean {
  return (
    loop.touches?.paths.some(
      (p) =>
        FLIGHT_FLOOR_PATHS.some((g) => globMatches(g, p, true)) &&
        !(p.toLowerCase() === "claude.md" && loop.gate?.missionControlChanged === false),
    ) ?? true
  );
}

/**
 * The merge gate's facts for the pushed sha in a `merge` workspace. `on`: the review, CI and head
 * facts hold, so the engine's reads (`gate`, `touches`) decide; each is null when missing or for
 * another sha.
 */
export function gateView(s: LoopSnapshot, loop: RunLoop) {
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
    s.pr.reviewStatus === "passing" &&
    ((s.flightPowers === "superuser" && rv.waived) ||
      (loop.ciFailedSha !== P &&
        !rv.waived &&
        rv.cur !== null &&
        rv.cur.state === "reported" &&
        rv.cur.blocking === 0));
  const touches = P !== null && loop.touches?.sha === P ? loop.touches : null;
  const gate = P !== null && loop.gate?.sha === P ? loop.gate : null;
  const elevated = s.flightPowers === "superuser";
  const floor = elevated && flightFloorBlocked({ touches, gate });
  const cleared =
    elevated &&
    P !== null &&
    (loop.flightClearedSha === P ||
      (loop.carry?.to === P && loop.carry.from === loop.flightClearedSha));
  const clear =
    touches !== null &&
    !floor &&
    gate?.missionControlChanged !== true &&
    (touches.paths.length === 0 || cleared);
  const otherGates =
    on &&
    s.pr?.mergeable !== "CONFLICTING" &&
    s.hardRulesSet === true &&
    gate?.hubOnly === true &&
    gate.strays.length === 0 &&
    (!elevated || (!s.flightHeld && (s.seat.state !== "stopped" || loop.aside != null)));
  const awaiting =
    elevated && otherGates && touches !== null && touches.paths.length > 0 && !floor && !cleared;
  const passes = otherGates && clear;
  return { on, P, touches, gate, clear, passes, awaiting };
}

/** The move of a merged run's card to Done, once per epoch: a later move by hand is left alone. */
function doneMove(loop: RunLoop): LoopAction[] {
  return loop.cardFor === cardMark("done", loop.epoch) ? [] : [{ kind: "move-card", column: DONE }];
}

/** The steps after a merge, in order, minus those already done. */
function afterMerge(s: LoopSnapshot): LoopAction[] {
  const done = s.loop.merging?.done ?? [];
  const todo = (step: MergeStep): boolean => !done.includes(step);
  const sha = s.loop.merging?.sha ?? s.pr?.headSha ?? s.pushed?.sha ?? null;
  const actions: LoopAction[] = [];
  if (todo("close")) actions.push({ kind: "close-issue" });
  if (todo("file-minor")) actions.push({ kind: "file-minor-issue" });
  if (todo("delete-remote")) {
    if (sha !== null) actions.push({ kind: "delete-remote-branch", sha });
    else {
      const key = noShaDeleteNoteKey(s.runId);
      if (!s.openNotes.includes(key)) {
        actions.push({ kind: "note", key, noteKind: "flag", text: noShaDeleteText(s.ticket.ref) });
      }
    }
  }
  actions.push(...doneMove(s.loop), { kind: "end-run" });
  if (todo("delete-local")) actions.push({ kind: "delete-local-branch" });
  actions.push({ kind: "take-next" });
  return actions;
}

/** The state step: the first matching row of the table changes the loop. */
function stateStep(s: LoopSnapshot): Step {
  const { loop, pr, evidence, headCommit, pushed, now, seat } = s;
  const prNumber = pr?.number ?? loop.prNumber;
  const merged = pr?.state === "merged" || (loop.merging?.done ?? []).includes("merge");

  // the server parked this run after the merge: its step failed, and the operator decides
  if (loop.phase === "parked" && loop.parked?.kind === "merge-step") return unchanged(loop);
  if (merged && loop.phase !== "done") {
    const mergedSha = pr?.headSha ?? pushed?.sha ?? null;
    const merging =
      s.autoMerge === true && loop.merging == null && mergedSha !== null
        ? { sha: mergedSha, done: ["merge" as const] }
        : loop.merging;
    return {
      loop: { ...loop, phase: "done", ...(merging === undefined ? {} : { merging }) },
      actions:
        s.autoMerge === true
          ? [...afterMerge(s), { kind: "event", text: "merged" }]
          : [
              ...doneMove(loop),
              { kind: "end-run" },
              { kind: "take-next" },
              { kind: "event", text: "merged" },
            ],
    };
  }
  if (loop.phase === "done") {
    return {
      loop,
      actions:
        s.autoMerge === true
          ? afterMerge(s)
          : [...doneMove(loop), { kind: "end-run" }, { kind: "take-next" }],
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
  // A developer may answer a RETRO finding without changing the head.  That answer belongs to
  // RETRO, not the operator: remember which review it answers and request one fresh judgement.
  if (
    loop.phase === "review" &&
    rv.P !== null &&
    rv.cur !== null &&
    evidence !== null &&
    evidence.id > loop.reportedEvidenceId &&
    headCommit === rv.P &&
    rv.blocked &&
    !rv.waived
  ) {
    return unchanged({ ...loop, reportedEvidenceId: evidence.id, reviewReplyTo: rv.cur.id });
  }
  if (reporting && evidence !== null && evidence.id > loop.reportedEvidenceId) {
    const seen = { ...loop, reportedEvidenceId: evidence.id };
    if (headCommit !== null && headCommit === loop.ciFailedSha) {
      if (evidence.ruling) {
        return park(
          seen,
          RULING_PARK,
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
        ...(loop.mainMerge ? { mainMerge: null } : {}),
      },
      actions: [{ kind: "event", text: "reported; pushing" }],
    };
  }

  if (rv.on && rv.R !== null && rv.P !== null && rv.cur !== null) {
    const { R, P, cur } = rv;
    const rounds = reviewRoundLimit(s, loop, P);
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
      loop.reviewReplyTo !== cur.id &&
      fixesSent(s.claimed, s.runId, loop.epoch) + 1 >= rounds
    ) {
      return park(
        loop,
        "review",
        reviewParkText(
          R.retro,
          P,
          rounds,
          evidence?.note !== undefined && evidence.id === loop.reportedEvidenceId
            ? { developer: evidence.note, findings: R.findings }
            : undefined,
        ),
      );
    }
  }

  // A hard-rule touch is the operator's to merge, so the hard-rule paths it brings are not strays;
  // it does not hide foreign commits or other strays.
  const gv = gateView(s, loop);
  if (gv.on && gv.touches !== null && gv.gate !== null) {
    const hard = gv.touches.paths;
    const strays = gv.gate.strays.filter((p) => !hard.includes(p));
    if (strays.length > 0) return park(loop, "gate", gateStrayParkText(seat.call, strays));
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
          `the push or PR${forSha(headCommit ?? pushed?.sha)} has not shown up on GitHub after ${minutes(NO_CI_AFTER_MS)} minutes${loop.lastRefusal === null ? "" : ` (${loop.lastRefusal})`}: ${missingWhy(headCommit, pushed, pr)}`,
        );
      }
      return unchanged(loop);
    }
    const short = sha7(pushed.sha);
    if (pr.mergeable === "CONFLICTING") {
      // a merge workspace merges main into the branch instead (see branchUpdateDue), for as long
      // as CI may stay pending
      const waitedFrom = Math.max(pushed.at, loop.unparkedAt ?? 0);
      if (s.autoMerge === true && !loop.mainMerge && now - waitedFrom <= CI_PENDING_MAX_MS) {
        return unchanged(loop);
      }
      return park(loop, "conflict", `PR #${pr.number} conflicts with main`);
    }
    if (pr.ci === "passing") {
      const flaked = loop.rerun?.sha === pushed.sha;
      const actions: LoopAction[] = [{ kind: "event", text: `${CI_PASSED_EVENT_PREFIX}${short}` }];
      if (flaked) actions.push({ kind: "event", text: `CI flaked on ${short}: passed on re-run` });
      return {
        loop: {
          ...loop,
          phase: "review",
          ciFails: 0,
          rerun: loop.rerun && flaked ? { ...loop.rerun, flaked: true } : loop.rerun,
        },
        actions,
      };
    }
    if (pr.ci === "failing") {
      if (loop.ciFailedSha === pushed.sha) return unchanged({ ...loop, phase: "working" });
      if (loop.rerun?.sha !== pushed.sha) {
        // the first failure on a sha is re-run once before the seat hears of it
        return {
          loop: { ...loop, rerun: { sha: pushed.sha, at: now, runs: [] } },
          actions: [{ kind: "rerun-ci", sha: pushed.sha }],
        };
      }
      // a poll from before the re-run still shows the old failure
      if (pr.polledAt <= loop.rerun.at) return unchanged(loop);
      const failed = { ...loop, ciFails: loop.ciFails + 1, ciFailedSha: pushed.sha };
      const named = pr.checks?.failing.length ? ` (failing: ${pr.checks.failing.join(", ")})` : "";
      if (failed.ciFails >= (s.limits?.tries ?? CI_TRIES)) {
        return park(
          failed,
          "ci",
          `${CI_PARK_FAILED_PREFIX}${failed.ciFails} times; last on ${short}${named}`,
        );
      }
      return {
        loop: { ...failed, phase: "working" },
        actions: [{ kind: "event", text: `${CI_FAILED_EVENT_PREFIX}${short}${named}` }],
      };
    }
    // a run the operator un-parked is judged from the un-park, not from a push made before it;
    // a re-run is also judged from when it was asked for
    const since = Math.max(
      pushed.at,
      loop.unparkedAt ?? 0,
      loop.rerun?.sha === pushed.sha ? loop.rerun.at : 0,
    );
    if (pr.ci === "pending" && now - since > CI_PENDING_MAX_MS) {
      const parts = [
        pr.checks?.pending.length ? `pending: ${pr.checks.pending.join(", ")}` : "",
        pr.checks?.missing.length ? `missing: ${pr.checks.missing.join(", ")}` : "",
      ].filter((p) => p !== "");
      return park(
        loop,
        "ci-pending",
        `CI pending for ${minutes(CI_PENDING_MAX_MS)} minutes on ${short}${
          parts.length > 0 ? ` (${parts.join("; ")})` : ""
        }`,
      );
    }
    if (pr.ci === null && pr.polledAt - since > NO_CI_AFTER_MS) {
      return park(loop, "no-ci", `no CI reported for ${short}`);
    }
    return unchanged(loop);
  }

  if (loop.phase === "working" && s.tokens > s.budget + loop.budgetExtra) {
    // s.tokens is input + output tokens, as the engine supplies them (cache reads are not counted)
    return park(
      loop,
      "budget",
      `used ${s.tokens} input + output tokens of a ${s.budget + loop.budgetExtra}-token budget`,
    );
  }
  if (owesReport(s)) {
    const tried = nudges(s);
    const t = tried.length === 0 ? undefined : Math.max(...tried);
    if (
      tried.length >= NUDGE_TRIES &&
      t !== undefined &&
      seat.state === "idle" &&
      !seat.inTurn &&
      !seat.openQuestion &&
      seat.lastTurnEndedAt !== null &&
      seat.lastTurnEndedAt > t
    ) {
      return park(
        loop,
        "silent",
        `stopped after ${NUDGE_TRIES} carry-on resumes without reporting`,
      );
    }
  }
  return unchanged(loop);
}

type DesiredNote = { noteKind: LoopNoteKind; text: string };

/** The note keys the loop wants open, with their kind and text. */
function desiredNotes(s: LoopSnapshot, loop: RunLoop): Map<string, DesiredNote> {
  const notes = new Map<string, DesiredNote>();
  const { ticket, runId, pushed, seat } = s;
  if (loop.rerun?.flaked === true) {
    notes.set(flakeNoteKey(runId, loop.rerun.sha), {
      noteKind: "flag",
      text: flakeText(ticket.ref, loop.rerun.sha, loop.rerun.runs),
    });
  }
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
            // a merge workspace's pending, failing or unreported CI is not ready; only a ruling is
            if (loop.ciFailedSha === rv.P) {
              notes.set(readyNoteKey(runId, rv.P), {
                noteKind: "ready",
                text: readyRuledText(ticket.ref, n, rv.R.retro, rv.P),
              });
            } else if (s.autoMerge !== true && s.pr?.mergeable !== "CONFLICTING") {
              notes.set(readyNoteKey(runId, rv.P), {
                noteKind: "ready",
                text: readyText(ticket.ref, n, rv.R.retro, rv.P, rv.cur.minor),
              });
            }
          } else {
            // Hard-rule files and Mission Control block changes hold it for the operator.
            const hardPaths = [
              ...new Set([
                ...(gv.touches?.paths ?? []),
                ...(gv.gate?.missionControlChanged === true ? ["CLAUDE.md"] : []),
              ]),
            ];
            const hardOnly =
              s.pr?.mergeable !== "CONFLICTING" &&
              gv.touches !== null &&
              hardPaths.length > 0 &&
              gv.gate?.hubOnly === true &&
              gv.gate.strays.every((p) => hardPaths.includes(p));
            if (hardOnly && gv.touches !== null) {
              notes.set(readyNoteKey(runId, rv.P), {
                noteKind: "ready",
                text: gv.awaiting
                  ? `${ticket.ref}: PR #${n} awaiting-flight on ${rv.P}`
                  : readyHardRuleText(ticket.ref, n, hardPaths),
              });
            } else if (s.hardRulesSet !== true && s.pr?.mergeable !== "CONFLICTING") {
              notes.set(readyNoteKey(runId, rv.P), {
                noteKind: "ready",
                text: readyText(ticket.ref, n, rv.R.retro, rv.P, rv.cur.minor),
              });
            }
          }
          // Other gate failures or pending reads do not produce a ready note.
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
    notes.set(hardRulesFlagKey(runId, loop.touches.paths), {
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
    fixesSent(s.claimed, s.runId, loop.epoch) + 1 < reviewRoundLimit(s, loop, rv.P)
  );
}

/** A FLIGHT rework grant permits exactly one more blocking RETRO outcome on that head. */
function reviewRoundLimit(s: LoopSnapshot, loop: RunLoop, sha: string): number {
  return (loop.flightReworks?.[sha] ?? 0) > 0 ? 1 : (s.limits?.rounds ?? REVIEW_ROUNDS);
}

/** Whether the run in CI (its PR open on the pushed sha) or in review may leave its seat now. */
function asideDue(s: LoopSnapshot, loop: RunLoop): boolean {
  const { seat, pushed, pr } = s;
  return (
    s.asideOk &&
    !loop.aside &&
    s.ended === null &&
    (loop.phase === "review" || loop.phase === "ci") &&
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

/**
 * The main sha to merge into the run's branch now, or null. In a merge workspace, a run waiting at
 * its pushed sha is updated when its PR conflicts with main; its seat is between turns, or the
 * run is aside.
 */
function branchUpdateDue(s: LoopSnapshot, loop: RunLoop): string | null {
  const { seat, pr } = s;
  const P = s.pushed?.sha ?? null;
  const gate = P !== null && loop.gate?.sha === P ? loop.gate : null;
  if (
    s.autoMerge !== true ||
    s.ended !== null ||
    (loop.phase !== "review" && loop.phase !== "ci") ||
    loop.mainMerge ||
    P === null ||
    gate === null ||
    gate.containsMain ||
    s.headCommit !== P ||
    pr?.state !== "open" ||
    pr.headSha !== P ||
    fixDue(s, loop) ||
    owesReport({ ...s, loop })
  ) {
    return null;
  }
  if (!loop.aside && !(seat.holdsRun && !seat.inTurn && seat.state === "idle")) return null;
  return pr.mergeable === "CONFLICTING" ? gate.mainSha : null;
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

  if (working && loop.mainMerge) {
    const key = conflictKey(runId, loop.mainMerge.mainSha);
    if (free(key)) return { kind: "send", key, text: conflictText(loop.mainMerge.files) };
  }

  // FLIGHT re-ran the failed jobs on the ruled sha and they failed again: the author gets that failure
  if (
    working &&
    loop.ciFailedSha !== null &&
    loop.rulingRerun?.sha === loop.ciFailedSha &&
    loop.rulingRerun.outcome === "failed"
  ) {
    const key = rerunFailedKey(runId, loop.ciFailedSha);
    if (free(key)) return { kind: "ci-excerpt", key, sha: loop.ciFailedSha, again: true };
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
        (row.sha === rv.P || (rv.from !== null && row.sha === rv.from)) &&
        s.pr?.state === "open" &&
        (s.pr.headSha === null || s.pr.headSha === row.sha || s.pr.headSha === rv.P) &&
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
    // the flag for a merged PR's undeletable branch outlives the run's steps
    if (
      loop.phase === "done" &&
      (key === noShaDeleteNoteKey(s.runId) || key === cleanupBranchNoteKey(s.runId))
    ) {
      continue;
    }
    // a flake record stays for the controller to dismiss
    if (isFlakeNoteKey(key)) continue;
    // the engine raises and clears the missing-evidence flag itself
    if (isEvidenceNoteKey(key)) continue;
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
      (cur.state === "failed" && failedAttempts(R.rows, loop.epoch, P) < REVIEW_ATTEMPTS) ||
      (cur.state === "reported" && cur.blocking > 0 && loop.reviewReplyTo === cur.id)
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
  loop.awaitingFlight = gv.awaiting ? gv.P : null;
  if (gv.passes && gv.P !== null) {
    const done = loop.merging?.done ?? [];
    const readyDone = loop.merging?.sha === gv.P && done.includes("ready");
    if (s.pr?.isDraft !== false && !readyDone) actions.push({ kind: "mark-ready" });
    actions.push({ kind: "merge", sha: gv.P });
  }
  if (loop.phase !== "done") {
    // an aside run is off its seat: it comes back, or leaves it, instead of any line
    const updateSha = branchUpdateDue(s, loop);
    const line: LoopAction | null =
      loop.aside?.wake && s.ended === null
        ? { kind: "wake" }
        : updateSha !== null
          ? { kind: "update-branch", mainSha: updateSha }
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
  const { parked, touches, aside, gate, merging, mainMerge, carry, rerun, rulingRerun } = step.loop;
  const loop: RunLoop = {
    ...step.loop,
    parked: parked === null ? null : { ...parked },
    touches: touches === null ? null : { ...touches, paths: [...touches.paths] },
    ...(aside ? { aside: { ...aside } } : {}),
    ...(gate ? { gate: { ...gate, strays: [...gate.strays] } } : {}),
    ...(merging ? { merging: { ...merging, done: [...merging.done] } } : {}),
    ...(mainMerge ? { mainMerge: { ...mainMerge, files: [...mainMerge.files] } } : {}),
    ...(carry ? { carry: { ...carry } } : {}),
    ...(rerun ? { rerun: { ...rerun, runs: rerun.runs.map((r) => ({ ...r })) } } : {}),
    ...(rulingRerun
      ? { rulingRerun: { ...rulingRerun, runs: rulingRerun.runs.map((r) => ({ ...r })) } }
      : {}),
  };
  if (loop.aside) {
    if (s.seat.holdsRun) {
      // a restart mid set-aside or mid wake left the run on its seat
      loop.aside = null;
    } else if (s.ended === null) {
      // (a session with no review seat has no review to wait for: the run comes back)
      // (working: a conflicted merge of main, or CI failed after one, waits on the seat)
      loop.aside.wake ||=
        loop.phase === "parked" || loop.phase === "working" || !s.asideOk || fixDue(s, loop);
    }
  }
  return { loop, actions: [...step.actions, ...desiredStep(s, loop)] };
}
