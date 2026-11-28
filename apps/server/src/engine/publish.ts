/**
 * What the engine does to GitHub and the session clone for a looped run: the push, the draft PR
 * (`pushRun` and `openDraftPr`, called directly), a failed CI run's log excerpt, and the
 * hard-rule files a pushed sha touches. Nothing here throws for a refusal; it answers.
 */
import { realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ADDED_DEPENDENCIES_HEADING,
  AWAY_WRITES_REFUSED,
  type AwayDiff,
  addedDependenciesSection,
  CI_EXCERPT_LINES,
  CI_EXCERPT_MAX,
  type CiRerun,
  EVIDENCE_HEADING,
  globMatches,
  grantedPath,
  isProtectedPath,
  MC_PR_BODY_MAX,
  MC_PR_EDIT_FAILED,
  MC_PR_FAILED,
  MC_PR_TITLE_MAX,
  MC_PUSH_FAILED,
  MC_PUSH_FIRST,
  MINOR_HEADING,
  MINOR_LISTED_MAX,
  MINOR_WITHHELD,
  minorFallback,
  minorIntro,
  minorIssueBody,
  minorIssueTitle,
  minorLine,
  minorMoreLine,
  noteIsPartOf,
  parseMinorFindings,
  pathInArea,
  prClosesLine,
  prIsPartOf,
  prNotRunsText,
  prPartOfLine,
  REVIEW_STATUS_CONTEXT,
  type ReviewStatusState,
  type Run,
  STDERR_TEXT_MAX,
  withSection,
} from "@mc/core";
import { activeAway } from "../away.ts";
import { ownsHubFiles } from "../config.ts";
import { parseJson, rethrowJson } from "../json.ts";
import {
  COMMIT_ADD_PATHSPEC,
  editRunPrBody,
  issueOf,
  type McToolsDeps,
  openDraftPr,
  prTextProblem,
  pushRun,
  queued,
  RUN_BRANCH,
  readKnown,
  seatPlace,
  seatWroteBody,
  withEngineSection,
} from "../mcp/tools.ts";
import { WEB_AREA_LABEL } from "../preview/review.ts";
import { qaReportGitSummary } from "../qa/reports.ts";
import { addedDependencies, runDependencyAllowance } from "../repo/dependency-allowance.ts";
import { runPathGrants } from "../repo/path-grants.ts";
import {
  adminDirOf,
  CREW_GIT_SLOW_MS,
  gitIdentity,
  installAfterSync,
  MC_MERGE_AUTHOR,
  mainMergeArgs,
} from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { originHeads } from "../runtime/origin-heads.ts";
import { crewDir, crewPrBodyPath } from "../store/crew-paths.ts";
import { onlyHubMerges, yes } from "./hub-merges.ts";
import { mcSection, RepoRulesError } from "./rules.ts";

/** What a ciExcerpt says when no Actions run failed on the sha. */
export const NO_FAILED_RUN = "(no failed Actions run to read)";
/** What `rerunState` says when a run it was told of is not in the list gh gave. */
const RERUN_RUN_MISSING = "a re-run Actions run was not in the list gh gave";
/** What a ciExcerpt says when gh could not be read. */
export const CI_LOG_UNREADABLE = "(the CI log could not be read)";
/** What a ciExcerpt says when the failed runs printed nothing to read. */
export const EMPTY_LOG = "(the failed run's log was empty)";
/** The park reason when an earlier PR is open on the run's branch. */
export const EARLIER_PR_OPEN = "an earlier PR is open on this branch";
/** Why setReviewStatus did not set the status. */
export const REVIEW_STATUS_FAILED = "the mc/review status could not be set";
/** `gh run view --log-failed` may print this much. */
export const CI_LOG_MAX_BUFFER = 16 * 1024 * 1024;

/** Why a merge step was refused without trying. */
export const MERGE_NO_PR = "the run has no PR";
export const MERGE_NO_SEAT = "the run's seat is no longer configured";
export const MERGE_BAD_SHA = "not a commit sha";
/** Ready succeeded but its head could not be confirmed and restoring draft failed. */
export const READY_UNDO_FAILED = "the PR was marked ready but could not be restored to draft";
export const MERGE_HEAD_MOVED = "the PR's head is not the commit that passed the gate";
export const MERGE_CONFLICTING = "the PR conflicts with main";
/** The run's Activity line, once per head, when its merge waits for main to be merged in. */
export const MERGE_WAITS_ON_MAIN =
  "merge waits: the PR conflicts with main, so main is merged in first";
export const MERGE_PR_NOT_OPEN = "the PR is not open";
export const MERGE_NOT_RUN_BRANCH = "the branch is not this run's own";
export const MERGE_BRANCH_MOVED = "the branch has commits that were not merged";
export const MERGE_PR_NOT_RUNS =
  "the PR is not this run's own branch into the repo's default branch";
/** Why merging main into a run's branch was refused without a merge. */
export const UPDATE_NO_WORKTREE = "the run's worktree is not a worktree of the session clone";
export const UPDATE_MERGE_IN_PROGRESS = "a merge is already in progress in the run's worktree";
export const UPDATE_FAILED = "merging main into the branch failed";
export const UPDATE_UP_TO_DATE = "the branch already contains main";
export {
  gitIdentity,
  MC_FALLBACK_EMAIL,
  MC_MERGE_AUTHOR,
} from "../runtime/checkouts.ts";

export type PublishResult = { ok: true } | { ok: false; text: string; transient: boolean };
/** A fast-forward's answer; `installNote` is a refusal or failure of the install that followed it. */
export type FastForwardResult =
  | { ok: true; installNote?: string; commits?: number }
  | { ok: false; text: string; transient: boolean };
export type OpenPrResult =
  | {
      ok: true;
      prNumber: number | null;
      /** Null number because the branch tip is not the pushed commit: push, then try again. */
      tipMoved?: boolean;
    }
  | { ok: false; text: string; transient: boolean };

/** The merge gate's reads for one sha (see `RunLoop.gate`). */
export interface GateFacts {
  missionControlChanged?: boolean;
  mainSha: string;
  containsMain: boolean;
  hubOnly: boolean;
  strays: string[];
  /** Whether the head's diff against main changes the repo's web area. */
  webChanged: boolean;
}
export type GateResult =
  | { ok: true; facts: GateFacts }
  | { ok: false; text: string; transient: boolean };

/**
 * Merging main into a run's branch: `merged` (a new merge commit, recorded in run_commits),
 * `conflict` (the markers and MERGE_HEAD stay in the worktree), or `wait` (the worktree has
 * changes, so nothing was merged).
 */
export type UpdateBranchResult =
  | {
      ok: true;
      kind: "merged";
      sha: string;
      parent: string;
      prSame: boolean;
      installNote?: string;
    }
  | { ok: true; kind: "conflict"; files: string[] }
  | { ok: true; kind: "wait" }
  | { ok: false; text: string; transient: boolean };

export type RerunResult =
  | { ok: true; runs: CiRerun["runs"] }
  | { ok: false; text: string; transient: boolean };
export type RerunStateResult =
  | { ok: true; outcome: CiRerun["outcome"] }
  | { ok: false; text: string; transient: boolean };
/** A completed run with one of these conclusions did not fail. */
const NOT_FAILED_CONCLUSIONS = ["success", "skipped", "neutral"];
/** A run that failed, timed out or was cancelled has jobs to re-run. */
const needsRerun = (conclusion: unknown): boolean =>
  conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled";

/**
 * A PR diff without its index lines and hunk numbers, which a merge of main changes and the
 * change does not.
 */
export function prDiffKey(diff: string): string {
  return diff
    .split("\n")
    .filter((l) => !l.startsWith("index "))
    .map((l) => (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l) ? "@@" : l))
    .join("\n");
}

export interface ReviewPrSnapshot {
  state: "open" | "closed" | "merged";
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
}

/** origin's default branch and its tip, as one `ls-remote` read them. */
export interface OriginTip {
  defaultBranch: string;
  mainSha: string;
}

