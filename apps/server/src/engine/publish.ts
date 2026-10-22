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
  prNotRunsText,
  type Run,
} from "@mc/core";
import {
  editRunPrBody,
  issueOf,
  type McToolsDeps,
  openDraftPr,
  prTextProblem,
  pushRun,
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
/** `gh run view --log-failed` may print this much. */
export const CI_LOG_MAX_BUFFER = 16 * 1024 * 1024;

export type PublishResult = { ok: true } | { ok: false; text: string; transient: boolean };
export type OpenPrResult =
  | {
      ok: true;
      prNumber: number | null;
      /** Null number because the branch tip is not the pushed commit: push, then try again. */
      tipMoved?: boolean;
    }
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
  /** The tail of the failed Actions logs for `sha`, as one line-safe text. */
  ciExcerpt(repo: string, sha: string): Promise<string>;
  /** The paths changed between origin's default branch and `sha` that match `hardRules`. */
  hardRuleTouches(run: Run, sha: string, hardRules: readonly string[]): Promise<string[]>;
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

export function createPublisher(deps: McToolsDeps): Publisher {
  const cwd = () => crewDir(deps.dbPath);

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
        const names = (await g(["diff", "--name-only", "-z", base, sha, "--"]))
          .split("\0")
          .filter((p) => p !== "");
        return names.filter((p) => hardRules.some((rule) => globMatches(rule, p, true)));
      });
    },
  };
}
