import { fillLoopText, RATE_LIMIT_RETRY_MS } from "./loop.ts";
import type { SeatState } from "./runtime.ts";

export const REVIEW_STATES = [
  "queued",
  "starting",
  "running",
  "reported",
  "failed",
  "superseded",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const FINDING_SEVERITIES = ["Critical", "Important", "Minor"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The severities the author must fix before merge. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ["Critical", "Important"];

export const VERDICTS = ["pass", "fail"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewVerdict {
  spec: Verdict;
  quality: Verdict;
}

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string;
  /** 1-based; 0: the whole file. */
  line: number;
  summary: string;
  scenario: string;
  /** The exact change the author should make. */
  fix: string;
}

export interface StoredFinding extends ReviewFinding {
  pos: number;
  state: "open" | "logged";
}

export interface ReviewRow {
  id: number;
  authorRunId: string;
  repoId: string;
  seatId: string;
  prNumber: number;
  sha: string;
  epoch: number;
  attempt: number;
  round: number;
  state: ReviewState;
  runId: string | null;
  verdict: ReviewVerdict | null;
  summary: string | null;
  blocking: number;
  minor: number;
  failure: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export type ReviewRequest = Pick<
  ReviewRow,
  "authorRunId" | "repoId" | "seatId" | "prNumber" | "sha" | "epoch" | "attempt" | "round"
> & { at: number };

export const REVIEW_FINDINGS_MAX = 50;
export const FINDING_FILE_MAX = 300;
export const FINDING_SUMMARY_MAX = 500;
export const FINDING_SCENARIO_MAX = 1000;
export const FINDING_FIX_MAX = 2000;
export const REVIEW_SUMMARY_MAX = 2000;

/** A finding's file: repo-relative, plain characters only (part of it may be posted to GitHub). */
export const FINDING_FILE = /^[A-Za-z0-9._/-]+$/;

export function findingFileOk(f: string): boolean {
  const parts = f.split("/");
  return FINDING_FILE.test(f) && !parts.includes("..") && !parts.includes("");
}

export const FINDINGS_RECORDED =
  "Recorded. Mission Control takes it from here and ends this review; stop now.";
export const FINDINGS_NOT_A_REVIEW = "Not recorded: this run is not a review.";
export const FINDINGS_ALREADY =
  "Already recorded for this review; Mission Control ends it shortly.";
export const FINDINGS_DROPPED =
  "Not recorded: this review was dropped (the PR moved on, or the author's run stopped). Stop now.";
export const FINDINGS_FAIL_NEEDS_BLOCKING =
  "Not recorded: a fail verdict needs at least one Critical or Important finding. Add the finding, or pass the verdict.";
export const FINDINGS_BLOCKING_NEEDS_FAIL =
  "Not recorded: a Critical or Important finding needs a fail verdict (spec or quality).";
export const findingFileText = (n: number): string =>
  `Not recorded: finding ${n}'s file must be a repo-relative path of letters, digits, dot, underscore, hyphen and slash, with no .. part.`;

/** The author run's Activity row once a review is recorded. */
export const reviewedEventText = (
  retro: string,
  sha: string,
  blocking: number,
  minor: number,
): string => `${retro} reviewed ${sha.slice(0, 7)}: ${blocking} blocking, ${minor} minor`;

export const FIX_TEXT_MAX = 16_000;
/** The author's notes in RETRO's brief are cut to this many characters, newest kept. */
export const REVIEW_NOTES_MAX = 12_000;
export const REVIEW_INPUT_DIR = ".mc-review";
export const REVIEW_DIFF_FILE = ".mc-review/pr.diff";
export const REVIEW_SINCE_FILE = ".mc-review/since-last-review.diff";
/** The diff file is cut at this many bytes. */
export const REVIEW_DIFF_MAX = 1024 * 1024;
/** git's own output cap while reading a diff. */
export const REVIEW_DIFF_MAX_BUFFER = 64 * 1024 * 1024;
export const scratchName = (seatId: string, reviewId: number): string =>
  `${seatId}-review-${reviewId}`;
export const REVIEW_NOT_WANTED = "the review is no longer wanted";
export const notReviewSeatText = (call: string): string => `${call} is not a review seat`;
export const DIFF_CUT_LINE = "\n[cut at 1 MiB: read the changed files for the rest]\n";

/** RETRO's blocking findings as a numbered, implementable list for the author seat. */
export function fixText(i: {
  retro: string;
  sha: string;
  findings: readonly ReviewFinding[];
}): string {
  const ordered = BLOCKING_SEVERITIES.flatMap((s) => i.findings.filter((f) => f.severity === s));
  const n = ordered.length;
  const head = `${i.retro} reviewed ${i.sha.slice(0, 7)} and found ${n} ${n === 1 ? "issue" : "issues"} to fix before this PR can merge. Make each change below as written, commit with mc commit, then call mc report_evidence with a note that says what you changed for each number. If a fix is wrong, do not skip it silently: report with a note starting "Ruling:" that names the number and why; the operator will decide.`;
  const entries = ordered.map(
    (f, k) =>
      `${k + 1}. [${f.severity}] ${f.line === 0 ? f.file : `${f.file}:${f.line}`} — ${f.summary}\n   Why: ${f.scenario}\n   Fix: ${f.fix}`,
  );
  const more = (k: number): string => `…and ${k} more; the next review lists them again.`;
  const build = (kept: number): string => {
    const parts = [head, ""];
    if (kept > 0) parts.push(entries.slice(0, kept).join("\n\n"));
    if (kept < entries.length) {
      if (kept > 0) parts.push("");
      parts.push(more(entries.length - kept));
    }
    return parts.join("\n");
  };
  let kept = 0;
  while (kept < entries.length && build(kept + 1).length <= FIX_TEXT_MAX) kept++;
  return build(kept);
}

export const MINOR_HEADING = "## Minor findings (logged, not looped)";
export const MINOR_LISTED_MAX = 20;
export const MINOR_SUMMARY_SHOWN = 300;
export const minorIntro = (retro: string, sha: string): string =>
  `${retro} reviewed ${sha.slice(0, 7)}. These were logged, not sent back for fixing.`;
/** Whitespace runs become one space; a summary longer than MINOR_SUMMARY_SHOWN is cut to it, ending "…". */
export function minorLine(f: Pick<ReviewFinding, "file" | "line" | "summary">): string {
  const flat = f.summary.replace(/\s+/g, " ").trim();
  const shown =
    flat.length > MINOR_SUMMARY_SHOWN ? `${flat.slice(0, MINOR_SUMMARY_SHOWN - 1)}…` : flat;
  return `- \`${f.line === 0 ? f.file : `${f.file}:${f.line}`}\` — ${shown}`;
}
export const MINOR_WITHHELD =
  "- (one finding withheld: its text cannot be posted to GitHub; see Mission Control)";
export const minorMoreLine = (k: number): string => `- …and ${k} more in Mission Control`;
export const minorFallback = (retro: string, m: number): string =>
  `${retro} logged ${m} minor ${m === 1 ? "finding" : "findings"}; they are listed in Mission Control.`;

export const REVIEW_ROUNDS = 3;
export const REVIEW_ATTEMPTS = 2;

export const reviewQueuedText = (sha: string, retro: string): string =>
  `review of ${sha.slice(0, 7)} queued for ${retro}`;
export const reviewStartedText = (retro: string, sha: string): string =>
  `${retro} reviewing ${sha.slice(0, 7)}`;
export const reviewFailedText = (retro: string, sha: string, reason: string): string =>
  `${retro}'s review of ${sha.slice(0, 7)} failed: ${reason}`;
export const reviewDroppedText = (sha: string): string => `review of ${sha.slice(0, 7)} dropped`;
export const fixSentText = (n: number, call: string): string =>
  `sent ${n} ${n === 1 ? "finding" : "findings"} to ${call}`;
export const MINOR_POSTED = "minor findings listed in the PR body";
export const MINOR_CLEARED = "minor findings list removed from the PR body";
export const minorNotPostedText = (why: string): string =>
  `minor findings not listed in the PR body: ${why}`;
/** Activity keys: one per review and step. */
export const reviewEventKey = (authorRunId: string, reviewId: number, step: string): string =>
  `${authorRunId}:review:${reviewId}:${step}`;
export const REVIEW_TOKEN_BUDGET = 120_000;
export const REVIEW_RUN_MAX_MS = 60 * 60_000;

export interface ReviewFact {
  id: number;
  sha: string;
  epoch: number;
  attempt: number;
  state: ReviewState;
  blocking: number;
  minor: number;
  failure: string | null;
}

export interface LoopReviewFacts {
  /** The reviewer's call sign (RETRO-1). */
  retro: string;
  /** Every review row of this run, oldest first. */
  rows: ReviewFact[];
  /** The blocking findings of `currentReview` when it is reported with blocking > 0, in report order; else []. */
  findings: ReviewFinding[];
}

export const fixKey = (runId: string, epoch: number, reviewId: number): string =>
  `fix:${runId}:${epoch}:${reviewId}`;
export const readyNoteKey = (runId: string, sha: string): string => `ready:${runId}:${sha}`;
export const headMovedNoteKey = (runId: string, head: string): string =>
  `headmoved:${runId}:${head}`;

/** The newest row of this epoch for `sha` that is not superseded, else null. */
export function currentReview(
  rows: readonly ReviewFact[],
  epoch: number,
  sha: string,
): ReviewFact | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r !== undefined && r.epoch === epoch && r.sha === sha && r.state !== "superseded") return r;
  }
  return null;
}

