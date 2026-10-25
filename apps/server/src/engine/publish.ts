/**
 * What the engine does to GitHub and the session clone for a looped run: the push, the draft PR
 * (`pushRun` and `openDraftPr`, called directly), a failed CI run's log excerpt, and the
 * hard-rule files a pushed sha touches. Nothing here throws for a refusal; it answers.
 */
import { realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AWAY_WRITES_REFUSED,
  type AwayDiff,
  CI_EXCERPT_LINES,
  CI_EXCERPT_MAX,
  type CiRerun,
  globMatches,
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
  parseMinorFindings,
  pathInArea,
  prNotRunsText,
  REVIEW_STATUS_CONTEXT,
  type ReviewStatusState,
  type Run,
  STDERR_TEXT_MAX,
} from "@mc/core";
import { activeAway } from "../away.ts";
import {
  COMMIT_ADD_PATHSPEC,
  editRunPrBody,
  issueOf,
  type McToolsDeps,
  openDraftPr,
  originHeads,
  prTextProblem,
  pushRun,
  queued,
  RUN_BRANCH,
  readKnown,
  seatPlace,
} from "../mcp/tools.ts";
import {
  adminDirOf,
  CREW_GIT_SLOW_MS,
  installAfterSync,
  MC_MERGE_AUTHOR,
  mainMergeArgs,
} from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { crewDir, crewPrBodyPath } from "../store.ts";
import { mcSection } from "./rules.ts";

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
export { MC_MERGE_AUTHOR } from "../runtime/checkouts.ts";

export type PublishResult = { ok: true } | { ok: false; text: string; transient: boolean };
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
  | { ok: true; kind: "merged"; sha: string; parent: string; prSame: boolean; installNote?: string }
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

export interface Publisher {
  /** The pending merge in the registered worktree, or null when absent or unreadable. */
  mergeHead(run: Run, worktree: string): Promise<string | null>;
  mainTip(
    run: Run,
  ): Promise<{ ok: true; sha: string } | { ok: false; text: string; transient: boolean }>;
  awayDiff(run: Run, sha: string): Promise<AwayDiff | null>;
  isDescendant(run: Run, ancestor: string, head: string): Promise<boolean>;
  /** Pushes the run's branch; "Already on origin" and "Nothing to push" are success. */
  push(run: Run): Promise<PublishResult>;
  /** Opens the run's draft PR, or finds the one it already opened. */
  openPr(run: Run, ticket: { issue: number; title: string }, note: string): Promise<OpenPrResult>;
  /** Rewrites the run's open PR body with RETRO's Minor findings (none: without the section). */
  postMinorFindings(
    run: Run,
    review: { id: number; sha: string; retro: string },
  ): Promise<PublishResult>;
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
   * Re-runs the failed jobs of every failed Actions run on `sha`; the runs re-run (none: nothing
   * failed to re-run), "running" when a run on `sha` has not completed (nothing is re-run; gh refuses
   * a running run), or null when gh could not be read or refused.
   */
  rerunFailed(
    repo: string,
    sha: string,
  ): Promise<{ id: number; name: string }[] | null | "running">;
  /**
   * FLIGHT's re-run of a ruled sha: like `rerunFailed` (failed or timed-out runs only), but it
   * returns each run's attempt from before, so `rerunState` can tell the re-run from the first
   * run. NO_FAILED_RUN when none failed.
   */
  rerunRuling(repo: string, sha: string): Promise<RerunResult>;
  /** What those re-runs came to: pending until each run is on a later attempt and completed. */
  rerunState(repo: string, sha: string, runs: CiRerun["runs"]): Promise<RerunStateResult>;
  /** The paths changed between origin's default branch and `sha` that match `hardRules`. */
  hardRuleTouches(run: Run, sha: string, hardRules: readonly string[]): Promise<string[]>;
  /**
   * The merge gate's reads for `sha`. origin's tip is read every call; when `known` is for the same
   * sha and tip, it is returned without the rest of the reads.
   */
  gateFacts(
    run: Run,
    sha: string,
    known?: (GateFacts & { sha: string }) | null,
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
  /** Marks the run's PR ready for review (`gh pr ready`). */
  markReady(run: Run, expectedSha?: string): Promise<PublishResult>;
  markDraft(run: Run): Promise<PublishResult>;
  /** Merges the run's PR with a merge commit, only if its head is `sha`. */
  merge(run: Run, sha: string): Promise<PublishResult>;
  /** Closes the run's issue as completed, if the merge did not. */
  closeIssue(run: Run): Promise<PublishResult>;
  fileMinorFindings(run: Run, prNumber: number): Promise<PublishResult & { issueNumber?: number }>;
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

/** The run's PR body as the hub writes it; `section` goes between "What changed" and "Closes". */
export function runPrBody(
  ticket: { issue: number; title: string },
  note: string,
  section: string | null,
  withTitle: boolean,
): string {
  const heading = `#${ticket.issue}${withTitle ? ` — ${ticket.title}` : ""}`;
  const extra = section === null ? "" : `${section}\n\n`;
  const around = `${heading}\n\n## What changed\n\n\n\n${extra}Closes #${ticket.issue}.`;
  const room = Math.max(0, MC_PR_BODY_MAX - around.length);
  // the note is cut, never the closing line, to keep the body inside what GitHub takes
  const shown = note.length > room ? `${note.slice(0, Math.max(0, room - 1))}…` : note;
  return `${heading}\n\n## What changed\n\n${shown}\n\n${extra}Closes #${ticket.issue}.`;
}

/** Each repo's last merge call: merges in one repo run one at a time. */
const mergeQueue = new Map<string, Promise<unknown>>();

type Refusal = { ok: false; text: string; transient: boolean };
const final = (text: string): Refusal => ({ ok: false, text, transient: false });
const transient = (text: string): Refusal => ({ ok: false, text, transient: true });
const errText = (e: unknown): string =>
  Array.from(cleanLog(e instanceof Error ? e.message : String(e)).trim())
    .slice(0, STDERR_TEXT_MAX)
    .join("");

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
          git(checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS });
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