export interface Publisher {
  /** An authoritative read, independent of the collector's snapshot. */
  reviewPr(run: Run, number: number): Promise<ReviewPrSnapshot | null>;
  /** The pending merge in the registered worktree, or null when absent or unreadable. */
  mergeHead(run: Run, worktree: string): Promise<string | null>;
  mainTip(
    run: Run,
  ): Promise<{ ok: true; sha: string } | { ok: false; text: string; transient: boolean }>;
  awayDiff(run: Run, sha: string): Promise<AwayDiff | null>;
  isDescendant(run: Run, ancestor: string, head: string): Promise<boolean>;
  /**
   * Whether the pushes that took the run's branch from `ancestor` to `head` were all made by one of
   * `logins` or the account gh acts as, read from GitHub's push activity for the branch. False
   * when the read fails or the chain of pushes is not whole.
   */
  pushesFrom(run: Run, ancestor: string, head: string, logins: string[]): Promise<boolean>;
  /** A run has ended: what the publisher kept for it is let go. */
  runEnded(runId: string): void;
  /** Pushes the run's branch; "Already on origin" and "Nothing to push" are success. */
  push(run: Run): Promise<PublishResult>;
  /** Opens the run's draft PR, or finds the one it already opened. */
  openPr(run: Run, ticket: { issue: number; title: string }, note: string): Promise<OpenPrResult>;
  /** Rewrites the run's open PR body with RETRO's Minor findings (none: without the section). */
  postMinorFindings(
    run: Run,
    review: { id: number; sha: string; retro: string },
  ): Promise<PublishResult>;
  /** Sets (or, with null, removes) the evidence section of the run's open PR body. */
  setEvidenceSection(run: Run, section: string | null): Promise<PublishResult>;
  /** Sets the run's repo's mc/review commit status on `sha`. */
  setReviewStatus(
    run: Run,
    sha: string,
    state: ReviewStatusState,
    description: string,
  ): Promise<PublishResult>;
  /** The tail of the failed Actions logs for `sha`, as one line-safe text. */
  ciExcerpt(repo: string, sha: string): Promise<string>;
  /**
   * Re-runs the failed jobs of every failed, timed-out or cancelled Actions run on `sha`; the runs
   * re-run (none: nothing to re-run), "running" when a run on `sha` has not completed (nothing is
   * re-run; gh refuses a running run), or null when gh could not be read or refused.
   */
  rerunFailed(
    repo: string,
    sha: string,
  ): Promise<{ id: number; name: string }[] | null | "running">;
  /**
   * FLIGHT's re-run of a ruled sha: like `rerunFailed` (failed, timed-out or cancelled runs), but it
   * returns each run's attempt from before, so `rerunState` can tell the re-run from the first
   * run. NO_FAILED_RUN when none failed.
   */
  rerunRuling(repo: string, sha: string): Promise<RerunResult>;
  /** What those re-runs came to: pending until each run is on a later attempt and completed. */
  rerunState(repo: string, sha: string, runs: CiRerun["runs"]): Promise<RerunStateResult>;
  /** Hard-rule paths against a persisted base, a merge first parent, or main. */
  hardRuleTouches(
    run: Run,
    sha: string,
    hardRules: readonly string[],
    mergeCommitSha?: string,
    baseSha?: string,
  ): Promise<string[]>;
  /** origin's default branch and tip now (one `ls-remote`), for a caller that shares it across runs. */
  originTip(
    run: Run,
  ): Promise<({ ok: true } & OriginTip) | { ok: false; text: string; transient: boolean }>;
  /**
   * The merge gate's reads for `sha`. origin's tip is read every call unless `tip` (a read the
   * caller shares) is given; when `known` is for the same sha and tip, it is returned without the
   * rest of the reads.
   */
  gateFacts(
    run: Run,
    sha: string,
    known?: (Omit<GateFacts, "webChanged"> & { sha: string; webChanged?: boolean }) | null,
    tip?: OriginTip,
  ): Promise<GateResult>;
  /**
   * Merges `mainSha` into the run's branch in `worktree` (the seat's, or the aside run's), never by
   * moving the ref: a checked-out worktree's index would go stale.
   */
  updateBranch(run: Run, mainSha: string, worktree: string): Promise<UpdateBranchResult>;
  /**
   * The paths in `worktree` that a commit would take but has not (what `updateBranch` waits on);
   * a refusal when the worktree cannot be read.
   */
  worktreeChanges(run: Run, worktree: string): Promise<string[] | Refusal>;
  /**
   * Fast-forwards `worktree` to `sha`, a commit someone else pushed on top of the run's push
   * (fetching it when needed). A worktree that is not behind `sha` on the same line, or that
   * the move would overwrite, is left as it is and refused.
   */
  fastForward(run: Run, worktree: string, sha: string): Promise<FastForwardResult>;
  /** Marks the run's PR ready for review (`gh pr ready`). */
  markReady(run: Run, expectedSha?: string): Promise<PublishResult>;
  markDraft(run: Run): Promise<PublishResult>;
  /** Merges the run's PR with a merge commit, only if its head is `sha`. */
  merge(run: Run, sha: string): Promise<PublishResult>;
  /** Closes the run's issue as completed, if the merge did not. */
  closeIssue(run: Run): Promise<PublishResult & { left?: boolean }>;
  fileMinorFindings(
    run: Run,
    prNumber: number,
    techDebtIssue?: number,
  ): Promise<PublishResult & { issueNumber?: number }>;
  /** Deletes origin's copy of the run's branch, only if its tip is `sha`. */
  deleteRemoteBranch(run: Run, sha: string): Promise<PublishResult>;
  /** Deletes the run's local branch, when its tip is the merged sha or already in main. */
  deleteLocalBranch(run: Run): Promise<PublishResult>;
  /** Whether the run's local branch no longer exists; false when that cannot be read. */
  localBranchGone(run: Run): Promise<boolean>;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const chr = (code: number): string => String.fromCharCode(code);
const ESC = chr(0x1b);
const BEL = chr(0x07);
// the 8-bit forms of the introducers, and the string terminator
const [C1_DCS, C1_SOS, C1_CSI, C1_ST, C1_OSC, C1_PM, C1_APC] = [
  chr(0x90),
  chr(0x98),
  chr(0x9b),
  chr(0x9c),
  chr(0x9d),
  chr(0x9e),
  chr(0x9f),
];
/**
 * Escape sequences, whole, in the order they are taken out: operating-system commands (links,
 * titles; BEL or ST ends them), device-control, start-of-string, privacy and application strings
 * (ST ends them), CSI (colour and cursor; any parameter, intermediate and final bytes), sequences
 * with intermediates (charset), and the single-character ones that remain (Fp, Fe, Fs).
 */
const ESCAPES = [
  new RegExp(`(?:${ESC}\\]|${C1_OSC})[^${BEL}${ESC}${C1_ST}]*(?:${BEL}|${ESC}\\\\|${C1_ST})`, "g"),
  new RegExp(
    `(?:${ESC}[PX^_]|[${C1_DCS}${C1_SOS}${C1_PM}${C1_APC}])[^${ESC}${C1_ST}]*(?:${ESC}\\\\|${C1_ST})`,
    "g",
  ),
  new RegExp(`(?:${ESC}\\[|${C1_CSI})[0-?]*[ -/]*[@-~]`, "g"),
  new RegExp(`${ESC}[ -/]+[0-~]`, "g"),
  new RegExp(`${ESC}[0-~]`, "g"),
];

/**
 * `text` without escape sequences and control characters, C1 ones too (a newline and a tab stay).
 */
export function cleanLog(text: string): string {
  let plain = text;
  for (const re of ESCAPES) plain = plain.replace(re, "");
  let out = "";
  for (const ch of plain.replace(/\r\n?/g, "\n")) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f)) out += ch;
    else if (ch === "\n" || ch === "\t") out += ch;
  }
  return out;
}

const SEPARATOR = "\n\n";
const SEPARATOR_BYTES = SEPARATOR.length;
/** A run's name is cut here before it heads its section. */
const RUN_NAME_MAX = 100;
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** The last `max` bytes of `text`, not starting inside a character. */
function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  return bytes
    .subarray(bytes.length - max)
    .toString("utf8")
    .replace(/^�+/, "");
}

/** The job that only reports whether the others passed: its lines never stand ahead of theirs. */
export const CI_SUMMARY_JOB = "check";
/** A failure as vitest prints it, at the start of the line: never a passing test or code line that says FAIL. */
const FAIL_LINE = /^(?:FAIL|FAILED)\b/;
/** The error line under a failure: an assertion or a typed error. */
const ERROR_LINE = /AssertionError|\b\w*Error:/;
/** A type or lint error, a failure by itself. */
const CHECK_ERROR = /\berror TS\d+|^\d+:\d+\s+error\s/;
/** A failed assertion's line vitest prints before its Failed Tests section. */
const CROSS_LINE = /^[×✗✕]\s/;
/** The time vitest prints after a `×` line's test name. */
const DURATION_TAIL = /\s+\d+(?:\.\d+)?m?s$/;
/** The error message vitest prints under a `×` line. */
const ARROW_LINE = /^→\s/;
/** A failing test as Playwright's list reporter numbers it: `1) [chromium] › e2e/a.spec.ts:12:5 › title`. */
const PLAYWRIGHT_LINE = /^\d+\) \[[^\]]+\] › /;
/** How many lines of its error follow a Playwright failure or a `×` line. */
const TEST_ERROR_LINES = 10;
/** A line that opens (or ends) a block of a test's console output. */
const STREAM_LINE = /^(?:stderr|stdout) \|/;
const BLOCK_END = /^(?:[✓×✗✕❯↓]|FAIL\b|RUN\b|Test Files|Tests\s|Duration)/;
const NOT_A_CAUSE = /Process completed with exit code/;
/** A stack frame vitest prints under a failure's assertion: `❯ [fn] path/to/file.ts:1550:30`. */
const SOURCE_LINE = /^❯\s+(?:\S+\s+)?\S+:\d+:\d+$/;
/** The heading of vitest's block of errors no test owns: no failure above it reaches into it. */
const UNHANDLED_LINE = /\bUnhandled (?:Errors?|Rejection)\b/;
/** How far under a FAIL line its error line is looked for. */
const ERROR_WINDOW = 6;
/** How far under a FAIL line its source line is looked for: a diff may sit between. */
const SOURCE_WINDOW = 60;
/** One failing line is cut here. */
const FAILING_LINE_MAX = 300;
/** A job's failing lines are kept up to this many, then its last lines follow. */
const FAILING_LINES_MAX = 100;
/** How many of a job's last lines follow its failing lines. */
const CONTEXT_LINES = 10;
/** `gh run view --log-failed` lines: job, step, then the text behind a timestamp. */
const LOG_LINE = /^([^\t]*)\t[^\t]*\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?(.*)$/;

/** A Biome diagnostic's header: the file, position and rule, ending in a rule of box characters. */
const BIOME_HEADER = /^\S+(?::\d+:\d+)? \S+.*━{3}/;

type JobLines = {
  /** A FAIL line with the error lines under it, or a type or lint error alone. */
  entries: string[][];
  /** `×` lines (each with the `→` lines under it) and Biome headers, in log order. */
  marks: string[][];
  /** Each `×` unit by its test's name, `a > adds` of `× a > adds 5ms`. */
  crosses: Map<string, string[]>;
  /** Bare errors and console output. */
  noise: string[];
  rest: string[];
  fails: number;
};
type Group = {
  job: string;
  entries: string[][];
  marks: string[][];
  noise: string[];
  rest: string[];
  /** Failing lines past FAILING_LINES_MAX, not kept at all. */
  dropped: number;
};
type Tier = {
  name: string;
  units: (g: Group) => string[][];
  shown: string[][][];
};

/** What a job's omitted failing lines are told as. */
const omittedText = (n: number, job: string): string =>
  `[${n} more failing lines${job === "" ? "" : ` in ${job}`} not shown; inspect the CI log.]`;

/**
 * The part of a failed run's log a seat is shown, at most `max` bytes. Ranked across every job:
 * first each job's first failure (a FAIL name with the error lines under it, led by the same test's
 * `×` line and its `→` lines when the log printed them, or a type error), then
 * the rest of the failures, jobs taking turns; then (only for a job without a FAIL line) its `×`
 * lines and Biome diagnostics; then bare errors and console output; then each job's last lines. A
 * job's lines keep their log order under its `[job]` label. Failing lines left out are counted in
 * a closing line. A log without any failing line is its last lines alone. The summary job stands
 * aside when another job has lines.
 */