/** The sha whose review `sha` carries, else null; a waived `from` is not carried. */
export function carriedFrom(
  carry: { from: string; to: string } | null | undefined,
  waivedSha: string | null | undefined,
  sha: string,
): string | null {
  if (!carry || carry.to !== sha || carry.from === sha) return null;
  return (waivedSha ?? null) === carry.from ? null : carry.from;
}

/** `sha`'s own current review, else `from`'s current review unless it failed; else null. */
export function reviewFor(
  rows: readonly ReviewFact[],
  epoch: number,
  sha: string,
  from: string | null,
): ReviewFact | null {
  const own = currentReview(rows, epoch, sha);
  if (own !== null || from === null) return own;
  const c = currentReview(rows, epoch, from);
  return c === null || c.state === "failed" ? null : c;
}

/** The commit status context the QA review sets (branch protection requires it). */
export const REVIEW_STATUS_CONTEXT = "mc/review";
export const REVIEW_STATUS_QUEUED = "QA review queued";
export const REVIEW_STATUS_RUNNING = "QA review running";
export const REVIEW_STATUS_PASSED = "QA review passed";
export const REVIEW_STATUS_BLOCKED = "QA review found blocking issues";
export const REVIEW_STATUS_WAIVED = "QA review waived by the operator";

export const carriedStatusText = (description: string, from: string): string =>
  `${description} (carried from ${from.slice(0, 7)}, main merged)`;

