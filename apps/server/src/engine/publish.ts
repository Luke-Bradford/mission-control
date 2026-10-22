/**
 * What the engine does to GitHub and the session clone for a looped run: the push, the draft PR
 * (Plan 6's `pushRun` and `openDraftPr`, called directly), a failed CI run's log excerpt, and the
 * hard-rule files a pushed sha touches. Nothing here throws for a refusal; it answers.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  CI_EXCERPT_LINES,
  CI_EXCERPT_MAX,
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
  minorLine,
  minorMoreLine,
  pathInArea,
  prNotRunsText,
  REVIEW_STATUS_CONTEXT,
  type ReviewStatusState,
  type Run,
} from "@mc/core";
import {
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
import { CREW_GIT_SLOW_MS } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { crewDir } from "../store.ts";

/** What a ciExcerpt says when no Actions run failed on the sha. */
export const NO_FAILED_RUN = "(no failed Actions run to read)";
/** What a ciExcerpt says when gh could not be read. */
export const CI_LOG_UNREADABLE = "(the CI log could not be read)";
/** What a ciExcerpt says when the failed runs printed nothing to read. */
export const EMPTY_LOG = "(the failed run's log was empty)";
/** The park reason when an earlier PR is open on the run's branch. */
export const EARLIER_PR_OPEN = "an earlier PR is open on this branch";
/** Why setReviewStatus did not set the status. */
export const REVIEW_STATUS_FAILED = "the mc/review status could not be set";
/** The most of gh's stderr a failed status write's log line carries, in characters. */
const STATUS_STDERR_MAX = 300;
/** `gh run view --log-failed` may print this much. */
export const CI_LOG_MAX_BUFFER = 16 * 1024 * 1024;

/** Why a merge step was refused without trying. */
export const MERGE_NO_PR = "the run has no PR";
export const MERGE_NO_SEAT = "the run's seat is no longer configured";
export const MERGE_BAD_SHA = "not a commit sha";
export const MERGE_HEAD_MOVED = "the PR's head is not the commit that passed the gate";
export const MERGE_PR_NOT_OPEN = "the PR is not open";
export const MERGE_BEHIND_MAIN = "main has moved past the branch";
export const MERGE_NOT_RUN_BRANCH = "the branch is not this run's own";
export const MERGE_BRANCH_MOVED = "the branch has commits that were not merged";
export const MERGE_PR_NOT_RUNS =
  "the PR is not this run's own branch into the repo's default branch";
/** The most of gh's or git's stderr a refusal's text carries, in characters. */
const STEP_STDERR_MAX = 300;

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
  mainSha: string;
  containsMain: boolean;
  hubOnly: boolean;
  strays: string[];
}
export type GateResult =
  | { ok: true; facts: GateFacts }
  | { ok: false; text: string; transient: boolean };

export interface Publisher {
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
  /** Marks the run's PR ready for review (`gh pr ready`). */
  markReady(run: Run): Promise<PublishResult>;
  /** Merges the run's PR with a merge commit, only if its head is `sha` and it contains main. */
  merge(run: Run, sha: string): Promise<PublishResult>;
  /** Closes the run's issue as completed, if the merge did not. */
  closeIssue(run: Run): Promise<PublishResult>;
  /** Deletes origin's copy of the run's branch, only if its tip is `sha`. */
  deleteRemoteBranch(run: Run, sha: string): Promise<PublishResult>;
  /** Deletes the run's local branch, when its tip is the merged sha or already in main. */
  deleteLocalBranch(run: Run): Promise<PublishResult>;
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
  cleanLog(e instanceof Error ? e.message : String(e))
    .trim()
    .slice(0, STEP_STDERR_MAX);

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
    const why = cleanLog(stderr).trim().slice(0, STEP_STDERR_MAX);
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

  const have = (g: G, sha: string) => yes(g, ["cat-file", "-e", `${sha}^{commit}`]);

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
        const why = cleanLog(r.stderr).trim().slice(0, STATUS_STDERR_MAX);
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
          const { containsMain, hubOnly, strays } = known;
          return { ok: true, facts: { mainSha, containsMain, hubOnly, strays: [...strays] } };
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
        const strays = names.filter((p) => !pathInArea(seat.area, p) || isProtectedPath(p));
        return { ok: true, facts: { mainSha, containsMain, hubOnly, strays } };
      });
    },

    async markReady(run) {
      const repo = repoOf(run);
      const n = run.loop?.prNumber ?? null;
      if (repo === undefined || n === null) return final(MERGE_NO_PR);
      return ghDo(["pr", "ready", String(n), `--repo=${repo}`], "pr ready");
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
              "state,headRefOid,baseRefName,headRefName,isCrossRepository",
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
        const behind = await inGit(run, async (g): Promise<PublishResult> => {
          const { defaultBranch, mainSha } = await originNow(g, null);
          if (pr.baseRefName !== defaultBranch) return final(MERGE_PR_NOT_RUNS);
          await fetchMain(g, defaultBranch, mainSha);
          return (await yes(g, ["merge-base", "--is-ancestor", mainSha, sha]))
            ? { ok: true }
            : transient(MERGE_BEHIND_MAIN);
        });
        if (!behind.ok) return behind;
        const merged = await ghDo(
          ["pr", "merge", String(n), `--repo=${repo}`, "--merge", `--match-head-commit=${sha}`],
          "pr merge",
        );
        if (merged.ok || !merged.transient) return merged;
        // the merge may have gone through with the reply lost
        const after = await view();
        return !isRefusal(after) && after.state === "MERGED" ? { ok: true } : merged;
      });
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
        const { defaultBranch, branchSha } = await originNow(g, branch);
        if (branch === defaultBranch) return final(MERGE_NOT_RUN_BRANCH);
        if (branchSha === null) return { ok: true };
        if (branchSha !== sha) return final(MERGE_BRANCH_MOVED);
        try {
          await g([
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/${branch}:${sha}`,
            "origin",
            "--delete",
            `refs/heads/${branch}`,
          ]);
        } catch (e) {
          // --porcelain prints a refused ref on stdout, not in the error message
          const out = (e as { stdout?: unknown } | null)?.stdout;
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
          if (!(await yes(g, ["merge-base", "--is-ancestor", tip, mainSha]))) {
            return final(MERGE_BRANCH_MOVED);
          }
        }
        await g(["branch", "-D", branch]);
        return { ok: true };
      });
    },
  };
}