  /** gh's answer as a JSON object, or a transient refusal naming the call. */
  async function ghJson(args: string[], what: string): Promise<Record<string, unknown> | Refusal> {
    const r = await deps.gh(args, { cwd: cwd() });
    if (r.code !== 0) return ghFailed(what, r.stderr);
    try {
      const parsed: unknown = JSON.parse(r.stdout);
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
      parsed = JSON.parse(listed.stdout);
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
  async function yes(g: G, args: string[]): Promise<boolean> {
    try {
      await g(args);
      return true;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 1) return false;
      throw e;
    }
  }

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

  /**
   * Whether every commit on `tip` beyond `merged` is a hub-made `Merge main into <branch>`:
   * two parents, each on main or another such commit. Nothing unmerged is in them.
   */
  async function onlyHubMerges(
    g: G,
    branch: string,
    merged: string,
    tip: string,
    mainSha: string,
  ): Promise<boolean> {
    if (!(await yes(g, ["merge-base", "--is-ancestor", merged, tip]))) return false;
    const rows = (await g(["log", "--format=%H%x09%an%x09%P%x09%s", tip, "--not", merged, mainSha]))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split("\t"));
    const inRange = new Set(rows.map((r) => r[0]));
    for (const [commit, author, parents, subject] of rows) {
      const ps = (parents ?? "").split(" ").filter((p) => p !== "");
      if (author !== MC_MERGE_AUTHOR || subject !== `Merge main into ${branch}`) return false;
      if (ps.length !== 2) return false;
      for (const p of ps) {
        if (!inRange.has(p) && !(await yes(g, ["merge-base", "--is-ancestor", p, mainSha]))) {
          return false;
        }
      }
      // the tree must be the clean merge of the parents, so no edit rides along
      if ((await mergeTree(g, ps)) !== (await g(["rev-parse", `${commit}^{tree}`])).trim()) {
        return false;
      }
    }
    return true;
  }