export type ReviewStatusState = "pending" | "success" | "failure";

export interface ReviewStatus {
  state: ReviewStatusState;
  description: string;
}

/** The mc/review status `sha` should carry, or null when there is none to set. */
export function reviewStatusOf(
  rows: readonly ReviewFact[],
  epoch: number,
  sha: string,
  waivedSha: string | null,
  from: string | null = null,
): ReviewStatus | null {
  if (waivedSha !== null && waivedSha === sha) {
    return { state: "success", description: REVIEW_STATUS_WAIVED };
  }
  const cur = reviewFor(rows, epoch, sha, from);
  if (cur === null) return null;
  const say = (state: ReviewStatusState, description: string): ReviewStatus => ({
    state,
    description: cur.sha !== sha ? carriedStatusText(description, cur.sha) : description,
  });
  switch (cur.state) {
    case "queued":
    case "starting":
      return say("pending", REVIEW_STATUS_QUEUED);
    case "running":
      return say("pending", REVIEW_STATUS_RUNNING);
    case "reported":
      return cur.blocking > 0
        ? say("failure", REVIEW_STATUS_BLOCKED)
        : say("success", REVIEW_STATUS_PASSED);
    default:
      return null;
  }
}

/** Rows of this epoch for `sha` in state failed. */
export function failedAttempts(rows: readonly ReviewFact[], epoch: number, sha: string): number {
  return rows.filter((r) => r.epoch === epoch && r.sha === sha && r.state === "failed").length;
}

/** 1 + the highest attempt of this epoch for `sha` (any state), or 1 when there is none. */
export function nextAttempt(rows: readonly ReviewFact[], epoch: number, sha: string): number {
  const attempts = rows.filter((r) => r.epoch === epoch && r.sha === sha).map((r) => r.attempt);
  return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
}

/** The claimed keys that start `fix:<runId>:<epoch>:`. */
export function fixesSent(
  claimed: Readonly<Record<string, number>>,
  runId: string,
  epoch: number,
): number {
  const prefix = `fix:${runId}:${epoch}:`;
  return Object.keys(claimed).filter((k) => k.startsWith(prefix)).length;
}

export const readyText = (
  ref: string,
  pr: number,
  retro: string,
  sha: string,
  minor: number,
): string =>
  `${ref}: PR #${pr} is ready to merge (CI passed and ${retro} found no blocking issues on ${sha.slice(0, 7)}${minor > 0 ? `; ${minor} minor ${minor === 1 ? "finding is" : "findings are"} listed in the PR body` : ""})`;
/** The ready note when the operator ruled on the CI failure on this sha: CI did not pass on it. */
export const readyRuledText = (ref: string, pr: number, retro: string, sha: string): string =>
  `${ref}: PR #${pr} is ready to merge: ruled on the CI failure on ${sha.slice(0, 7)}, and ${retro} found no blocking issues`;
export const readyWaivedText = (ref: string, pr: number, sha: string): string =>
  `${ref}: PR #${pr} is ready to merge (you waived the review findings on ${sha.slice(0, 7)})`;
/** The ready note in a merge workspace when the PR touches hard-rule files: the operator merges it. */
export const readyHardRuleText = (ref: string, pr: number, paths: readonly string[]): string =>
  `${ref}: PR #${pr} passed every check but touches hard-rule files (${paths.join(", ")}); merge it yourself`;