export function ciLogBody(log: string, max: number): string {
  const jobs = new Map<string, JobLines>();
  const cut = (t: string) => Array.from(t).slice(0, FAILING_LINE_MAX).join("");
  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  // a set per list: a log may hold hundreds of thousands of distinct console lines
  const sets = new Map<string[], Set<string>>();
  const addOnce = (list: string[], line: string) => {
    const held = sets.get(list) ?? new Set<string>();
    sets.set(list, held);
    if (held.has(line)) return;
    held.add(line);
    list.push(line);
  };
  let open: string[] | null = null;
  let sinceFail = 0;
  // lines since the open FAIL line, and whether its source line is already kept
  let sinceOpen = 0;
  let sourced = false;
  let stream = false;
  // lines still to keep under the open Playwright failure, and under the open `×` line
  let testLeft = 0;
  let mark: string[] | null = null;
  let markLeft = 0;
  let lastJob: string | null = null;
  for (const raw of log.split("\n")) {
    const m = LOG_LINE.exec(raw);
    const job = m === null ? "" : (m[1] ?? "");
    const text = (m === null ? raw : (m[2] ?? "")).trim();
    if (text === "") continue;
    const g = jobs.get(job) ?? {
      entries: [],
      marks: [],
      crosses: new Map(),
      noise: [],
      rest: [],
      fails: 0,
    };
    jobs.set(job, g);
    // a FAIL line's error window and a console block end where the job's lines do
    if (job !== lastJob) {
      open = null;
      stream = false;
      testLeft = 0;
      mark = null;
      lastJob = job;
    }
    if (STREAM_LINE.test(text)) stream = true;
    else if (BLOCK_END.test(text)) stream = false;
    if (NOT_A_CAUSE.test(text)) continue;
    if (UNHANDLED_LINE.test(text)) open = null;
    const line = cut(text);
    if (mark !== null && markLeft > 0 && ARROW_LINE.test(text)) {
      mark.push(line);
      markLeft--;
      continue;
    }
    mark = null;
    if (PLAYWRIGHT_LINE.test(text)) {
      stream = false;
      // a failure Playwright numbers once: its header and the first lines of its error
      open = once(`${job}\t${line}`) ? [line] : null;
      testLeft = open === null ? 0 : TEST_ERROR_LINES;
      if (open !== null) {
        g.entries.push(open);
        g.fails++;
      }
      continue;
    }
    if (open !== null && testLeft > 0 && !FAIL_LINE.test(text)) {
      open.push(line);
      testLeft--;
      continue;
    }
    testLeft = 0;
    if (FAIL_LINE.test(text)) {
      stream = false;
      // a name printed twice (at the failure and in the summary) keeps its first error lines
      if (once(`${job}\t${line}`)) {
        open = [line];
        g.entries.push(open);
        g.fails++;
        sinceFail = 0;
        sinceOpen = 0;
        sourced = false;
      } else open = null;
    } else if (
      open !== null &&
      !stream &&
      !sourced &&
      sinceOpen < SOURCE_WINDOW &&
      SOURCE_LINE.test(text)
    ) {
      // the failing test's own line, so the seat sees where the assertion sits
      open.push(line);
      sourced = true;
      sinceOpen++;
    } else if (open !== null && !stream && sinceFail < ERROR_WINDOW && ERROR_LINE.test(text)) {
      // under its FAIL line even when another test failed with the same words
      open.push(line);
      sinceFail++;
      sinceOpen++;
    } else {
      sinceFail++;
      sinceOpen++;
      if (CHECK_ERROR.test(text)) {
        if (once(`${job}\t${line}`)) g.entries.push([line]);
      } else if (CROSS_LINE.test(text) || BIOME_HEADER.test(text)) {
        if (once(`${job}\t${line}`)) {
          const unit = [line];
          g.marks.push(unit);
          if (CROSS_LINE.test(text)) {
            mark = unit;
            markLeft = TEST_ERROR_LINES;
            const name = text.replace(CROSS_LINE, "").replace(DURATION_TAIL, "").trim();
            if (!g.crosses.has(name)) g.crosses.set(name, unit);
          }
        }
      } else if (stream || ERROR_LINE.test(text)) addOnce(g.noise, line);
      else g.rest.push(text);
    }
  }
  if (jobs.size > 1) jobs.delete(CI_SUMMARY_JOB);
  const groups: Group[] = [...jobs.entries()]
    .map(([job, g]) => {
      // a job's failing units, kept whole up to FAILING_LINES_MAX lines
      const capped = (units: string[][]): string[][] => {
        const out: string[][] = [];
        let kept = 0;
        for (const u of units) {
          kept += u.length;
          if (kept > FAILING_LINES_MAX) break;
          out.push(u);
        }
        return out;
      };
      // a FAIL block takes its test's `×` unit ahead of it, so the test is told once with both
      const merged = g.entries.map((e) => {
        const head = e[0] ?? "";
        if (!FAIL_LINE.test(head)) return e;
        const parts = head.replace(FAIL_LINE, "").trim().split(" > ");
        for (let i = 0; i < parts.length; i++) {
          const name = parts.slice(i).join(" > ");
          const cross = g.crosses.get(name);
          if (cross === undefined) continue;
          g.crosses.delete(name);
          return [...cross, ...e];
        }
        return e;
      });
      const allMarks = g.fails > 0 ? [] : g.marks;
      const marks = capped(allMarks);
      const entries = capped(merged);
      const dropped =
        merged.flat().length -
        entries.flat().length +
        (allMarks.flat().length - marks.flat().length);
      const failing = g.entries.length + marks.length > 0;
      return {
        job,
        dropped,
        entries,
        marks,
        noise: g.noise,
        rest: g.rest.slice(-(failing ? CONTEXT_LINES : CI_EXCERPT_LINES)),
      };
    })
    .sort((a, b) => b.entries.length - a.entries.length);
  const failingOf = (x: Group) => x.entries.length + x.marks.length;
  if (!groups.some((x) => failingOf(x) > 0)) {
    // the last lines of the jobs still standing: the summary job's stay out of it
    const kept = log
      .trimEnd()
      .split("\n")
      .filter((raw) => jobs.has(LOG_LINE.exec(raw)?.[1] ?? "") && !NOT_A_CAUSE.test(raw));
    return tailBytes(kept.slice(-CI_EXCERPT_LINES).join("\n"), max);
  }
  const named = groups.length > 1 || groups[0]?.job !== "";
  const label = (job: string, tier: string) =>
    named && job !== "" ? `[${job}${tier === "" ? "" : `: ${tier}`}]` : null;

  // room kept for each job's notice of what was left out
  let budget = max;
  for (const x of groups) {
    if (failingOf(x) > 0) budget -= byteLength(omittedText(99999, x.job)) + 1;
  }
  // too little room for any notice: the lines get it all, and no notice is added
  if (budget < 0) budget = max;
  const tiers: Tier[] = [
    { name: "", units: (x) => x.entries, shown: groups.map(() => []) },
    {
      name: "",
      units: (x) => x.marks,
      shown: groups.map(() => []),
    },
    {
      name: "console",
      units: (x) => x.noise.map((l) => [l]),
      shown: groups.map(() => []),
    },
    {
      name: "last lines",
      units: (x) => x.rest.map((l) => [l]),
      shown: groups.map(() => []),
    },
  ];
  const take = (t: Tier, gi: number, unit: string[]): boolean => {
    const x = groups[gi] as Group;
    const shown = t.shown[gi] as string[][];
    let cost = unit.reduce((n, l) => n + byteLength(l) + 1, 0);
    // a section's label is paid for with its first unit
    const lab = label(x.job, t.name);
    if (lab !== null && shown.length === 0) cost += byteLength(lab) + 1;
    if (cost > budget) return false;
    budget -= cost;
    shown.push(unit);
    return true;
  };
  // jobs take turns, one unit each: the first failure of every job, then the rest, then each
  // lower tier; a job that stops fitting is closed for its tier
  const fill = (t: Tier, from: number) => {
    const closed = new Set<number>();
    const lists = groups.map((x) => t.units(x));
    for (let i = from; ; i++) {
      let any = false;
      for (let gi = 0; gi < groups.length; gi++) {
        const unit = lists[gi]?.[i];
        if (closed.has(gi) || unit === undefined) continue;
        any = true;
        if (!take(t, gi, unit)) closed.add(gi);
      }
      if (!any) break;
    }
  };
  const tier0 = tiers[0] as Tier;
  // the first failure of every job, before any job's second
  groups.forEach((x, gi) => {
    const first = x.entries[0];
    if (first !== undefined) take(tier0, gi, first);
  });
  fill(tier0, 1);
  for (const t of tiers.slice(1)) fill(t, 0);

  const out: string[] = [];
  for (const t of tiers) {
    groups.forEach((x, gi) => {
      const lines = (t.shown[gi] as string[][]).flat();
      if (lines.length === 0) return;
      const lab = label(x.job, t.name);
      if (lab !== null) out.push(lab);
      out.push(...lines);
    });
  }
  groups.forEach((x, gi) => {
    const total = x.entries.flat().length + x.marks.flat().length + x.dropped;
    const shown =
      (tier0.shown[gi] as string[][]).flat().length +
      ((tiers[1] as Tier).shown[gi] as string[][]).flat().length;
    const note = omittedText(total - shown, x.job);
    // a notice only when it fits: the body never goes past `max`
    if (total > shown && byteLength(`${out.join("\n")}\n${note}`) <= max) out.push(note);
  });
  return out.join("\n");
}

/** The run's PR body as the hub writes it; `section` goes between "What changed" and the closing line ("Part of #n." when the note says so). */
export function runPrBody(
  ticket: { issue: number; title: string },
  note: string,
  section: string | null,
  withTitle: boolean,
): string {
  const end = noteIsPartOf(note, ticket.issue)
    ? prPartOfLine(ticket.issue)
    : prClosesLine(ticket.issue);
  const heading = `#${ticket.issue}${withTitle ? ` — ${ticket.title}` : ""}`;
  const extra = section === null ? "" : `${section}\n\n`;
  const around = `${heading}\n\n## What changed\n\n\n\n${extra}${end}`;
  const room = Math.max(0, MC_PR_BODY_MAX - around.length);
  // the note is cut, never the closing line, to keep the body inside what GitHub takes
  const shown = note.length > room ? `${note.slice(0, Math.max(0, room - 1))}…` : note;
  return `${heading}\n\n## What changed\n\n${shown}\n\n${extra}${end}`;
}

/** Each repo's last merge call: merges in one repo run one at a time. */
const mergeQueue = new Map<string, Promise<unknown>>();

type Refusal = { ok: false; text: string; transient: boolean };
const final = (text: string): Refusal => ({
  ok: false,
  text,
  transient: false,
});
const transient = (text: string): Refusal => ({
  ok: false,
  text,
  transient: true,
});
const errText = (e: unknown): string =>
  Array.from(cleanLog(e instanceof Error ? e.message : String(e)).trim())
    .slice(0, STDERR_TEXT_MAX)
    .join("");

const globMatchesAny = (globs: readonly string[], path: string): boolean =>
  globs.some((g) => globMatches(g, path));