  /** The tree of a clean merge of two commits, or null when they conflict. */
  async function mergeTree(g: G, [a, b]: string[]): Promise<string | null> {
    try {
      return (await g(["merge-tree", "--write-tree", a as string, b as string])).trim();
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 1) return null;
      throw e;
    }
  }

  /** The run's branch when it is of the run's shape for its issue, else null. */
  function ownBranch(run: Run): string | null {
    const issue = issueOf(run);
    const m = run.branch === null ? null : RUN_BRANCH.exec(run.branch);
    if (run.branch === null || m === null || issue === null || Number(m[1]) !== issue) return null;
    return run.branch;
  }

  /** The open PRs on the branch as `[number, createdAt]`, or null when gh could not say. */
  async function openOnBranch(
    repo: string,
    branch: string,
  ): Promise<{ number: number; createdAt: number }[] | null> {
    const listed = await deps.gh(
      [
        "pr",
        "list",
        `--repo=${repo}`,
        `--head=${branch}`,
        "--state=open",
        "--json=number,createdAt",
      ],
      { cwd: cwd() },
    );
    if (listed.code !== 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const out: { number: number; createdAt: number }[] = [];
    for (const p of parsed) {
      const n = (p as { number?: unknown } | null)?.number;
      const at = Date.parse(String((p as { createdAt?: unknown } | null)?.createdAt));
      if (typeof n === "number" && Number.isSafeInteger(n) && !Number.isNaN(at)) {
        out.push({ number: n, createdAt: at });
      }
    }
    return out;
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
      if (open.length > 0) return { ok: false, text: EARLIER_PR_OPEN, transient: false };

      const known = await readKnown(deps, "draft_pr");
      const own = { repo, issue: ticket.issue, known };
      const heading = `#${ticket.issue}`;
      const withTitle = `${heading} ${ticket.title}`.slice(0, MC_PR_TITLE_MAX);
      const titled = { title: withTitle, body: runPrBody(ticket, note, null, true) };
      const flagged =
        prTextProblem(titled.title, { ...own, label: "PR title" }) !== null ||
        prTextProblem(titled.body, { ...own, label: "PR body" }) !== null;
      const pr = flagged ? { title: heading, body: runPrBody(ticket, note, null, false) } : titled;

      const made = await openDraftPr(deps, run.id, pr);
      if (made.isError === true) {
        // The branch moved past the push (a commit made since): not a refusal. The next pass
        // pushes the new tip and tries again.
        if (made.text === MC_PUSH_FIRST) return { ok: true, prNumber: null, tipMoved: true };
        return { ok: false, text: made.text, transient: made.text === MC_PR_FAILED };
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
      const note = deps.store.evidenceNotes(run.id)[0]?.note ?? "";
      const title =
        run.ticketTitle ??
        deps.store.board(run.repoId).find((b) => b.issueNumber === issue)?.title ??
        "";
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
        prTextProblem(runPrBody(ticket, note, null, true), { ...own, unclosed: false }) !== null;
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
      const body = runPrBody(ticket, note, section, withTitle);
      const r = await editRunPrBody(deps, run.id, prNumber, body);
      if (r.isError === true) {
        return { ok: false, text: r.text, transient: r.text === MC_PR_EDIT_FAILED };
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
          ["run", "list", `--repo=${repo}`, `--commit=${sha}`, "--json=databaseId,name,conclusion"],
          { cwd: cwd() },
        );
        if (listed.code !== 0) return CI_LOG_UNREADABLE;
        const runs: unknown = JSON.parse(listed.stdout);
        if (!Array.isArray(runs)) return CI_LOG_UNREADABLE;
        const failed = runs.flatMap((r: unknown) => {
          const x = r as { databaseId?: unknown; name?: unknown; conclusion?: unknown } | null;
          return x?.conclusion === "failure" &&
            typeof x.databaseId === "number" &&
            Number.isSafeInteger(x.databaseId)
            ? [{ id: x.databaseId, name: typeof x.name === "string" ? x.name : "CI" }]
            : [];
        });
        if (failed.length === 0) return NO_FAILED_RUN;
        // bytes, not characters: what is left of CI_EXCERPT_MAX, separators and headers included
        let budget = CI_EXCERPT_MAX;
        const sections: string[] = [];
        for (const f of failed) {
          const head = `${cleanLog(f.name).slice(0, RUN_NAME_MAX)}:\n`;
          const room = budget - (sections.length > 0 ? SEPARATOR_BYTES : 0) - byteLength(head);
          if (room <= 0) break; // no room for a header with anything under it
          const viewed = await deps.gh(
            ["run", "view", `--repo=${repo}`, String(f.id), "--log-failed"],
            { cwd: cwd(), maxBuffer: CI_LOG_MAX_BUFFER },
          );
          if (viewed.code !== 0) return CI_LOG_UNREADABLE;
          const lines = cleanLog(viewed.stdout).trimEnd().split("\n").slice(-CI_EXCERPT_LINES);
          const body = tailBytes(lines.join("\n"), room);
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
        const runs: unknown = JSON.parse(listed.stdout);
        if (!Array.isArray(runs)) return null;
        if (runs.some((r: unknown) => (r as { status?: unknown } | null)?.status !== "completed")) {
          return "running";
        }
        const failed = runs.flatMap((r: unknown) => {
          const x = r as { databaseId?: unknown; name?: unknown; conclusion?: unknown } | null;
          return x?.conclusion === "failure" &&
            typeof x.databaseId === "number" &&
            Number.isSafeInteger(x.databaseId)
            ? [{ id: x.databaseId, name: cleanLog(String(x.name ?? "CI")).slice(0, RUN_NAME_MAX) }]
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
      const failed = listed.filter(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
      );
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
      const now = saved.map((s) => ({ s, r: listed.find((r) => r.id === s.id) }));
      if (now.some((x) => x.r === undefined)) return transient(RERUN_RUN_MISSING);
      const runs = now.flatMap((x) => (x.r === undefined ? [] : [{ ...x.r, was: x.s.attempt }]));
      if (runs.some((r) => r.attempt <= r.was || r.status !== "completed")) {
        return { ok: true, outcome: "pending" };
      }
      // a failed run that was not re-run (its re-run was refused) means CI still fails
      const failed =
        runs.some((r) => !NOT_FAILED_CONCLUSIONS.includes(r.conclusion)) ||
        listed.some(
          (r) =>
            !saved.some((s) => s.id === r.id) &&
            (r.conclusion === "failure" || r.conclusion === "timed_out"),
        );
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
      const result = await inGit(run, async (g) => ({
        ok: true as const,
        descends: await yes(g, ["merge-base", "--is-ancestor", ancestor, head]),
      }));
      return result.ok && result.descends;
    },

    async hardRuleTouches(run, sha, hardRules) {
      const place = seatPlace(deps.config, run.agentId);
      if (place === null || !SHA.test(sha) || hardRules.length === 0) return [];
      const git = deps.git ?? crewGit;
      const checkout = place.session.checkout;
      return deps.inClone(checkout, async () => {
        const common = await realpath(join(checkout, ".git"));
        const g = (a: string[]) =>
          git(checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS });
        const base = (await g(["merge-base", "refs/remotes/origin/HEAD", sha])).trim();
        if (!SHA.test(base)) throw new Error("no merge base with origin/HEAD");
        const names = (await g(["diff", "--name-only", "-z", "--no-renames", base, sha, "--"]))
          .split("\0")
          .filter((p) => p !== "");
        return names.filter((p) => hardRules.some((rule) => globMatches(rule, p, true)));
      });
    },

    async gateFacts(run, sha, known) {
      if (!SHA.test(sha)) return final(MERGE_BAD_SHA);
      return inGit(run, async (g, { seat }): Promise<GateResult> => {
        const { defaultBranch, mainSha } = await originNow(g, null);
        if (known?.sha === sha && known.mainSha === mainSha) {
          const { containsMain, hubOnly, strays, missionControlChanged } = known;
          return {
            ok: true,
            facts: {
              mainSha,
              containsMain,
              hubOnly,
              strays: [...strays],
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
        const extra = deps.config.repos.find((r) => r.id === run.repoId)?.protectedFiles ?? [];
        const strays = names.filter((p) => !pathInArea(seat.area, p) || isProtectedPath(p, extra));
        return {
          ok: true,
          facts: {
            mainSha,
            containsMain,
            hubOnly,
            strays,
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
      return inGit(run, async (g) => ({ ok: true, sha: (await originNow(g, null)).mainSha }));
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
            git(checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS });
          const w = (a: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
            git(worktree, a, common, { gitDir, timeoutMs: CREW_GIT_SLOW_MS, env });
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
            await w(mainMergeArgs(branch, mainSha), {
              GIT_AUTHOR_NAME: MC_MERGE_AUTHOR,
              GIT_COMMITTER_NAME: MC_MERGE_AUTHOR,
            });
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

    async fileMinorFindings(run, prNumber) {
      const repo = deps.config.repos.find((r) => r.id === run.repoId);
      if (
        repo?.autonomy !== "merge" ||
        ownBranch(run) === null ||
        run.loop == null ||
        run.loop.prNumber !== prNumber
      ) {
        return final(MERGE_PR_NOT_RUNS);
      }
      const remembered =
        run.loop.minorIssueNumber ?? deps.store.run(run.id)?.loop?.minorIssueNumber;
      if (remembered !== undefined) return { ok: true, issueNumber: remembered };
      const file = crewPrBodyPath(deps.dbPath);
      let wrote = false;
      try {
        const pr = await ghJson(
          ["pr", "view", String(prNumber), `--repo=${repo.github}`, "--json=body,labels"],
          "pr view",
        );
        if (isRefusal(pr)) return pr;
        if (typeof pr.body !== "string") return final("the PR body could not be read");
        const findings = parseMinorFindings(pr.body);
        if (findings.length === 0) return { ok: true };
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
        const ticket = deps.store.board(run.repoId).find((b) => b.issueNumber === issueOf(run));
        const labels = [
          ...new Set([...(prAreas.length > 0 ? prAreas : areas(ticket?.labels)), "chore"]),
        ];
        await writeFile(file, minorIssueBody(prNumber, findings), { mode: 0o600, flag: "wx" });
        wrote = true;
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
        const [owner = ""] = repo.github.split("/");
        const added = await ghDo(
          ["project", "item-add", String(repo.project), `--owner=${owner}`, `--url=${url}`],
          "project item-add",
        );
        return { ...added, issueNumber };
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