export const headMovedText = (ref: string, pr: number, head: string, pushed: string): string =>
  `${ref}: PR #${pr}'s head ${head.slice(0, 7)} is not the commit Mission Control pushed (${pushed.slice(0, 7)}); it is not reviewed, so check it before merging`;
export const reviewParkText = (retro: string, sha: string): string =>
  `${retro} found blocking issues in ${REVIEW_ROUNDS} reviews; the last on ${sha.slice(0, 7)}`;
export const reviewFailedParkText = (
  retro: string,
  sha: string,
  n: number,
  failure: string,
): string => `${retro}'s review of ${sha.slice(0, 7)} failed ${n} times; last: ${failure}`;
export const reviewRulingParkText = (call: string, retro: string, sha: string): string =>
  `${call} ruled on ${retro}'s findings on ${sha.slice(0, 7)} instead of fixing them; see its last report`;
export const REVIEW_RESUME_TEXT =
  "Carry on with your review of PR #{pr}: Mission Control restarted, or your rate limit has reset. When you are done, call mc report_findings.";
export const REVIEW_NUDGE_TEXT =
  "No findings reported yet for PR #{pr}. Finish the review and call mc report_findings with every finding and your verdict; with nothing to report, call it with an empty list and pass verdicts.";

export interface ReviewRunSnapshot {
  reviewRunId: string;
  prNumber: number;
  now: number;
  hubStartedAt: number;
  /** The review row's started_at. */
  startedAt: number;
  run: { startedAt: number; ended: { reason: string } | null; tokens: number };
  seat: {
    holdsRun: boolean;
    starting: boolean;
    state: SeatState;
    inTurn: boolean;
    lastTurnEndedAt: number | null;
    resumedAt: number | null;
    rateLimitedUntil: number | null;
  };
  claimed: Record<string, number>;
  lastEngineLineAt: number | null;
}

export type ReviewRunAction =
  | { kind: "send"; key: string; text: string }
  | { kind: "fail"; reason: string };

/** A running review run's next step: a line to its seat, or its failure. The first rule wins. */
export function reviewRunStep(s: ReviewRunSnapshot): ReviewRunAction | null {
  const { seat, run, claimed } = s;
  const id = s.reviewRunId;
  const free = (key: string): boolean => !(key in claimed);
  const text = (t: string): string => fillLoopText(t, { pr: String(s.prNumber) });

  if (run.ended !== null) {
    return { kind: "fail", reason: `the review run ended (${run.ended.reason})` };
  }
  if (!seat.holdsRun && !seat.starting) {
    return { kind: "fail", reason: "the review run lost its seat" };
  }
  if (run.tokens > REVIEW_TOKEN_BUDGET) {
    return { kind: "fail", reason: `over its ${REVIEW_TOKEN_BUDGET}-token budget` };
  }
  if (s.now - s.startedAt > REVIEW_RUN_MAX_MS && seat.state !== "parked") {
    return { kind: "fail", reason: `no findings after ${REVIEW_RUN_MAX_MS / 60_000} minutes` };
  }
  const nudgedAt = claimed[`rv-nudge:${id}`];
  if (
    nudgedAt !== undefined &&
    seat.state === "idle" &&
    !seat.inTurn &&
    seat.lastTurnEndedAt !== null &&
    seat.lastTurnEndedAt > nudgedAt
  ) {
    return { kind: "fail", reason: "stopped twice without reporting findings" };
  }
  if (seat.inTurn) return null;

  if (
    seat.resumedAt !== null &&
    seat.resumedAt >= s.hubStartedAt &&
    (seat.lastTurnEndedAt ?? 0) < seat.resumedAt
  ) {
    const key = `rv-resume:${id}:${s.hubStartedAt}`;
    if (free(key)) return { kind: "send", key, text: text(REVIEW_RESUME_TEXT) };
  }
  if (
    seat.state === "parked" &&
    (seat.rateLimitedUntil === null || s.now > seat.rateLimitedUntil)
  ) {
    const key = `rv-limit:${id}:${seat.rateLimitedUntil ?? Math.floor(s.now / RATE_LIMIT_RETRY_MS)}`;
    if (free(key)) return { kind: "send", key, text: text(REVIEW_RESUME_TEXT) };
  }
  if (
    seat.state === "idle" &&
    seat.lastTurnEndedAt !== null &&
    seat.lastTurnEndedAt > Math.max(run.startedAt, s.lastEngineLineAt ?? 0)
  ) {
    const key = `rv-nudge:${id}`;
    if (free(key)) return { kind: "send", key, text: text(REVIEW_NUDGE_TEXT) };
  }
  return null;
}