export function createPublisher(deps: McToolsDeps): Publisher {
  const cwd = () => crewDir(deps.dbPath);
  const repoOf = (run: Run): string | undefined =>
    deps.config.repos.find((r) => r.id === run.repoId)?.github;

  type G = (a: string[]) => Promise<string>;

  /** Runs `fn` with git in the run's session clone, in its queue; a git failure is a transient refusal. */
  async function inGit<T extends { ok: boolean }>(
    run: Run,
    fn: (g: G, place: NonNullable<ReturnType<typeof seatPlace>>) => Promise<T>,
  ): Promise<T | Refusal> {
    const place = seatPlace(deps.config, run.agentId);
    if (place === null) return final(MERGE_NO_SEAT);
    const git = deps.git ?? crewGit;
    const checkout = place.session.checkout;
    try {
      return await deps.inClone(checkout, async () => {
        const common = await realpath(join(checkout, ".git"));
        const g: G = (a) =>
          git(checkout, a, common, {
            gitDir: common,
            timeoutMs: CREW_GIT_SLOW_MS,
          });
        return fn(g, place);
      });
    } catch (e) {
      return transient(`git failed: ${errText(e)}`);
    }
  }

  const ghFailed = (what: string, stderr: string): Refusal => {
    const why = Array.from(cleanLog(stderr).trim()).slice(0, STDERR_TEXT_MAX).join("");
    return transient(why === "" ? `gh ${what} failed` : `gh ${what} failed: ${why}`);
  };

  /**
   * `gh issue view` reports a deleted or mistyped issue as GraphQL's "Could not resolve to an issue or
   * pull request with the number of N" (gh 2.95), or as an HTTP 404 from the REST path.
   */
  const ghNotFound = (stderr: string): boolean =>
    /\bHTTP 404: Not Found\b|Could not resolve to an issue(?: or pull request)? with the number of/i.test(
      cleanLog(stderr),
    );

  /** gh's answer as a JSON object, or a transient refusal naming the call. */
  async function ghJson(args: string[], what: string): Promise<Record<string, unknown> | Refusal> {
    const r = await deps.gh(args, { cwd: cwd() });
    if (r.code !== 0) return ghFailed(what, r.stderr);
    try {
      const parsed: unknown = parseJson<unknown>(r.stdout, undefined, rethrowJson);
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // falls through
    }
    return transient(`gh ${what} gave no JSON`);
  }

  async function ghDo(args: string[], what: string): Promise<PublishResult> {
    const r = await deps.gh(args, { cwd: cwd() });
    return r.code === 0 ? { ok: true } : ghFailed(what, r.stderr);
  }

  const isRefusal = (x: object): x is Refusal => "ok" in x && x.ok === false;

  /** The Actions runs on `sha`, with `fields` read from `gh run list`; a transient refusal when gh gives none. */
  async function actionsRuns(
    repo: string,
    sha: string,
    fields: string,
  ): Promise<{ id: number; status: string; conclusion: string; attempt: number }[] | Refusal> {
    const listed = await deps.gh(
      ["run", "list", `--repo=${repo}`, `--commit=${sha}`, `--json=${fields}`],
      { cwd: cwd() },
    );
    if (listed.code !== 0) return ghFailed("run list", listed.stderr);
    let parsed: unknown;
    try {
      parsed = parseJson<unknown>(listed.stdout, undefined, rethrowJson);
    } catch {
      return transient("gh run list gave no JSON");
    }
    if (!Array.isArray(parsed)) return transient("gh run list gave no JSON");
    return parsed.flatMap((r: unknown) => {
      const x = r as Record<string, unknown> | null;
      return typeof x?.databaseId === "number" &&
        Number.isSafeInteger(x.databaseId) &&
        typeof x.attempt === "number"
        ? [
            {
              id: x.databaseId,
              status: typeof x.status === "string" ? x.status : "",
              conclusion: typeof x.conclusion === "string" ? x.conclusion : "",
              attempt: x.attempt,
            },
          ]
        : [];
    });
  }

  /** git's exit code 1 is an answer ("no"), anything else is a failure. */
  /** Whether the clone has commit `sha` (rev-parse exits 1 when not; `cat-file -e` exits 128). */
  const have = (g: G, sha: string) => yes(g, ["rev-parse", "-q", "--verify", `${sha}^{commit}`]);

  /** origin's default branch and tip, and `branch`'s tip, now (never a local ref). */
  async function originNow(g: G, branch: string | null) {
    const heads = originHeads(
      await g([
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
        ...(branch === null ? [] : [`refs/heads/${branch}`]),
      ]),
      branch,
    );
    return {
      defaultBranch: heads.defaultBranch,
      mainSha: heads.defaultSha,
      branchSha: heads.branchSha,
    };
  }

  /** Fetches origin's default branch when the clone lacks its tip. */
  async function fetchMain(g: G, defaultBranch: string, mainSha: string): Promise<void> {
    if (await have(g, mainSha)) return;
    await g(["fetch", "--no-tags", "origin", `refs/heads/${defaultBranch}`]);
    if (!(await have(g, mainSha))) throw new Error("origin's tip could not be fetched");
  }

  /** The run's branch when it is of the run's shape for its issue, else null. */
  function ownBranch(run: Run): string | null {
    const issue = issueOf(run);
    const m = run.branch === null ? null : RUN_BRANCH.exec(run.branch);
    if (run.branch === null || m === null || issue === null || Number(m[1]) !== issue) return null;
    return run.branch;
  }

  /** The open PRs on the branch with the tickets each closes, or null when gh could not say. */
  async function openOnBranch(
    repo: string,
    branch: string,
  ): Promise<
    | {
        number: number;
        createdAt: number;
        closes: number[];
        partOf: number[];
      }[]
    | null
  > {
    const listed = await deps.gh(
      [
        "pr",
        "list",
        `--repo=${repo}`,
        `--head=${branch}`,
        "--state=open",
        "--json=number,createdAt,closingIssuesReferences,body",
      ],
      { cwd: cwd() },
    );
    if (listed.code !== 0) return null;
    let parsed: unknown;
    try {
      parsed = parseJson<unknown>(listed.stdout, undefined, rethrowJson);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out: {
      number: number;
      createdAt: number;
      closes: number[];
      partOf: number[];
    }[] = [];
    for (const p of parsed) {
      const n = (p as { number?: unknown } | null)?.number;
      const at = Date.parse(String((p as { createdAt?: unknown } | null)?.createdAt));
      if (typeof n === "number" && Number.isSafeInteger(n) && !Number.isNaN(at)) {
        const refs = (p as { closingIssuesReferences?: unknown }).closingIssuesReferences;
        const closes = Array.isArray(refs)
          ? refs
              .filter((x) => {
                const url = (x as { url?: unknown } | null)?.url;
                // only an issue of this repository: another repository's #7 is not this ticket
                return (
                  typeof url === "string" &&
                  url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/issues/`)
                );
              })
              .map((x) => (x as { number?: unknown }).number)
              .filter((x): x is number => typeof x === "number")
          : [];
        const body = (p as { body?: unknown }).body;
        const partOf =
          typeof body === "string"
            ? [...body.matchAll(/(?<![A-Za-z0-9])part of #(\d+)(?!\d|\w)/gi)].map((m) =>
                Number(m[1]),
              )
            : [];
        out.push({ number: n, createdAt: at, closes, partOf });
      }
    }
    return out;
  }

  /** The jobs of a run that have already failed; none when gh could not say. */
  async function failedJobs(repo: string, runId: number): Promise<{ id: number; name: string }[]> {
    const viewed = await deps.gh(["run", "view", `--repo=${repo}`, String(runId), "--json=jobs"], {
      cwd: cwd(),
    });
    if (viewed.code !== 0) return [];
    const parsed = parseJson<{ jobs?: unknown } | null>(viewed.stdout, null);
    if (!Array.isArray(parsed?.jobs)) return [];
    return parsed.jobs.flatMap((j: unknown) => {
      const x = j as {
        databaseId?: unknown;
        name?: unknown;
        conclusion?: unknown;
      } | null;
      return x !== null &&
        x.conclusion === "failure" &&
        typeof x.databaseId === "number" &&
        Number.isSafeInteger(x.databaseId)
        ? [
            {
              id: x.databaseId,
              name: cleanLog(String(x.name ?? "job")).replace(/[\t\r\n]+/g, " "),
            },
          ]
        : [];
    });
  }

  /** A failed run's `--log-failed`, or null when gh could not read it. */
  async function failedLog(
    repo: string,
    f: { id: number; attempt: number | null },
  ): Promise<string | null> {
    const viewed = await deps.gh(
      [
        "run",
        "view",
        `--repo=${repo}`,
        String(f.id),
        ...(f.attempt === null ? [] : [`--attempt=${f.attempt}`]),
        "--log-failed",
      ],
      { cwd: cwd(), maxBuffer: CI_LOG_MAX_BUFFER },
    );
    return viewed.code === 0 ? viewed.stdout : null;
  }

  /**
   * The logs of failed jobs, each line led by its job's name as `--log-failed` leads it; a job whose
   * log could not be read is a line saying so. Null only when there are no jobs.
   */
  async function jobsLog(
    repo: string,
    jobs: { id: number; name: string }[],
  ): Promise<string | null> {
    const lines: string[] = [];
    for (const j of jobs) {
      const got = await deps.gh(["api", `repos/${repo}/actions/jobs/${j.id}/logs`], {
        cwd: cwd(),
        maxBuffer: CI_LOG_MAX_BUFFER,
      });
      if (got.code !== 0) {
        // a job whose log could not be read is said so, not left out
        lines.push(`${j.name}\t-\t[the log of job ${j.name} could not be read]`);
        continue;
      }
      for (const l of got.stdout.split("\n")) lines.push(`${j.name}\t-\t${l}`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /** `run:sha` of heads `isDescendant` could not fetch, and when; asked for again after a pause. */
  const unfetchable = new Map<string, number>();
  const FETCH_RETRY_MS = 30_000;
  /** `run:push:head` to whether the pushes between them were all by an allowed account. */
  const pushChains = new Map<string, { ok: boolean; at: number }>();
  /** The login gh acts as, once read. */
  let ghUser: string | undefined;
  async function ghLogin(): Promise<string[]> {
    if (ghUser === undefined) {
      const me = await ghJson(["api", "user"], "user");
      if (!isRefusal(me) && typeof me.login === "string") ghUser = me.login;
    }
    return ghUser === undefined ? [] : [ghUser];
  }
  return {
    async push(run) {
      const r = await pushRun(deps, run.id);
      if (r.isError !== true) return { ok: true };
      return { ok: false, text: r.text, transient: r.text === MC_PUSH_FAILED };
    },

    async openPr(run, ticket, note) {
      const repo = deps.config.repos.find((r) => r.id === run.repoId)?.github;
      if (repo === undefined || run.branch === null) {
        return { ok: false, text: MC_PR_FAILED, transient: false };
      }
      const open = await openOnBranch(repo, run.branch);
      if (open === null) return { ok: false, text: MC_PR_FAILED, transient: true };
      const mine = open.find((p) => p.createdAt >= run.startedAt);
      if (mine !== undefined) return { ok: true, prNumber: mine.number };
      // A ticket passes from run to run (restart, reassignment, handover) and the branch stays. A
      // run adopts the open PR an earlier ended run on the same ticket recorded, however many
      // runs back, while no other run on the ticket is live. It never adopts a
      // PR merely because it happens to be open on that branch.
      const onTicket = deps.store.runsOnTicket(run.repoId, run.ticket ?? "");
      const othersLive = onTicket.some((other) => other.id !== run.id && other.endedAt === null);
      const adopted = othersLive
        ? undefined
        : open.find((p) =>
            onTicket.some(
              (earlier) =>
                earlier.id !== run.id &&
                earlier.branch === run.branch &&
                earlier.startedAt < run.startedAt &&
                earlier.endedAt !== null &&
                earlier.endedAt <= run.startedAt &&
                earlier.loop?.prNumber === p.number,
            ),
          );
      if (adopted !== undefined) return { ok: true, prNumber: adopted.number };
      // A PR opened outside any run (by the controller, or by a seat with no run) has no run
      // that recorded it. It is this run's when it is the only one open on the branch, it closes
      // or says "Part of" this run's ticket, and no other run on the ticket has recorded it.
      const lone = open.length === 1 ? open[0] : undefined;
      const issue = issueOf(run);
      if (
        lone !== undefined &&
        issue !== null &&
        (lone.closes.includes(issue) || lone.partOf.includes(issue)) &&
        !deps.store
          .runsOnTicket(run.repoId, run.ticket ?? "")
          .some((other) => other.id !== run.id && other.loop?.prNumber === lone.number)
      ) {
        return { ok: true, prNumber: lone.number };
      }
      if (open.length > 0) return { ok: false, text: EARLIER_PR_OPEN, transient: false };

      const known = await readKnown(deps, "draft_pr");
      const own = { repo, issue: ticket.issue, known };
      const heading = `#${ticket.issue}`;
      const withTitle = `${heading} ${ticket.title}`.slice(0, MC_PR_TITLE_MAX);
      const added = addedDependenciesSection(addedDependencies(deps.store, run.id));
      const titled = {
        title: withTitle,
        body: runPrBody(ticket, note, added, true),
      };
      const flagged =
        prTextProblem(titled.title, { ...own, label: "PR title" }) !== null ||
        prTextProblem(titled.body, { ...own, label: "PR body" }) !== null;
      const pr = flagged ? { title: heading, body: runPrBody(ticket, note, added, false) } : titled;

      const made = await openDraftPr(deps, run.id, pr);
      if (made.isError === true) {
        // The branch moved past the push (a commit made since): not a refusal. The next pass
        // pushes the new tip and tries again.
        if (made.text === MC_PUSH_FIRST) return { ok: true, prNumber: null, tipMoved: true };
        return {
          ok: false,
          text: made.text,
          transient: made.text === MC_PR_FAILED,
        };
      }
      const url = /\/pull\/(\d+)/.exec(made.text);
      if (url?.[1] !== undefined) return { ok: true, prNumber: Number(url[1]) };
      const after = await openOnBranch(repo, run.branch);
      const found = after?.find((p) => p.createdAt >= run.startedAt);
      return { ok: true, prNumber: found?.number ?? null };
    },

    async postMinorFindings(run, review) {
      const prNumber = run.loop?.prNumber ?? null;
      const repo = deps.config.repos.find((r) => r.id === run.repoId)?.github;
      const issue = issueOf(run);
      if (prNumber === null || repo === undefined || issue === null) {
        return { ok: false, text: prNotRunsText(0), transient: false };
      }
      const note = deps.store.latestEvidence(run.id)?.note ?? "";
      const title = run.ticketTitle ?? deps.store.boardItem(run.repoId, issue)?.title ?? "";
      const ticket = { issue, title };
      const known = await readKnown(deps, "pr_body");
      const own = { repo, issue, known, label: "PR body", unclosed: true };
      // decided as openPr decides it: from the title and a body with no section
      const flagged =
        prTextProblem(`#${issue} ${title}`.slice(0, MC_PR_TITLE_MAX), {
          ...own,
          label: "PR title",
          unclosed: false,
        }) !== null ||
        prTextProblem(runPrBody(ticket, note, null, true), {
          ...own,
          unclosed: false,
        }) !== null;
      const withTitle = !flagged;

      const minors = deps.store.findingsOf(review.id).filter((f) => f.severity === "Minor");
      const lines = minors
        .slice(0, MINOR_LISTED_MAX)
        .map((f) => (prTextProblem(minorLine(f), own) !== null ? MINOR_WITHHELD : minorLine(f)));
      if (minors.length > MINOR_LISTED_MAX) {
        lines.push(minorMoreLine(minors.length - MINOR_LISTED_MAX));
      }
      let section =
        minors.length === 0
          ? null
          : [MINOR_HEADING, "", minorIntro(review.retro, review.sha), "", ...lines].join("\n");
      if (prTextProblem(runPrBody(ticket, note, section, withTitle), own) !== null) {
        section = [MINOR_HEADING, "", minorFallback(review.retro, minors.length)].join("\n");
      }
      const evidence = deps.prEvidenceSection?.(run) ?? null;
      const report = deps.store.qaReportForReview(review.id);
      const reportSection = report ? qaReportGitSummary(report, deps.qaReportBaseUrl) : null;
      const added = addedDependenciesSection(addedDependencies(deps.store, run.id));
      const sections = [added, section, evidence, reportSection].filter(
        (x): x is string => x !== null,
      );
      const combined = sections.length === 0 ? null : sections.join("\n\n");
      const body = runPrBody(ticket, note, combined, withTitle);
      // a body the seat rewrote with pr_body keeps its text; only the hub's section is replaced
      const r = await editRunPrBody(deps, run.id, prNumber, (current) =>
        seatWroteBody(current, issue)
          ? withEngineSection(
              withSection(
                withSection(current, EVIDENCE_HEADING, null),
                ADDED_DEPENDENCIES_HEADING,
                null,
              ),
              issue,
              combined,
              noteIsPartOf(note, issue),
            )
          : body,
      );
      if (r.isError === true) {
        return {
          ok: false,
          text: r.text,
          transient: r.text === MC_PR_EDIT_FAILED,
        };
      }
      return { ok: true };
    },

    async setEvidenceSection(run, section) {
      const prNumber = run.loop?.prNumber ?? null;
      const repo = repoOf(run);
      if (prNumber === null || repo === undefined) {
        return { ok: false, text: prNotRunsText(0), transient: false };
      }
      const r = await editRunPrBody(deps, run.id, prNumber, (body) => {
        const current = body
          .replace(/\r\n/g, "\n")
          .replace(/\n*Opened by [^\n]* \(Mission Control\)\.\s*$/, "")
          .trimEnd();
        return withSection(current, EVIDENCE_HEADING, section);
      });
      if (r.isError === true) {
        return {
          ok: false,
          text: r.text,
          transient: r.text === MC_PR_EDIT_FAILED,
        };
      }
      return { ok: true };
    },

    async setReviewStatus(run, sha, state, description) {
      const repo = deps.config.repos.find((r) => r.id === run.repoId)?.github;
      if (repo === undefined || !SHA.test(sha)) {
        return { ok: false, text: REVIEW_STATUS_FAILED, transient: false };
      }
      const r = await deps.gh(
        [
          "api",
          `repos/${repo}/statuses/${sha}`,
          "-f",
          `state=${state}`,
          "-f",
          `context=${REVIEW_STATUS_CONTEXT}`,
          "-f",
          `description=${description}`,
        ],
        { cwd: cwd() },
      );
      if (r.code !== 0) {
        const why = Array.from(cleanLog(r.stderr).trim()).slice(0, STDERR_TEXT_MAX).join("");
        return {
          ok: false,
          text: why === "" ? REVIEW_STATUS_FAILED : `${REVIEW_STATUS_FAILED}: ${why}`,
          transient: true,
        };
      }
      return { ok: true };
    },

    async ciExcerpt(repo, sha) {
      try {
        const listed = await deps.gh(
          [
            "run",
            "list",
            `--repo=${repo}`,
            `--commit=${sha}`,
            "--json=databaseId,name,conclusion,status,attempt",
          ],
          { cwd: cwd() },
        );
        if (listed.code !== 0) return CI_LOG_UNREADABLE;
        const runs: unknown = parseJson<unknown>(listed.stdout, undefined, rethrowJson);
        if (!Array.isArray(runs)) return CI_LOG_UNREADABLE;
        const failed: {
          id: number;
          name: string;
          attempt: number | null;
          /** The attempt read is the one before a re-run that is still going or was cancelled. */
          rerun: "going" | "cancelled" | null;
          /** The failed jobs of a run still going: its own log is not readable until it completes. */
          jobs?: { id: number; name: string }[];
        }[] = [];
        for (const r of runs) {
          const x = r as {
            databaseId?: unknown;
            name?: unknown;
            conclusion?: unknown;
            status?: unknown;
            attempt?: unknown;
          } | null;
          if (
            x === null ||
            typeof x.databaseId !== "number" ||
            !Number.isSafeInteger(x.databaseId)
          ) {
            continue;
          }
          const name = typeof x.name === "string" ? x.name : "CI";
          const attempt =
            typeof x.attempt === "number" && Number.isSafeInteger(x.attempt) && x.attempt > 0
              ? x.attempt
              : null;
          if (x.conclusion === "failure") {
            failed.push({ id: x.databaseId, name, attempt, rerun: null });
            continue;
          }
          const going = typeof x.status === "string" && x.status !== "completed";
          // a completed run that neither failed nor was cancelled has nothing to read
          if (!going && x.conclusion !== "cancelled") continue;
          if (x.status === "in_progress") {
            // one shard can fail while the rest of the run goes on: gh's --log-failed reads nothing
            // until the run completes, but a finished job's own log can be read now. A re-run's own
            // failed job comes before the attempt it re-runs. (A queued or waiting run has no job
            // that finished.)
            const jobs = await failedJobs(repo, x.databaseId);
            if (jobs.length > 0) {
              failed.push({ id: x.databaseId, name, attempt, rerun: null, jobs });
              continue;
            }
          }
          if (attempt === null || attempt <= 1) continue;
          // a re-run going, or cancelled, has no failure of its own: the attempt before it may be
          // the one that failed, but a re-run can also start from a green attempt
          const before = await deps.gh(
            [
              "run",
              "view",
              `--repo=${repo}`,
              String(x.databaseId),
              `--attempt=${attempt - 1}`,
              "--json=conclusion",
            ],
            { cwd: cwd() },
          );
          if (before.code !== 0) return CI_LOG_UNREADABLE;
          const state: unknown = parseJson<unknown>(before.stdout, undefined, rethrowJson);
          if ((state as { conclusion?: unknown } | null)?.conclusion === "failure") {
            failed.push({
              id: x.databaseId,
              name,
              attempt: attempt - 1,
              rerun: going ? "going" : "cancelled",
            });
          }
        }
        if (failed.length === 0) return NO_FAILED_RUN;
        const headOf = (f: (typeof failed)[number]): string => {
          const name = cleanLog(f.name).slice(0, RUN_NAME_MAX);
          if (f.jobs !== undefined)
            return f.attempt === null
              ? `${name} (still running)`
              : `${name} (attempt ${f.attempt}, still running)`;
          if (f.attempt === null) return name;
          if (f.rerun === "going")
            return `${name} (attempt ${f.attempt}, which failed; a re-run is going)`;
          if (f.rerun === "cancelled")
            return `${name} (attempt ${f.attempt}, which failed; its re-run was cancelled)`;
          return `${name} (attempt ${f.attempt})`;
        };
        // bytes, not characters: what is left of CI_EXCERPT_MAX, separators and headers included
        let budget = CI_EXCERPT_MAX;
        const sections: string[] = [];
        for (const f of failed) {
          const spare = budget - (sections.length > 0 ? SEPARATOR_BYTES : 0);
          if (spare <= 0) break;
          const head = `${headOf(f)}:\n`;
          // each run left gets an equal part of what is left; what one does not use passes on
          const left = failed.length - failed.indexOf(f);
          const room = Math.floor(spare / left) - byteLength(head);
          if (room <= 0) continue; // no room for a header with anything under it
          const log = f.jobs === undefined ? await failedLog(repo, f) : await jobsLog(repo, f.jobs);
          if (log === null) return CI_LOG_UNREADABLE;
          const body = ciLogBody(cleanLog(log).trimEnd(), room);
          if (body === "") continue;
          const section = head + body;
          budget -= byteLength(section) + (sections.length > 0 ? SEPARATOR_BYTES : 0);
          sections.push(section);
        }
        return sections.length === 0 ? EMPTY_LOG : sections.join(SEPARATOR);
      } catch {
        return CI_LOG_UNREADABLE;
      }
    },

    async rerunFailed(repo, sha) {
      if (!SHA.test(sha)) return null;
      try {
        const listed = await deps.gh(
          [
            "run",
            "list",
            `--repo=${repo}`,
            `--commit=${sha}`,
            "--json=databaseId,name,conclusion,status",
          ],
          { cwd: cwd() },
        );
        if (listed.code !== 0) return null;
        const runs: unknown = parseJson<unknown>(listed.stdout, undefined, rethrowJson);
        if (!Array.isArray(runs)) return null;
        if (runs.some((r: unknown) => (r as { status?: unknown } | null)?.status !== "completed")) {
          return "running";
        }
        const failed = runs.flatMap((r: unknown) => {
          const x = r as {
            databaseId?: unknown;
            name?: unknown;
            conclusion?: unknown;
          } | null;
          return x !== null &&
            needsRerun(x.conclusion) &&
            typeof x.databaseId === "number" &&
            Number.isSafeInteger(x.databaseId)
            ? [
                {
                  id: x.databaseId,
                  name: cleanLog(String(x.name ?? "CI")).slice(0, RUN_NAME_MAX),
                },
              ]
            : [];
        });
        const done: { id: number; name: string }[] = [];
        for (const f of failed) {
          const r = await deps.gh(["run", "rerun", `--repo=${repo}`, String(f.id), "--failed"], {
            cwd: cwd(),
          });
          if (r.code !== 0) return done.length === 0 ? null : done;
          done.push(f);
        }
        return done;
      } catch {
        return null;
      }
    },

    async rerunRuling(repo, sha) {
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      const listed = await actionsRuns(repo, sha, "databaseId,conclusion,attempt");
      if (isRefusal(listed)) return listed;
      const failed = listed.filter((r) => needsRerun(r.conclusion));
      if (failed.length === 0) return final(NO_FAILED_RUN);
      const done: CiRerun["runs"] = [];
      for (const r of failed) {
        const rerun = await deps.gh(["run", "rerun", `--repo=${repo}`, String(r.id), "--failed"], {
          cwd: cwd(),
        });
        // the runs already re-run are returned, so the caller records the re-run and never repeats
        // it; a failure before any run was re-run is a refusal
        if (rerun.code !== 0) {
          return done.length > 0 ? { ok: true, runs: done } : ghFailed("run rerun", rerun.stderr);
        }
        done.push({ id: r.id, attempt: r.attempt });
      }
      return { ok: true, runs: done };
    },

    async rerunState(repo, sha, saved) {
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      const listed = await actionsRuns(repo, sha, "databaseId,status,conclusion,attempt");
      if (isRefusal(listed)) return listed;
      const now = saved.map((s) => ({
        s,
        r: listed.find((r) => r.id === s.id),
      }));
      if (now.some((x) => x.r === undefined)) return transient(RERUN_RUN_MISSING);
      const runs = now.flatMap((x) => (x.r === undefined ? [] : [{ ...x.r, was: x.s.attempt }]));
      if (runs.some((r) => r.attempt <= r.was || r.status !== "completed")) {
        return { ok: true, outcome: "pending" };
      }
      // a failed run that was not re-run (its re-run was refused) means CI still fails
      const failed =
        runs.some((r) => !NOT_FAILED_CONCLUSIONS.includes(r.conclusion)) ||
        listed.some((r) => !saved.some((s) => s.id === r.id) && needsRerun(r.conclusion));
      return { ok: true, outcome: failed ? "failed" : "passed" };
    },

    async awayDiff(run, sha) {
      if (!SHA.test(sha)) return null;
      const result = await inGit(run, async (g) => {
        const base = (await g(["merge-base", "refs/remotes/origin/HEAD", sha])).trim();
        if (!SHA.test(base)) throw new Error("no merge base with origin/HEAD");
        const fields = (
          await g(["diff", "--name-status", "-z", "--no-renames", base, sha, "--"])
        ).split("\0");
        if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("unreadable diff");
        const changes: AwayDiff["changes"] = [];
        for (let i = 0; i < fields.length; i += 2) {
          const status = fields[i];
          const path = fields[i + 1];
          if (!status || !path) throw new Error("unreadable diff path");
          changes.push({ status, path });
        }
        return { ok: true as const, diff: { base, changes } };
      });
      return result.ok ? result.diff : null;
    },

    async isDescendant(run, ancestor, head) {
      if (!SHA.test(ancestor) || !SHA.test(head)) return false;
      const result = await inGit(run, async (g) => {
        // a commit someone else pushed is not in the clone yet
        // (one that could not be fetched is asked for again after a short pause, not every poll)
        const key = `${run.id}:${head}`;
        const nowMs = (deps.now ?? Date.now)();
        const failedAt = unfetchable.get(key);
        if (
          !(await have(g, head)) &&
          (failedAt === undefined || nowMs - failedAt >= FETCH_RETRY_MS)
        ) {
          const got = await g(["fetch", "--no-tags", "origin", head]).then(
            () => true,
            () => false,
          );
          if (got) unfetchable.delete(key);
          else unfetchable.set(key, nowMs);
        }
        return {
          ok: true as const,
          descends: await yes(g, ["merge-base", "--is-ancestor", ancestor, head]),
        };
      });
      return result.ok && result.descends;
    },

    async pushesFrom(run, ancestor, head, logins) {
      const repo = repoOf(run);
      const branch = ownBranch(run);
      if (repo === undefined || branch === null || !SHA.test(ancestor) || !SHA.test(head))
        return false;
      // A proven chain does not change. A "no" may be GitHub's activity lagging behind the PR
      // poll, so it is kept only for a short pause and then read again; a failed read is not kept.
      const key = `${run.id}:${ancestor}:${head}`;
      const nowMs = (deps.now ?? Date.now)();
      const known = pushChains.get(key);
      if (known !== undefined && (known.ok || nowMs - known.at < FETCH_RETRY_MS)) return known.ok;
      const listed = await ghJson(
        [
          "api",
          `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=push&per_page=100`,
        ],
        "activity",
      );
      if (isRefusal(listed) || !Array.isArray(listed)) return false;
      // the account gh acts as is always the operator's, whatever aliases are configured
      const allowed = [...logins, ...(await ghLogin())].map((l) => l.toLowerCase());
      if (allowed.length === 0) return false;
      type Push = {
        before?: unknown;
        after?: unknown;
        actor?: { login?: unknown } | null;
      };
      const pushes = listed as Push[];
      // Who pushed is GitHub's own record; a commit's committer or author is whatever its maker
      // wrote. The head follows the push only when every push from the run's own to the head was
      // made by an allowed account.
      let tip = head;
      let ok = false;
      for (let hops = 0; hops <= pushes.length; hops++) {
        if (tip === ancestor) {
          ok = true;
          break;
        }
        const push = pushes.find((p) => p.after === tip);
        const actor = push?.actor?.login;
        if (
          push === undefined ||
          typeof actor !== "string" ||
          !allowed.includes(actor.toLowerCase()) ||
          typeof push.before !== "string"
        )
          break;
        tip = push.before;
      }
      pushChains.set(key, { ok, at: nowMs });
      return ok;
    },

    runEnded(runId) {
      const prefix = `${runId}:`;
      for (const key of [...unfetchable.keys()])
        if (key.startsWith(prefix)) unfetchable.delete(key);
      for (const key of [...pushChains.keys()]) if (key.startsWith(prefix)) pushChains.delete(key);
    },

    async reviewPr(run, number) {
      const repo = repoOf(run);
      if (repo === undefined) return null;
      const pr = await ghJson(
        [
          "pr",
          "view",
          String(number),
          `--repo=${repo}`,
          "--json",
          "state,headRefOid,baseRefOid,mergeCommit",
        ],
        "pr view",
      );
      if (isRefusal(pr)) return null;
      const state =
        pr.state === "OPEN"
          ? "open"
          : pr.state === "MERGED"
            ? "merged"
            : pr.state === "CLOSED"
              ? "closed"
              : null;
      const merge = (pr.mergeCommit as { oid?: unknown } | null)?.oid;
      if (
        state === null ||
        typeof pr.headRefOid !== "string" ||
        !SHA.test(pr.headRefOid) ||
        typeof pr.baseRefOid !== "string" ||
        !SHA.test(pr.baseRefOid) ||
        (state === "merged" && (typeof merge !== "string" || !SHA.test(merge)))
      )
        return null;
      return {
        state,
        headSha: pr.headRefOid,
        baseSha: pr.baseRefOid,
        mergeCommitSha: typeof merge === "string" ? merge : null,
      };
    },

    async hardRuleTouches(run, sha, hardRules, mergeCommitSha, baseSha) {
      const place = seatPlace(deps.config, run.agentId);
      if (baseSha !== undefined && !SHA.test(baseSha)) throw new Error("invalid diff base");
      if (mergeCommitSha !== undefined && !SHA.test(mergeCommitSha))
        throw new Error("invalid merge commit");
      if (place === null || !SHA.test(sha) || hardRules.length === 0) return [];
      const git = deps.git ?? crewGit;
      const checkout = place.session.checkout;
      return deps.inClone(checkout, async () => {
        const common = await realpath(join(checkout, ".git"));
        const g = (a: string[]) =>
          git(checkout, a, common, {
            gitDir: common,
            timeoutMs: CREW_GIT_SLOW_MS,
          });
        for (const commit of new Set(
          [sha, mergeCommitSha ?? baseSha].filter((value): value is string => value !== undefined),
        )) {
          if (await have(g, commit)) continue;
          await g(["fetch", "--no-tags", "origin", commit]);
          if (!(await have(g, commit))) throw new Error("diff input could not be fetched");
        }
        const base = (
          await g([
            "merge-base",
            mergeCommitSha ? `${mergeCommitSha}^1` : (baseSha ?? "refs/remotes/origin/HEAD"),
            sha,
          ])
        ).trim();
        if (!SHA.test(base)) throw new Error("no merge base with origin/HEAD");
        const names = (await g(["diff", "--name-only", "-z", "--no-renames", base, sha, "--"]))
          .split("\0")
          .filter((p) => p !== "");
        return names.filter((p) => hardRules.some((rule) => globMatches(rule, p, true)));
      });
    },

    originTip(run) {
      return inGit(run, async (g) => {
        const { defaultBranch, mainSha } = await originNow(g, null);
        return { ok: true, defaultBranch, mainSha };
      });
    },

    async gateFacts(run, sha, known, tip) {
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      return inGit(run, async (g, { seat }): Promise<GateResult> => {
        const { defaultBranch, mainSha } = tip ?? (await originNow(g, null));
        if (known?.sha === sha && known.mainSha === mainSha && known.webChanged !== undefined) {
          const { containsMain, hubOnly, strays, missionControlChanged, webChanged } = known;
          return {
            ok: true,
            facts: {
              mainSha,
              containsMain,
              hubOnly,
              strays: [...strays],
              webChanged,
              ...(missionControlChanged === undefined ? {} : { missionControlChanged }),
            },
          };
        }
        await fetchMain(g, defaultBranch, mainSha);
        const containsMain = await yes(g, ["merge-base", "--is-ancestor", mainSha, sha]);
        const mine = deps.store.branchCommits(run.repoId, run.branch ?? "");
        const ahead = (await g(["rev-list", sha, "--not", mainSha]))
          .split("\n")
          .filter((l) => l !== "");
        const hubOnly = ahead.every((c) => mine.has(c));
        const base = (await g(["merge-base", mainSha, sha])).trim();
        if (!SHA.test(base)) throw new Error("no merge base with origin's default branch");
        const names = (await g(["diff", "--name-only", "-z", "--no-renames", base, sha, "--"]))
          .split("\0")
          .filter((p) => p !== "");
        let missionControlChanged: boolean | undefined;
        if (names.some((p) => p.toLowerCase() === "claude.md")) {
          missionControlChanged = true;
          try {
            const readClaude = async (commit: string): Promise<string | null> => {
              try {
                await g(["cat-file", "-e", `${commit}:CLAUDE.md`]);
              } catch (e) {
                const error = e as { code?: unknown; stderr?: unknown } | null;
                if (
                  error?.code === 128 &&
                  typeof error.stderr === "string" &&
                  error.stderr.includes("path 'CLAUDE.md' does not exist in")
                )
                  return null;
                throw e;
              }
              return g(["show", `${commit}:CLAUDE.md`]);
            };
            const before = await readClaude(base);
            const after = await readClaude(sha);
            missionControlChanged = mcSection(before ?? "") !== mcSection(after ?? "");
          } catch {
            /* an unreadable rules block stays protected */
          }
        }
        // the repo's own web area; `apps/web/**` is only the default on the repo the hub runs from
        const configured = await deps.rules?.(run.repoId);
        const areaGlobs =
          configured === undefined || configured instanceof RepoRulesError
            ? []
            : (configured.areas[WEB_AREA_LABEL] ?? []);
        const webGlobs =
          areaGlobs.length > 0
            ? areaGlobs
            : ownsHubFiles(deps.config, run.repoId)
              ? ["apps/web", "apps/web/**"]
              : [];
        const extra = deps.config.repos.find((r) => r.id === run.repoId)?.protectedFiles ?? [];
        // the dependency allowance's files went through the commit tool's check of what they add
        const grants = [
          ...runPathGrants(deps.store, run.id),
          ...runDependencyAllowance(deps.store, run.id).files,
        ];
        const strays = names.filter(
          (p) =>
            !grantedPath(grants, p) && (!pathInArea(seat.area, p) || isProtectedPath(p, extra)),
        );
        return {
          ok: true,
          facts: {
            mainSha,
            containsMain,
            hubOnly,
            strays,
            webChanged: names.some((p) => globMatchesAny(webGlobs, p)),
            ...(missionControlChanged === undefined ? {} : { missionControlChanged }),
          },
        };
      });
    },

    async mergeHead(run, worktree) {
      const place = seatPlace(deps.config, run.agentId);
      if (place === null) return null;
      try {
        const common = await realpath(join(place.session.checkout, ".git"));
        const gitDir = await adminDirOf(common, worktree);
        if (gitDir === null) return null;
        return (
          await (deps.git ?? crewGit)(
            worktree,
            ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
            common,
            { gitDir },
          )
        ).trim();
      } catch {
        return null;
      }
    },

    mainTip(run) {
      return inGit(run, async (g) => ({
        ok: true,
        sha: (await originNow(g, null)).mainSha,
      }));
    },

    async updateBranch(run, mainSha, worktree) {
      const branch = ownBranch(run);
      if (branch === null) return final(MERGE_NOT_RUN_BRANCH);
      if (!SHA.test(mainSha)) return final(MERGE_BAD_SHA);
      const place = seatPlace(deps.config, run.agentId);
      if (place === null) return final(MERGE_NO_SEAT);
      const git = deps.git ?? crewGit;
      const checkout = place.session.checkout;
      try {
        return await deps.inClone(checkout, async (): Promise<UpdateBranchResult> => {
          const common = await realpath(join(checkout, ".git"));
          // the worktree's git dir as the clone registered it: never as the worktree's pointer says
          const gitDir = await adminDirOf(common, worktree);
          if (gitDir === null) return final(UPDATE_NO_WORKTREE);
          const g: G = (a) =>
            git(checkout, a, common, {
              gitDir: common,
              timeoutMs: CREW_GIT_SLOW_MS,
            });
          const w = (a: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
            git(worktree, a, common, {
              gitDir,
              timeoutMs: CREW_GIT_SLOW_MS,
              env,
            });
          const unmerged = async (): Promise<string[]> =>
            (await w(["diff", "--name-only", "--diff-filter=U", "-z"]))
              .split("\0")
              .filter((p) => p !== "");

          const head = await w(["symbolic-ref", "--quiet", "HEAD"]).then(
            (s) => s.trim(),
            () => null, // detached
          );
          if (head !== `refs/heads/${branch}`) return final(MERGE_NOT_RUN_BRANCH);
          const mergeHead = await w(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
            (s) => s.trim(),
            (e: unknown) => {
              if ((e as { code?: unknown } | null)?.code === 1) return null;
              throw e;
            },
          );
          if (mergeHead !== null) {
            // this merge's conflict, left by a pass whose answer was lost: report it again
            const files = mergeHead === mainSha ? await unmerged() : [];
            return files.length > 0
              ? { ok: true, kind: "conflict", files }
              : final(UPDATE_MERGE_IN_PROGRESS);
          }
          const status = await w([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            ...COMMIT_ADD_PATHSPEC,
          ]);
          if (status !== "") return { ok: true, kind: "wait" };

          const { defaultBranch } = await originNow(g, null);
          await fetchMain(g, defaultBranch, mainSha);
          const before = (await w(["rev-parse", "--verify", "HEAD"])).trim();
          // No branch-only commits remain: there is nothing to merge main into.
          if (await yes(g, ["merge-base", "--is-ancestor", before, mainSha])) {
            return transient(UPDATE_UP_TO_DATE);
          }
          try {
            await w(mainMergeArgs(branch, mainSha), gitIdentity(MC_MERGE_AUTHOR));
          } catch (e) {
            if ((e as { code?: unknown } | null)?.code === 1) {
              const files = await unmerged();
              if (files.length > 0) return { ok: true, kind: "conflict", files };
            }
            await w(["merge", "--abort"]).catch(() => {});
            return final(`${UPDATE_FAILED}: ${errText(e)}`);
          }
          const sha = (await w(["rev-parse", "--verify", "HEAD"])).trim();
          if (sha === before) return transient(UPDATE_UP_TO_DATE);
          deps.store.addRunCommit({
            runId: run.id,
            repoId: run.repoId,
            branch,
            sha,
            at: (deps.now ?? Date.now)(),
          });
          // the PR's own change, before and after: the same when the merge only brought main in
          let prSame = false;
          try {
            const b1 = (await g(["merge-base", mainSha, before])).trim();
            const diffOf = (base: string, tip: string): Promise<string> =>
              g([
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--full-index",
                "--binary",
                base,
                tip,
                "--",
              ]);
            prSame =
              SHA.test(b1) &&
              prDiffKey(await diffOf(b1, before)) === prDiffKey(await diffOf(mainSha, sha));
          } catch {
            prSame = false;
          }
          const installNote = await installAfterSync(
            checkout,
            {
              path: worktree,
              gitDir,
              branch,
              baseSha: mainSha,
            },
            before,
            deps.config.crew?.worktrees ?? "",
          );
          return {
            ok: true,
            kind: "merged",
            sha,
            parent: before,
            prSame,
            ...(installNote ? { installNote } : {}),
          };
        });
      } catch (e) {
        return transient(`git failed: ${errText(e)}`);
      }
    },

    async worktreeChanges(run, worktree) {
      const place = seatPlace(deps.config, run.agentId);
      if (place === null) return final(MERGE_NO_SEAT);
      const git = deps.git ?? crewGit;
      const checkout = place.session.checkout;
      try {
        return await deps.inClone(checkout, async (): Promise<string[] | Refusal> => {
          const common = await realpath(join(checkout, ".git"));
          const gitDir = await adminDirOf(common, worktree);
          if (gitDir === null) return final(UPDATE_NO_WORKTREE);
          const status = await git(
            worktree,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...COMMIT_ADD_PATHSPEC],
            common,
            { gitDir, timeoutMs: CREW_GIT_SLOW_MS },
          );
          const paths: string[] = [];
          const entries = status.split("\0");
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i] ?? "";
            if (e === "") continue;
            paths.push(e.slice(3));
            // a rename or copy is followed by the path it came from
            if (e[0] === "R" || e[0] === "C") i++;
          }
          return paths;
        });
      } catch (e) {
        return transient(`git failed: ${errText(e)}`);
      }
    },

    async fastForward(run, worktree, sha) {
      if (!SHA.test(sha)) return final("not a commit sha");
      const branch = run.branch;
      if (branch === null) return final(MERGE_NOT_RUN_BRANCH);
      const place = seatPlace(deps.config, run.agentId);
      if (place === null) return final(MERGE_NO_SEAT);
      const git = deps.git ?? crewGit;
      const checkout = place.session.checkout;
      try {
        return await deps.inClone(checkout, async (): Promise<FastForwardResult> => {
          const common = await realpath(join(checkout, ".git"));
          const gitDir = await adminDirOf(common, worktree);
          if (gitDir === null) return final(UPDATE_NO_WORKTREE);
          const g: G = (a) => git(worktree, a, common, { gitDir, timeoutMs: CREW_GIT_SLOW_MS });
          // only the run's own branch moves; another branch, or a detached HEAD, is left alone
          const head = await g(["symbolic-ref", "--quiet", "HEAD"]).then(
            (s) => s.trim(),
            () => null,
          );
          if (head !== `refs/heads/${branch}`) {
            return final(MERGE_NOT_RUN_BRANCH);
          }
          if (!(await have(g, sha))) await g(["fetch", "--no-tags", "origin", sha]);
          if (!(await have(g, sha))) return final("the new commit could not be fetched");
          if (!(await yes(g, ["merge-base", "--is-ancestor", "HEAD", sha]))) {
            return final("the branch has diverged from the PR's head; it was not changed");
          }
          const before = (await g(["rev-parse", "--verify", "HEAD"])).trim();
          await g(["merge", "--ff-only", "--quiet", sha]);
          // the moved-in commits may change the lockfile: the worktree's install follows them
          const gc: G = (a) =>
            git(checkout, a, common, {
              gitDir: common,
              timeoutMs: CREW_GIT_SLOW_MS,
            });
          let installNote: string | undefined;
          try {
            const { defaultBranch, mainSha } = await originNow(gc, null);
            await fetchMain(gc, defaultBranch, mainSha);
            installNote = await installAfterSync(
              checkout,
              {
                path: worktree,
                gitDir,
                branch,
                baseSha: mainSha,
              },
              before,
              deps.config.crew?.worktrees ?? "",
            );
          } catch (e) {
            installNote = `dependencies may have changed; install not run: ${errText(e)}`;
          }
          const counted = Number((await g(["rev-list", "--count", `${before}..${sha}`])).trim());
          return {
            ok: true,
            ...(Number.isSafeInteger(counted) ? { commits: counted } : {}),
            ...(installNote ? { installNote } : {}),
          };
        });
      } catch (e) {
        return transient(`git failed: ${errText(e)}`);
      }
    },

    async markReady(run, expectedSha) {
      const repo = repoOf(run);
      const n = run.loop?.prNumber ?? null;
      if (repo === undefined || n === null) return final(MERGE_NO_PR);
      if (expectedSha !== undefined) {
        const pr = await ghJson(
          ["pr", "view", String(n), `--repo=${repo}`, "--json", "state,headRefOid"],
          "pr view",
        );
        if (isRefusal(pr)) return pr;
        if (pr.state !== "OPEN") return final(MERGE_PR_NOT_OPEN);
        if (pr.headRefOid !== expectedSha) return final(MERGE_HEAD_MOVED);
      }
      const ready = await ghDo(["pr", "ready", String(n), `--repo=${repo}`], "pr ready");
      if (!ready.ok || expectedSha === undefined) return ready;
      const after = await ghJson(
        ["pr", "view", String(n), `--repo=${repo}`, "--json", "state,headRefOid"],
        "pr view",
      );
      if (isRefusal(after) || after.headRefOid !== expectedSha) {
        const undo = await ghDo(
          ["pr", "ready", String(n), `--repo=${repo}`, "--undo"],
          "pr ready --undo",
        );
        if (!undo.ok) return transient(READY_UNDO_FAILED);
        return isRefusal(after) ? after : final(MERGE_HEAD_MOVED);
      }
      return ready;
    },

    async markDraft(run) {
      const repo = repoOf(run);
      const n = run.loop?.prNumber ?? null;
      if (repo === undefined || n === null) return final(MERGE_NO_PR);
      return ghDo(["pr", "ready", String(n), `--repo=${repo}`, "--undo"], "pr ready --undo");
    },

    async merge(run, sha) {
      const repo = repoOf(run);
      const n = run.loop?.prNumber ?? null;
      if (repo === undefined || n === null) return final(MERGE_NO_PR);
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      return queued(mergeQueue, run.repoId, async (): Promise<PublishResult> => {
        const view = async (): Promise<Record<string, unknown> | Refusal> =>
          ghJson(
            [
              "pr",
              "view",
              String(n),
              `--repo=${repo}`,
              "--json",
              "state,headRefOid,baseRefName,headRefName,isCrossRepository,mergeable",
            ],
            "pr view",
          );
        const pr = await view();
        if (isRefusal(pr)) return pr;
        if (pr.state === "MERGED") return { ok: true };
        if (pr.state !== "OPEN") return final(MERGE_PR_NOT_OPEN);
        if (pr.headRefOid !== sha) return final(MERGE_HEAD_MOVED);
        if (pr.isCrossRepository !== false || pr.headRefName !== ownBranch(run)) {
          return final(MERGE_PR_NOT_RUNS);
        }
        if (pr.mergeable === "CONFLICTING") return transient(MERGE_CONFLICTING);
        const base = await inGit(run, async (g): Promise<PublishResult> => {
          const { defaultBranch } = await originNow(g, null);
          return pr.baseRefName === defaultBranch ? { ok: true } : final(MERGE_PR_NOT_RUNS);
        });
        if (!base.ok) return base;
        if (activeAway(deps.store, (deps.now ?? Date.now)(), deps.config.operator.timezone))
          return final(AWAY_WRITES_REFUSED);
        const merged = await ghDo(
          ["pr", "merge", String(n), `--repo=${repo}`, "--merge", `--match-head-commit=${sha}`],
          "pr merge",
        );
        if (merged.ok) return merged;
        // the merge may have gone through with the reply lost, or GitHub has found a conflict
        // its earlier answer did not show yet
        const after = await view();
        if (!isRefusal(after) && after.state === "MERGED") return { ok: true };
        if (!isRefusal(after) && after.mergeable === "CONFLICTING")
          return transient(MERGE_CONFLICTING);
        return merged;
      });
    },

    async fileMinorFindings(run, prNumber, techDebtIssue) {
      const repo = deps.config.repos.find((r) => r.id === run.repoId);
      if (
        repo?.autonomy !== "merge" ||
        ownBranch(run) === null ||
        run.loop == null ||
        run.loop.prNumber !== prNumber
      ) {
        return final(MERGE_PR_NOT_RUNS);
      }
      // item-add returns the existing item, so it is safe to repeat after a restart
      const addItem = async (
        issueNumber: number,
      ): Promise<PublishResult & { issueNumber: number }> => {
        const [owner = ""] = repo.github.split("/");
        const added = await ghDo(
          [
            "project",
            "item-add",
            String(repo.project),
            `--owner=${owner}`,
            `--url=https://github.com/${repo.github}/issues/${issueNumber}`,
          ],
          "project item-add",
        );
        return { ...added, issueNumber };
      };
      const remembered =
        run.loop.minorIssueNumber ?? deps.store.run(run.id)?.loop?.minorIssueNumber;
      if (remembered !== undefined) return addItem(remembered);
      const file = crewPrBodyPath(deps.dbPath);
      let wrote = false;
      try {
        const intent =
          run.loop.minorIssueCreation ?? deps.store.run(run.id)?.loop?.minorIssueCreation;
        if (intent !== undefined) {
          if (intent.prNumber !== prNumber)
            return final("minor issue creation intent names another PR");
          const listed = await ghJson(
            [
              "issue",
              "list",
              `--repo=${repo.github}`,
              "--state=all",
              `--search=${minorIssueTitle(prNumber)} in:title`,
              "--limit=100",
              "--json=number,title,body",
            ],
            "issue list",
          );
          if (isRefusal(listed)) return listed;
          if (!Array.isArray(listed) || listed.length >= 100)
            return final(
              "minor issue creation outcome is uncertain; collect the findings manually",
            );
          const matches = listed.filter(
            (issue: unknown): issue is { number: number } =>
              typeof issue === "object" &&
              issue !== null &&
              "title" in issue &&
              issue.title === minorIssueTitle(prNumber) &&
              "body" in issue &&
              typeof issue.body === "string" &&
              issue.body.split(/\r?\n/)[0] === `Minor findings from #${prNumber}.` &&
              "number" in issue &&
              Number.isSafeInteger(issue.number) &&
              Number(issue.number) > 0,
          );
          if (matches.length !== 1)
            return final(
              "minor issue creation outcome is uncertain; collect the findings manually",
            );
          const issueNumber = matches[0]?.number;
          if (issueNumber === undefined) return final("minor issue could not be recovered");
          run.loop.minorIssueNumber = issueNumber;
          deps.store.setRunLoop(run.id, run.loop);
          return await addItem(issueNumber);
        }
        const pr = await ghJson(
          ["pr", "view", String(prNumber), `--repo=${repo.github}`, "--json=body,labels"],
          "pr view",
        );
        if (isRefusal(pr)) return pr;
        if (typeof pr.body !== "string") return final("the PR body could not be read");
        const findings = parseMinorFindings(pr.body);
        if (findings.length === 0) {
          const section = pr.body.split(MINOR_HEADING)[1]?.split(/^#{1,2}\s/m)[0] ?? "";
          if (/logged [1-9]\d* minor findings?; they are listed in Mission Control\./.test(section))
            return final(
              "RETRO logged minor findings in Mission Control without listing them in the PR body",
            );
          return { ok: true };
        }
        const appendRolling = async (issueNumber: number): Promise<PublishResult | null> => {
          const viewed = await deps.gh(
            [
              "issue",
              "view",
              String(issueNumber),
              `--repo=${repo.github}`,
              "--json=state,comments",
            ],
            { cwd: cwd() },
          );
          if (viewed.code !== 0)
            return ghNotFound(viewed.stderr)
              ? null
              : ghFailed("rolling tech-debt issue view", viewed.stderr);
          let issue: Record<string, unknown>;
          try {
            const parsed: unknown = parseJson<unknown>(viewed.stdout, undefined, rethrowJson);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
              return transient("gh rolling tech-debt issue view gave no JSON");
            issue = parsed as Record<string, unknown>;
          } catch {
            return transient("gh rolling tech-debt issue view gave no JSON");
          }
          if (issue.state !== "OPEN") return null;
          const intro = `Minor findings from #${prNumber}.`;
          if (
            Array.isArray(issue.comments) &&
            issue.comments.some(
              (comment) =>
                typeof comment === "object" &&
                comment !== null &&
                "body" in comment &&
                typeof comment.body === "string" &&
                comment.body.split(/\r?\n/)[0] === intro,
            )
          )
            return { ok: true };
          await writeFile(file, minorIssueBody(prNumber, findings), {
            mode: 0o600,
            flag: "wx",
          });
          wrote = true;
          return await ghDo(
            [
              "issue",
              "comment",
              String(issueNumber),
              `--repo=${repo.github}`,
              `--body-file=${file}`,
            ],
            "rolling tech-debt issue comment",
          );
        };
        let rolling = techDebtIssue;
        if (rolling === undefined) {
          const listed = await deps.gh(
            [
              "issue",
              "list",
              `--repo=${repo.github}`,
              "--state=open",
              "--search=Tech debt: the rolling list in:title",
              "--limit=100",
              "--json=number,title",
            ],
            { cwd: cwd() },
          );
          if (listed.code !== 0) return ghFailed("rolling tech-debt issue list", listed.stderr);
          try {
            const issues: unknown = parseJson<unknown>(listed.stdout, undefined, rethrowJson);
            if (Array.isArray(issues)) {
              const matches = issues.filter(
                (issue): issue is { number: number } =>
                  typeof issue === "object" &&
                  issue !== null &&
                  "number" in issue &&
                  Number.isSafeInteger(issue.number) &&
                  issue.number > 0 &&
                  "title" in issue &&
                  typeof issue.title === "string" &&
                  issue.title.startsWith("Tech debt: the rolling list"),
              );
              if (matches.length === 1) rolling = matches[0]?.number;
            }
          } catch {
            return transient("gh rolling tech-debt issue list gave no JSON");
          }
        }
        if (rolling !== undefined) {
          const appended = await appendRolling(rolling);
          if (appended !== null) return appended;
        }
        const areas = (labels: unknown): string[] =>
          Array.isArray(labels)
            ? labels.flatMap((l: unknown) => {
                const name =
                  typeof l === "string"
                    ? l
                    : typeof l === "object" && l !== null && "name" in l
                      ? l.name
                      : null;
                return typeof name === "string" && name.startsWith("area:") ? [name] : [];
              })
            : [];
        const prAreas = areas(pr.labels);
        const ticket =
          issueOf(run) === null
            ? undefined
            : deps.store.boardItem(run.repoId, issueOf(run) as number);
        const labels = [
          ...new Set([...(prAreas.length > 0 ? prAreas : areas(ticket?.labels)), "chore"]),
        ];
        await writeFile(file, minorIssueBody(prNumber, findings), {
          mode: 0o600,
          flag: "wx",
        });
        wrote = true;
        run.loop.minorIssueCreation = { prNumber };
        deps.store.setRunLoop(run.id, run.loop);
        const made = await deps.gh(
          [
            "issue",
            "create",
            `--repo=${repo.github}`,
            `--title=${minorIssueTitle(prNumber)}`,
            `--label=${labels.join(",")}`,
            `--body-file=${file}`,
          ],
          { cwd: cwd() },
        );
        if (made.code !== 0) return ghFailed("issue create", made.stderr);
        const url = made.stdout.trim().split("\n").at(-1)?.trim() ?? "";
        const prefix = `https://github.com/${repo.github}/issues/`;
        const number = url.startsWith(prefix) ? url.slice(prefix.length) : "";
        if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
          return final("gh issue create gave no issue URL");
        const issueNumber = Number(number);
        run.loop.minorIssueNumber = issueNumber;
        deps.store.setRunLoop(run.id, run.loop);
        return await addItem(issueNumber);
      } catch (e) {
        return transient(errText(e));
      } finally {
        if (wrote) await unlink(file).catch(() => {});
      }
    },

    async closeIssue(run) {
      const repo = repoOf(run);
      const issue = issueOf(run);
      if (repo === undefined || issue === null) return final(MERGE_NO_PR);
      const prNumber = run.loop?.prNumber ?? null;
      if (prNumber !== null) {
        // a PR that is only part of the ticket leaves it open
        const pr = await ghJson(
          ["pr", "view", String(prNumber), `--repo=${repo}`, "--json=body"],
          "pr view",
        );
        if (isRefusal(pr)) return pr;
        if (typeof pr.body === "string" && prIsPartOf(pr.body, repo, issue))
          return { ok: true, left: true };
      }
      const view = await ghJson(
        ["issue", "view", String(issue), `--repo=${repo}`, "--json", "state"],
        "issue view",
      );
      if (isRefusal(view)) return view;
      if (view.state !== "OPEN") return { ok: true };
      return ghDo(
        ["issue", "close", String(issue), `--repo=${repo}`, "--reason=completed"],
        "issue close",
      );
    },

    async deleteRemoteBranch(run, sha) {
      const branch = ownBranch(run);
      if (branch === null) return final(MERGE_NOT_RUN_BRANCH);
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      return inGit(run, async (g): Promise<PublishResult> => {
        const { defaultBranch, mainSha, branchSha } = await originNow(g, branch);
        if (branch === defaultBranch) return final(MERGE_NOT_RUN_BRANCH);
        if (branchSha === null) return { ok: true };
        let lease = sha;
        if (branchSha !== sha) {
          // past the merged head, only the hub's own main merges may sit on the branch
          await fetchMain(g, defaultBranch, mainSha);
          if (!(await have(g, branchSha))) {
            await g(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
          }
          if (!(await onlyHubMerges(g, branch, sha, branchSha, mainSha))) {
            return final(MERGE_BRANCH_MOVED);
          }
          lease = branchSha;
        }
        try {
          await g([
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/${branch}:${lease}`,
            "origin",
            "--delete",
            `refs/heads/${branch}`,
          ]);
        } catch (e) {
          // --porcelain prints a refused ref on stdout, not in the error message
          const out = (e as { stdout?: unknown } | null)?.stdout;
          // a branch deleted since the check (delete-on-merge, the merger) is done, not moved
          const gone = await originNow(g, branch).then(
            (now) => now.branchSha === null,
            () => false,
          );
          if (gone) return { ok: true };
          return typeof out === "string" && /^!\t[^\t]*\t\[rejected\]/m.test(out)
            ? final(MERGE_BRANCH_MOVED)
            : transient(errText(e));
        }
        return { ok: true };
      });
    },

    async deleteLocalBranch(run) {
      const branch = ownBranch(run);
      if (branch === null) return final(MERGE_NOT_RUN_BRANCH);
      return inGit(run, async (g): Promise<PublishResult> => {
        let tip: string;
        try {
          tip = (
            await g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
          ).trim();
        } catch (e) {
          if ((e as { code?: unknown } | null)?.code === 1) return { ok: true };
          throw e;
        }
        if (!SHA.test(tip)) return { ok: true };
        if (tip !== run.loop?.merging?.sha) {
          const { defaultBranch, mainSha } = await originNow(g, null);
          await fetchMain(g, defaultBranch, mainSha);
          const merged = run.loop?.merging?.sha;
          const onMain = await yes(g, ["merge-base", "--is-ancestor", tip, mainSha]);
          if (
            !onMain &&
            !(merged !== undefined && (await onlyHubMerges(g, branch, merged, tip, mainSha)))
          ) {
            return final(MERGE_BRANCH_MOVED);
          }
        }
        await g(["branch", "-D", branch]);
        return { ok: true };
      });
    },

    async localBranchGone(run) {
      const branch = ownBranch(run);
      if (branch === null) return false;
      try {
        const r = await inGit(run, async (g): Promise<PublishResult> => {
          try {
            await g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
          } catch (e) {
            if ((e as { code?: unknown } | null)?.code === 1) return { ok: true };
            throw e;
          }
          return final(MERGE_BRANCH_MOVED);
        });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}
