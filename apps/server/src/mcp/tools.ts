/**
 * The mc tools the hub serves at `/mcp` (phase 2b): `commit`, the only way a seat's work becomes a
 * commit, and `ask_operator`. Each call is already tied to one seat and one run by its token, and
 * serialised per run by the MCP server; nothing in a call's arguments names a path, a branch or a
 * repo. Those come from the run's own rows.
 *
 * The commit runs inside the session clone's queue (`inClone`), so it never interleaves with a
 * checkout or another seat's commit in the same clone. Every git call goes through `crewGit` with
 * the worktree's git dir named from the clone's side, so a rewritten `.git` pointer stops it.
 */
import { lstat, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ASKED_OPERATOR,
  alreadyOnOriginText,
  BLOCKING_SEVERITIES,
  COMMS_CAPCOM,
  clashText,
  closesIssue,
  commitMarkersText,
  commitNamedRefText,
  commitReferenceText,
  commitSecretText,
  committedText,
  commitUnresolvedText,
  crewAuthorName,
  DEFAULT_PROFILES,
  doneWhenCount,
  EVIDENCE_IN_CI,
  EVIDENCE_NO_COMMIT,
  EVIDENCE_NO_LOOP,
  EVIDENCE_PARKED,
  EVIDENCE_RECORDED,
  EVIDENCE_RULING_PREFIX,
  engineHitText,
  evidenceTextText,
  evidenceUncommittedText,
  FINDING_FILE_MAX,
  FINDING_FIX_MAX,
  FINDING_SCENARIO_MAX,
  FINDING_SEVERITIES,
  FINDING_SUMMARY_MAX,
  FINDINGS_ALREADY,
  FINDINGS_BLOCKING_NEEDS_FAIL,
  FINDINGS_DROPPED,
  FINDINGS_FAIL_NEEDS_BLOCKING,
  FINDINGS_NOT_A_REVIEW,
  FINDINGS_RECORDED,
  findingFileOk,
  findingFileText,
  firstCommitNotifier,
  firstNamedRef,
  firstPrNotifier,
  formerSubmoduleText,
  isProtectedPath,
  MC_BAD_ARGS,
  MC_COMMIT_MERGE_UNKNOWN,
  MC_COMMIT_TOO_BIG,
  MC_COMMIT_TOO_SLOW,
  MC_EVIDENCE_MAX,
  MC_INDEX_UNLISTABLE,
  MC_PLAN_ALREADY,
  MC_PLAN_BODY_UNCLOSED,
  MC_PLAN_GH_FAILED,
  MC_PLAN_ISSUE_CLOSED,
  MC_PLAN_MAX,
  MC_PLAN_NO_ROOM,
  MC_PLAN_NO_TESTS,
  MC_PLAN_NOT_FAO,
  MC_PLAN_WRITTEN,
  MC_PR_BODY_REFUSED,
  MC_PR_EDIT_FAILED,
  MC_PR_FAILED,
  MC_PR_UNCLOSED,
  MC_PUSH_FAILED,
  MC_PUSH_FIRST,
  MC_PUSH_FSCK,
  MC_PUSH_MERGE,
  MC_PUSH_NO_COMMIT,
  MC_PUSH_NOT_OWN_BRANCH,
  MC_PUSH_ROOT,
  MC_PUSH_TOO_BIG,
  MC_READ_ONLY_COMMIT,
  MC_REMOVE_FAILED,
  MC_REMOVE_MAX,
  MC_REMOVE_PATH_MAX,
  MC_REMOVE_REFUSED,
  MC_RUN_ENDED,
  MC_TEXT_MAX,
  MC_TOOL_NAMES,
  mcToolHitText,
  NOTHING_TO_COMMIT,
  NOTHING_TO_PUSH,
  nonAsciiPathsText,
  notOnBranchText,
  originMovedText,
  otherAreaText,
  outsideAreaText,
  PLAN_HEADING,
  PNPM_STORE_DIR_NAME,
  PROFILE_NAME,
  PROFILE_PAIR_TEXT,
  PROFILE_REASON_MAX,
  type Profile,
  type ProfileOverride,
  PUSH_SCAN_MAX_BUFFER,
  pathInArea,
  planByLine,
  planFewTestsText,
  planMissingPathsText,
  planNoProfilesText,
  planPaths,
  planTestCount,
  planTextText,
  planTooLongText,
  planUnknownProfileText,
  planWrittenText,
  prAlreadyOpenText,
  prClosesLine,
  prEditedText,
  prNamedRefText,
  prNotifyText,
  prNotRunsText,
  prOpenedByLine,
  protectedPathsText,
  prSecretText,
  pushedText,
  pushForeignText,
  pushReferenceText,
  pushSecretText,
  REVERT_STRAYS,
  REVIEW_FINDINGS_MAX,
  REVIEW_SUMMARY_MAX,
  type Run,
  readOnlyToolText,
  removedText,
  removeLinkedText,
  removeMissingText,
  removeNotFileText,
  reviewedEventText,
  type StrayKind,
  scanSecrets,
  scanText,
  seatCallSign,
  seatDef,
  specialPathsText,
  unclosedMarkdown,
  VERDICTS,
} from "@mc/core";
import { z } from "zod";
import type { ChangeBus } from "../bus.ts";
import { TICKET_BODY_MAX } from "../collectors/github.ts";
import type { CcConfig, CrewSeatConfig, CrewSessionConfig } from "../config.ts";
import type { ProfilesError } from "../profiles.ts";
import { adminDirOf, CREW_GIT_SLOW_MS } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { crewDir, crewPrBodyPath, type Store } from "../store.ts";
import type { GhRunner } from "./gh.ts";
import { headEntryKind, worktreeEntry } from "./remove.ts";
import type { McTool, McToolContext } from "./server.ts";

export interface McToolsDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  /** The supervisor's per-clone queue: a commit waits for any checkout or commit in the clone. */
  inClone: <T>(checkout: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  /** Default `crewGit`; tests wrap it to change the worktree between two steps. */
  git?: typeof crewGit;
  /** gh, through its one wrapper (`createGh`): draft_pr lists and opens PRs with it. */
  gh: GhRunner;
  /** The DB's path: draft_pr writes its PR body file into `{DB dir}/crew/`. */
  dbPath: string;
  /**
   * The secrets the push and PR scans look for verbatim (the GitHub token), read for each call.
   * Never logged: every log line has them redacted.
   */
  knownSecrets: () => Promise<string[]>;
  /** How long a read of `knownSecrets` may take; default `KNOWN_SECRETS_TIMEOUT_MS`. */
  knownSecretsTimeoutMs?: number;
  /** A line for the server log (a push or gh failure); default: none. */
  log?: (line: string) => void;
  /** Called after `report_evidence` records a note (the supervisor tells its listeners). */
  onEvidence?: (seatId: string, runId: string) => void;
  /** Called after `report_findings` records a review (the supervisor tells its listeners). */
  onFindings?: (seatId: string, runId: string) => void;
  /** The template profiles, read from user config on each call; default `DEFAULT_PROFILES`. */
  profiles?: () => readonly Profile[] | ProfilesError;
  /** Called after `report_plan` writes a plan (the supervisor ends the run). */
  onPlanned?: (seatId: string, runId: string) => void;
}

/**
 * A read of the known secrets that takes longer is abandoned (scanning by pattern only): a hung
 * `gh auth token` must not hold a push.
 */
export const KNOWN_SECRETS_TIMEOUT_MS = 10_000;

type Result = { text: string; isError?: boolean };

/** A tool argument: 1..max characters, not only whitespace, no NUL (it goes into argv). */
export const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() !== "", "must not be blank")
    .refine((s) => !s.includes("\0"), "must not hold a NUL character");

/** A repo-relative file path: no leading or trailing slash, no empty, `.` or `..` segment. */
const removePath = z
  .string()
  .min(1)
  .max(MC_REMOVE_PATH_MAX)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "must be a repo-relative file path",
  );
const CommitArgs = z.strictObject({
  message: text(MC_TEXT_MAX),
  remove: z.array(removePath).max(MC_REMOVE_MAX).optional(),
});
const AskArgs = z.strictObject({ question: text(MC_TEXT_MAX) });
const EvidenceArgs = z.strictObject({ note: text(MC_EVIDENCE_MAX) });
const PlanArgs = z
  .strictObject({
    plan: text(MC_PLAN_MAX),
    profile: z.string().regex(PROFILE_NAME).optional(),
    profile_reason: text(PROFILE_REASON_MAX).optional(),
  })
  .refine((a) => (a.profile === undefined) === (a.profile_reason === undefined), {
    message: PROFILE_PAIR_TEXT,
  });
/** A line that is the plan heading: the ticket already has a plan. */
const PLAN_HEADING_LINE = /^## Plan[ \t]*$/m;
const FindingArgs = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  file: text(FINDING_FILE_MAX),
  line: z.int().min(0).max(1_000_000),
  summary: text(FINDING_SUMMARY_MAX),
  scenario: text(FINDING_SCENARIO_MAX),
  fix: text(FINDING_FIX_MAX),
});
const FindingsArgs = z.strictObject({
  verdict: z.strictObject({ spec: z.enum(VERDICTS), quality: z.enum(VERDICTS) }),
  summary: text(REVIEW_SUMMARY_MAX),
  findings: z.array(FindingArgs).max(REVIEW_FINDINGS_MAX),
});

export function badArgs(e: z.ZodError): Result {
  const issue = e.issues[0];
  const path = issue?.path.join(".") ?? "";
  const what =
    issue === undefined ? "invalid" : path === "" ? issue.message : `${path}: ${issue.message}`;
  return { text: `${MC_BAD_ARGS}${what}`, isError: true };
}

/** The seat's config and its session, or null for a seat no longer configured. */
export function seatPlace(
  config: CcConfig,
  seatId: string,
): { seat: CrewSeatConfig; session: CrewSessionConfig } | null {
  for (const session of config.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => s.id === seatId);
    if (seat !== undefined) return { seat, session };
  }
  return null;
}

/** One staged change from `diff --cached --raw -z`: its paths (both sides of a rename) and new mode. */
export interface StagedEntry {
  paths: string[];
  /** The index side's mode: `000000` for a deletion, `120000` a symlink, `160000` a gitlink. */
  mode: string;
  /** The path the index now holds (a rename's destination); null for a deletion. */
  newPath: string | null;
}

/**
 * The entries of `diff --cached --raw -z`: `:<old mode> <new mode> <old id> <new id> <status>`,
 * then one path, or two for a rename or copy (source, then destination).
 */
export function stagedEntries(out: string): StagedEntry[] {
  const parts = out.split("\0");
  const entries: StagedEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++] ?? "";
    if (!head.startsWith(":")) continue;
    const [, mode = "", , , status = ""] = head.slice(1).split(" ");
    const sides = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = parts.slice(i, i + sides).filter((p) => p !== "");
    i += sides;
    entries.push({ paths, mode, newPath: status.startsWith("D") ? null : (paths.at(-1) ?? null) });
  }
  return entries;
}

/**
 * What the commit tool's `add -A` stages: the whole worktree but any `.pnpm-store/`, at the top or
 * nested. A sandboxed pnpm that cannot write its global store makes one inside the worktree; the
 * seat's env points the store elsewhere (`crewPnpmStoreDir`), and this is the backstop.
 */
export const COMMIT_ADD_PATHSPEC = [
  "--",
  ":(top)",
  `:(top,exclude,glob)**/${PNPM_STORE_DIR_NAME}/**`,
] as const;

/** Paths named on one git command line, so a large commit stays inside the argument limit. */
const PATHSPEC_CHUNK = 200;

/** Index modes the commit tool refuses: a symlink, a gitlink (nested repository). */
const SPECIAL_MODES = new Set(["120000", "160000"]);

/** Node's error for a child whose output passed maxBuffer (it is `killed` too: check this first). */
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
const overflowed = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === MAX_BUFFER_CODE;
/** The error execFile gives a child it killed at its timeout. */
const timedOut = (e: unknown): boolean => (e as { killed?: unknown } | null)?.killed === true;

/**
 * Anything but printable ASCII (0x20–0x7e): APFS folds some non-ASCII names (`ſ`, Kelvin `K`,
 * `ﬆ`) onto ASCII ones, and a control character would reach the refusal text raw.
 */
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

/** The index listing's own output cap: it covers every tracked file, not the staged change. */
export const INDEX_LIST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The gitlinks (`ls-files -s -z`: `<mode> <id> <stage>\t<path>`) whose folder in the worktree is a
 * plain folder with files in it: a submodule never checked out, which a seat filled. `add -A`
 * stages nothing there, so the files would vanish from the commit without a word.
 */
async function filledFormerSubmodules(worktree: string, listing: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1 || !entry.startsWith("160000 ")) continue;
    const path = entry.slice(tab + 1);
    try {
      const dir = join(worktree, path);
      if (!(await lstat(dir)).isDirectory()) continue;
      const names = await readdir(dir);
      if (names.length > 0 && !names.includes(".git")) out.push(path);
    } catch {
      // gone, or not a folder: nothing in it to lose
    }
  }
  return out;
}

const ENDED: Result = { text: MC_RUN_ENDED, isError: true };
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A branch `branchFor` makes: `feature/{issue}` or `feature/{issue}-{slug}`. */
export const RUN_BRANCH = /^feature\/(\d+)(?:-[a-z0-9]+)*$/;
/** Where a logged line is cut. */
const LOG_LINE_MAX = 500;

/**
 * The paths `git status` lists as changed or untracked in the worktree (the commit tool's own
 * pathspec: a `.pnpm-store` is not the seat's change). `-z` entries are `XY path`, a rename or
 * copy followed by its source.
 */
export function changedPaths(out: string): string[] {
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // a rename or copy is followed by its source, whichever column (index or worktree) says it
    if ("RC".includes(entry[0] ?? "") || "RC".includes(entry[1] ?? "")) i++;
  }
  return paths;
}

/** The run, unended and still its seat's live one; else null. */
function liveRunOf(store: Store, runId: string): Run | null {
  const run = store.run(runId);
  if (run === null || run.endedAt !== null) return null;
  return store.seatSession(run.agentId)?.runId === runId ? run : null;
}

/** The run, unended and set aside for review (off its seat), else null. */
function asideRunOf(store: Store, runId: string): Run | null {
  const run = store.run(runId);
  return run !== null && run.endedAt === null && run.loop?.aside ? run : null;
}

/** The run's issue number from its ticket (`{repo}#{n}`), or null. */
export function issueOf(run: Pick<Run, "ticket">): number | null {
  const m = /#(\d+)$/.exec(run.ticket ?? "");
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** `s` with every known secret replaced and cut for the log. */
export function redact(s: string, known: readonly string[]): string {
  let out = s;
  for (const k of known) if (k !== "") out = out.split(k).join("[redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, LOG_LINE_MAX);
}

/** What a failed child said: its stderr, else the error's name (never its message: it holds argv). */
function failure(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr;
  return e instanceof Error ? e.name : "error";
}

/**
 * The known secrets, or none when they cannot be read in time (the pattern scan still runs). A
 * failure is logged with a fixed line: its error could hold the secret.
 */
export async function readKnown(
  deps: Pick<McToolsDeps, "knownSecrets" | "knownSecretsTimeoutMs" | "log">,
  tool: string,
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out")),
      deps.knownSecretsTimeoutMs ?? KNOWN_SECRETS_TIMEOUT_MS,
    );
  });
  try {
    return (await Promise.race([deps.knownSecrets(), late])).filter((k) => k !== "");
  } catch {
    deps.log?.(`mc ${tool}: could not read the known secrets; scanning by pattern only`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** origin's default branch (name and tip) and the run's branch tip, from one `ls-remote`. */
interface OriginHeads {
  defaultBranch: string;
  defaultSha: string;
  branchSha: string | null;
}

export function originHeads(out: string, branch: string | null): OriginHeads {
  let defaultRef: string | null = null;
  let defaultSha: string | null = null;
  let branchSha: string | null = null;
  for (const line of out.split("\n")) {
    const [left = "", name = ""] = line.split("\t");
    if (name !== "HEAD" && name !== `refs/heads/${branch}`) continue;
    if (left.startsWith("ref: ")) {
      if (name === "HEAD") defaultRef = left.slice("ref: ".length);
    } else if (SHA.test(left)) {
      if (name === "HEAD") defaultSha = left;
      else branchSha = left;
    }
  }
  const defaultBranch = defaultRef?.startsWith("refs/heads/")
    ? defaultRef.slice("refs/heads/".length)
    : null;
  if (defaultBranch === null || defaultSha === null || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("origin has no default branch");
  }
  return { defaultBranch, defaultSha, branchSha };
}

/**
 * The run's seat and session, when the seat may write; else the answer to give. A seat no longer
 * configured is answered as an ended run.
 */
function writerPlace(
  deps: McToolsDeps,
  runId: string,
  tool: string,
): { seat: CrewSeatConfig; session: CrewSessionConfig } | Result {
  const run = deps.store.run(runId);
  const place = run === null ? null : seatPlace(deps.config, run.agentId);
  if (place === null) return ENDED;
  if (seatDef(place.seat).mode !== "writer") return { text: readOnlyToolText(tool), isError: true };
  return place;
}

/**
 * Whether `branch` is the run's own: the `branchFor` shape for the run's issue, not origin's
 * default, and not any other live run's. The push takes no argument, so this guards the
 * supervisor's own rows, not a seat's input.
 */
function ownBranch(store: Store, run: Run, branch: string, defaultBranch: string): boolean {
  const issue = issueOf(run);
  const m = RUN_BRANCH.exec(branch);
  if (issue === null || m === null || Number(m[1]) !== issue || branch === defaultBranch) {
    return false;
  }
  return !store.activeSeatSessions().some((row) => {
    if (row.runId === null || row.runId === run.id) return false;
    const other = store.run(row.runId);
    return other !== null && other.repoId === run.repoId && other.branch === branch;
  });
}

/**
 * Mission Control's push: a plain fast-forward of the run's own branch, sending only commits the commit
 * tool made, after an object check and a secret scan. The steps and their answers are fixed (Plan
 * 6, Task 9); every git call runs in the session clone, in its queue.
 */
export async function pushRun(deps: McToolsDeps, runId: string): Promise<Result> {
  const { store, bus } = deps;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? crewGit;
  const place = writerPlace(deps, runId, "push");
  if ("text" in place) return place;
  const { seat, session } = place;
  // read before the clone's queue: however long it takes, no other seat waits on it
  const known = await readKnown(deps, "push");

  return deps.inClone(session.checkout, async () => {
    // an aside run is off its seat; its branch is still the clone's to push
    const run = liveRunOf(store, runId) ?? asideRunOf(store, runId);
    if (run === null || run.branch === null) return ENDED;
    const branch = run.branch;
    try {
      const common = await realpath(join(session.checkout, ".git"));
      const g = (a: string[], o: { maxBuffer?: number } = {}) =>
        git(session.checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS, ...o });
      return await steps(run, g);
    } catch (e) {
      if (overflowed(e)) return { text: MC_PUSH_TOO_BIG, isError: true };
      deps.log?.(redact(`mc push failed (${runId}): ${failure(e)}`, known));
      return { text: MC_PUSH_FAILED, isError: true };
    }

    async function steps(
      run: Run,
      g: (a: string[], o?: { maxBuffer?: number }) => Promise<string>,
    ): Promise<Result> {
      // origin as it is now: never a local ref, which may be stale
      const heads = originHeads(
        await g(["ls-remote", "--symref", "origin", "HEAD", `refs/heads/${branch}`]),
        branch,
      );
      if (!ownBranch(store, run, branch, heads.defaultBranch)) {
        store.addGuardHit({
          agentId: seat.id,
          runId,
          rule: "merge-push",
          text: engineHitText("merge-push", "push"),
          at: now(),
        });
        bus.emit("guard");
        return { text: MC_PUSH_NOT_OWN_BRANCH, isError: true };
      }
      const sha = (
        await g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(
          (e: unknown) => {
            if ((e as { code?: unknown } | null)?.code === 1) return "";
            throw e;
          },
        )
      ).trim();
      if (!SHA.test(sha)) return { text: MC_PUSH_NO_COMMIT, isError: true };
      const has = (id: string) =>
        g(["cat-file", "-e", `${id}^{commit}`]).then(
          () => true,
          () => false,
        );

      // 1. origin's tip
      const remote = heads.branchSha;
      if (remote === sha) {
        store.setRunPush({ runId, sha, at: now() });
        bus.emit("agents");
        return { text: alreadyOnOriginText(sha) };
      }
      if (remote !== null) {
        let ancestor = false;
        if (await has(remote)) {
          ancestor = await g(["merge-base", "--is-ancestor", remote, sha]).then(
            () => true,
            (e: unknown) => {
              if ((e as { code?: unknown } | null)?.code === 1) return false;
              throw e;
            },
          );
        }
        if (!ancestor) return { text: originMovedText(branch), isError: true };
      }

      // 2. the new commits: exactly what this push sends
      if (!(await has(heads.defaultSha))) {
        await g(["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${heads.defaultBranch}`]);
        if (!(await has(heads.defaultSha)))
          throw new Error("origin's default branch was not fetched");
      }
      const not = [heads.defaultSha, ...(remote === null ? [] : [remote])];
      const commits = (await g(["rev-list", "--parents", sha, "--not", ...not]))
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const [id = "", ...parents] = l.split(" ");
          return { sha: id, parents: parents.length };
        });
      if (commits.length === 0) return { text: NOTHING_TO_PUSH };

      // 3. every new commit is Mission Control's, and a merge commit only if it is in run_commits
      // (the engine's merge of main, or the commit tool's after a conflict)
      const ours = store.branchCommits(run.repoId, branch);
      if (commits.some((c) => c.parents > 1 && !ours.has(c.sha))) {
        return { text: MC_PUSH_MERGE, isError: true };
      }
      const foreign = commits.filter((c) => !ours.has(c.sha)).map((c) => c.sha);
      // A refusal reaches the operator once, as the engine's Blocked note (the push's text is its reason):
      // no Needs-you item of its own here.
      if (foreign.length > 0) return { text: pushForeignText(foreign), isError: true };
      if (commits.some((c) => c.parents === 0)) return { text: MC_PUSH_ROOT, isError: true };

      // 4. the clone's objects are sound
      try {
        await g(["fsck", "--no-dangling", "--no-progress"]);
      } catch (e) {
        if (timedOut(e) && !overflowed(e)) throw e;
        deps.log?.(redact(`mc push: git fsck failed in ${session.checkout}: ${failure(e)}`, known));
        return { text: MC_PUSH_FSCK, isError: true };
      }

      // 5. no secret in what leaves: every added line, and each message on its own (a message can
      // fake a diff to hide a line from the first scan)
      const patch = await g(
        [
          "log",
          "-p",
          // a merge commit shows no diff without this: the lines a resolution added are scanned
          "--remerge-diff",
          "--text",
          "--no-textconv",
          "--no-ext-diff",
          "--no-renames",
          "--no-color",
          "--no-relative",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--format=%x00commit %H%n%B",
          sha,
          "--not",
          ...not,
        ],
        { maxBuffer: PUSH_SCAN_MAX_BUFFER },
      );
      const listed = (
        await g(["log", "--format=%x00%H%x00%B", sha, "--not", ...not], {
          maxBuffer: PUSH_SCAN_MAX_BUFFER,
        })
      ).split("\0");
      const messages: { sha: string; body: string }[] = [];
      for (let i = 1; i + 1 < listed.length; i += 2) {
        messages.push({ sha: listed[i] ?? "", body: listed[i + 1] ?? "" });
      }
      const wanted = new Set(commits.map((c) => c.sha));
      if (messages.length !== wanted.size || !messages.every((m) => wanted.has(m.sha))) {
        throw new Error("the commit messages could not be read");
      }
      const finding = [
        ...scanSecrets(patch, known),
        ...messages.flatMap((m) => scanText(`commit ${m.sha.slice(0, 7)}`, m.body, known)),
      ][0];
      if (finding !== undefined) {
        store.addGuardHit({
          agentId: seat.id,
          runId,
          rule: "secret",
          text: engineHitText("secret", "push"),
          at: now(),
        });
        bus.emit("guard");
        // the seat cannot rewrite the commit: the Blocked note tells the operator, naming where only
        return { text: pushSecretText(finding.where, finding.line, finding.kind), isError: true };
      }
      // nothing in a message may notify or close anything on GitHub (oldest commit first)
      const notifier = { repo: repoOf(deps, run), issue: issueOf(run) };
      for (const m of [...messages].reverse()) {
        const what = firstNamedRef(m.body) ?? firstCommitNotifier(m.body, notifier);
        if (what !== null) return { text: pushReferenceText(m.sha, what), isError: true };
      }

      // 6. the push: plain, never forced, this branch only
      try {
        await g([
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--no-recurse-submodules",
          "origin",
          `${sha}:refs/heads/${branch}`,
        ]);
      } catch (e) {
        const out = (e as { stdout?: unknown } | null)?.stdout;
        if (typeof out === "string" && /^!\t[^\t]*\t\[rejected\]/m.test(out)) {
          return { text: originMovedText(branch), isError: true };
        }
        throw e;
      }
      store.setRunPush({ runId, sha, at: now() });
      bus.emit("agents");
      return { text: pushedText(sha, branch) };
    }
  });
}

/** The run's repo as `owner/name`; "" for a repo no longer configured (matches nothing). */
function repoOf(deps: McToolsDeps, run: Run): string {
  return deps.config.repos.find((r) => r.id === run.repoId)?.github ?? "";
}

/**
 * The PR body as opened: the seat's, the closing line unless it already closes the run's issue
 * (a plain mention does not), then the hub's line. The caller has refused a body that ends in an
 * open block.
 */
function prBody(body: string, repo: string, issue: number | null, call: string): string {
  const parts = [body.trimEnd()];
  if (issue !== null && !closesIssue(body, { repo, issue })) parts.push(prClosesLine(issue));
  parts.push(prOpenedByLine(call));
  return `${parts.join("\n\n")}\n`;
}

/** Text the hub posts to GitHub (a PR's title or body, an evidence note) and what is wrong with it. */
export type PrTextProblem =
  | { problem: "secret"; where: string; line: number; secret: string }
  | { problem: "named"; ref: string }
  | { problem: "notify"; first: string }
  | { problem: "unclosed" };

/** The order the checks run in, across texts: the first problem found is the one reported. */
const PR_PROBLEM_ORDER: readonly PrTextProblem["problem"][] = [
  "secret",
  "named",
  "notify",
  "unclosed",
];

/**
 * The first problem with `text` as GitHub text, else null: a secret (`known` verbatim or by
 * pattern; `label` names the text in the finding), a named character reference, a mention or
 * reference to an item other than the run's own, and (when `unclosed`) an unclosed code or HTML
 * block. Shared by `openDraftPr` and `report_evidence`, so their text rules cannot drift.
 */
export function prTextProblem(
  text: string,
  own: {
    repo: string;
    issue: number | null;
    known: readonly string[];
    label: string;
    unclosed?: boolean;
    /** `#n` of the repo's own issues pass: FLIGHT's tickets and comments only. */
    allowOwnRepoRefs?: boolean;
  },
): PrTextProblem | null {
  const finding = scanText(own.label, text, own.known)[0];
  if (finding !== undefined) {
    return { problem: "secret", where: finding.where, line: finding.line, secret: finding.kind };
  }
  const ref = firstNamedRef(text);
  if (ref !== null) return { problem: "named", ref };
  const first = firstPrNotifier(text, {
    repo: own.repo,
    issue: own.issue,
    allowOwnRepoRefs: own.allowOwnRepoRefs === true,
  });
  if (first !== null) return { problem: "notify", first };
  if (own.unclosed === true && unclosedMarkdown(text)) return { problem: "unclosed" };
  return null;
}

/** What `prTextProblem` found, as a clause for a refusal text. Never the secret itself. */
export function evidenceProblemText(p: PrTextProblem): string {
  switch (p.problem) {
    case "secret":
      return `${p.where}:${p.line} looks like a ${p.secret}`;
    case "named":
      return `${p.ref} is an HTML character reference`;
    case "notify":
      return p.first;
    case "unclosed":
      return "the note ends inside an unclosed code or HTML block";
  }
}

/** Each run's last draft_pr call. */
const prQueue = new Map<string, Promise<unknown>>();

/**
 * Mission Control's draft PR: one draft PR for the run's pushed branch, with no mention or reference to
 * another item in its text. gh runs in `{DB dir}/crew/`, reading the body from a 0600 file there.
 */
export function openDraftPr(
  deps: McToolsDeps,
  runId: string,
  pr: { title: string; body: string },
): Promise<Result> {
  // one at a time per run, whoever calls (the MCP server, or the engine directly): a second call
  // finds the first one's PR open
  return queued(prQueue, runId, () => draftPr(deps, runId, pr));
}

/** Runs `fn` after every earlier call under `key` in `queue` has settled, one at a time. */
export function queued<T>(queue: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>) {
  const prev = queue.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  queue.set(key, tail);
  void tail.then(() => {
    if (queue.get(key) === tail) queue.delete(key);
  });
  return next;
}

/** Each ticket's last report_plan call. */
const planQueue = new Map<string, Promise<unknown>>();

async function draftPr(
  deps: McToolsDeps,
  runId: string,
  pr: { title: string; body: string },
): Promise<Result> {
  const { store, bus } = deps;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? crewGit;
  const place = writerPlace(deps, runId, "draft_pr");
  if ("text" in place) return place;
  const { seat, session } = place;
  const call = seatCallSign(seat.id);
  const known = await readKnown(deps, "draft_pr");

  // the branch's tip must be what this run put on origin (in the queue: no commit lands meanwhile)
  const checked = await deps.inClone(session.checkout, async () => {
    const run = liveRunOf(store, runId);
    if (run === null || run.branch === null) return ENDED;
    const pushed = store.runPush(runId);
    const common = await realpath(join(session.checkout, ".git"));
    const g = (a: string[]) =>
      git(session.checkout, a, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS });
    const tip = await g(["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}^{commit}`])
      .then((x) => x.trim())
      .catch(() => null);
    if (pushed === null || pushed.sha !== tip) return { text: MC_PUSH_FIRST, isError: true };
    return { run, branch: run.branch, g };
  });
  if ("text" in checked) return checked;
  const { run, branch } = checked;
  const repo = deps.config.repos.find((r) => r.id === run.repoId)?.github;
  if (repo === undefined) return ENDED;

  const issue = issueOf(run);
  const own = { repo, issue, known };
  // the worst problem across title and body, in the order the checks run: secret, named
  // reference, notifier, unclosed block
  const problem = [
    prTextProblem(pr.title, { ...own, label: "PR title" }),
    prTextProblem(pr.body, { ...own, label: "PR body", unclosed: true }),
  ]
    .filter((p): p is PrTextProblem => p !== null)
    .sort((a, b) => PR_PROBLEM_ORDER.indexOf(a.problem) - PR_PROBLEM_ORDER.indexOf(b.problem))[0];
  if (problem?.problem === "secret") {
    store.addGuardHit({
      agentId: seat.id,
      runId,
      rule: "secret",
      text: engineHitText("secret", "draft PR"),
      at: now(),
    });
    bus.emit("guard");
    return { text: prSecretText(problem.where, problem.line, problem.secret), isError: true };
  }
  if (problem?.problem === "named") return { text: prNamedRefText(problem.ref), isError: true };
  if (problem?.problem === "notify") return { text: prNotifyText(problem.first), isError: true };
  if (problem?.problem === "unclosed") return { text: MC_PR_UNCLOSED, isError: true };

  const cwd = crewDir(deps.dbPath);
  const failed = (what: string, r: { code: number | null; stderr: string }): Result => {
    deps.log?.(redact(`mc draft_pr: gh ${what} failed (${String(r.code)}): ${r.stderr}`, known));
    return { text: MC_PR_FAILED, isError: true };
  };
  let defaultBranch: string;
  try {
    defaultBranch = originHeads(
      await checked.g(["ls-remote", "--symref", "origin", "HEAD"]),
      null,
    ).defaultBranch;
  } catch (e) {
    deps.log?.(redact(`mc draft_pr: could not read origin (${runId}): ${failure(e)}`, known));
    return { text: MC_PR_FAILED, isError: true };
  }

  const listed = await deps.gh(
    ["pr", "list", `--repo=${repo}`, `--head=${branch}`, "--state=open", "--json=url"],
    { cwd },
  );
  if (listed.code !== 0) return failed("pr list", listed);
  let open: unknown;
  try {
    open = JSON.parse(listed.stdout);
  } catch {
    return failed("pr list", { code: listed.code, stderr: "not JSON" });
  }
  if (!Array.isArray(open)) return failed("pr list", { code: listed.code, stderr: "not a list" });
  const url = (open[0] as { url?: unknown } | undefined)?.url;
  if (open.length > 0) {
    return { text: prAlreadyOpenText(typeof url === "string" ? url : "(no URL given)") };
  }

  const file = crewPrBodyPath(deps.dbPath);
  try {
    await writeFile(file, prBody(pr.body, repo, issue, call), { mode: 0o600, flag: "wx" });
    const made = await deps.gh(
      [
        "pr",
        "create",
        `--repo=${repo}`,
        "--draft",
        `--head=${branch}`,
        `--base=${defaultBranch}`,
        `--title=${pr.title}`,
        `--body-file=${file}`,
      ],
      { cwd },
    );
    if (made.code !== 0) return failed("pr create", made);
    const line = made.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!/^https:\/\/\S+$/.test(line)) return failed("pr create", { code: 0, stderr: "no URL" });
    return { text: line };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Replaces the body of the run's own open PR (the hub's own PR; spec §12 deviation 2). The body
 * passes the same text checks as `openDraftPr`'s, and gh is asked first whether the PR is open on
 * the run's branch.
 */
export async function editRunPrBody(
  deps: McToolsDeps,
  runId: string,
  prNumber: number,
  body: string,
): Promise<Result> {
  const { store, bus } = deps;
  const now = deps.now ?? Date.now;
  const place = writerPlace(deps, runId, "pr_body");
  if ("text" in place) return place;
  // not liveRunOf: a run its seat no longer holds (set aside for review) is still edited
  const run = store.run(runId);
  if (run === null || run.endedAt !== null || run.branch === null) return ENDED;
  const repo = repoOf(deps, run);
  const issue = issueOf(run);
  const known = await readKnown(deps, "pr_body");
  const problem = prTextProblem(body, { repo, issue, known, label: "PR body", unclosed: true });
  if (problem !== null) {
    if (problem.problem === "secret") {
      store.addGuardHit({
        agentId: place.seat.id,
        runId,
        rule: "secret",
        text: engineHitText("secret", "PR body edit"),
        at: now(),
      });
      bus.emit("guard");
    }
    return { text: MC_PR_BODY_REFUSED, isError: true };
  }

  const cwd = crewDir(deps.dbPath);
  const failed = (what: string, r: { code: number | null; stderr: string }): Result => {
    deps.log?.(redact(`mc pr_body: gh ${what} failed (${String(r.code)}): ${r.stderr}`, known));
    return { text: MC_PR_EDIT_FAILED, isError: true };
  };
  const viewed = await deps.gh(
    ["pr", "view", String(prNumber), `--repo=${repo}`, "--json=headRefName,state"],
    { cwd },
  );
  if (viewed.code !== 0) return failed("pr view", viewed);
  let info: { headRefName?: unknown; state?: unknown } | null;
  try {
    info = JSON.parse(viewed.stdout) as typeof info;
  } catch {
    return failed("pr view", { code: viewed.code, stderr: "not JSON" });
  }
  if (info?.state !== "OPEN" || info.headRefName !== run.branch) {
    return { text: prNotRunsText(prNumber), isError: true };
  }

  const file = crewPrBodyPath(deps.dbPath);
  try {
    await writeFile(file, prBody(body, repo, issue, seatCallSign(place.seat.id)), {
      mode: 0o600,
      flag: "wx",
    });
    const edited = await deps.gh(
      ["pr", "edit", String(prNumber), `--repo=${repo}`, `--body-file=${file}`],
      { cwd },
    );
    if (edited.code !== 0) return failed("pr edit", edited);
    return { text: prEditedText(prNumber) };
  } finally {
    await rm(file, { force: true });
  }
}

/** Another open writer run whose changes share paths with a commit. */
export interface Clash {
  seatId: string;
  ticket: string;
  paths: string[];
}

/**
 * The other open writer runs on the run's repo that changed any of `paths`, in their worktree or
 * on their branch. A run whose changes cannot be read fails the check closed.
 */
export async function clashesWith(
  deps: McToolsDeps,
  run: Run,
  paths: readonly string[],
  known: readonly string[],
): Promise<{ clashes: Clash[] } | { unreadable: { seatId: string; ticket: string } }> {
  const git = deps.git ?? crewGit;
  const clashes: Clash[] = [];
  for (const o of deps.store.liveSeatRuns()) {
    if (o.run.id === run.id || o.run.repoId !== run.repoId) continue;
    const place = seatPlace(deps.config, o.seatId);
    if (place === null || seatDef(place.seat).mode !== "writer") continue;
    const ticket = o.run.ticket ?? o.run.id;
    const theirs = new Set<string>();
    try {
      const common = await realpath(join(place.session.checkout, ".git"));
      const span =
        o.run.branch !== null && o.run.branch !== run.branch
          ? deps.store.branchCommitSpan(run.repoId, o.run.branch)
          : null;
      if (span !== null) {
        if (!SHA.test(span.first) || !SHA.test(span.last)) throw new Error("bad sha");
        const out = await git(
          place.session.checkout,
          ["diff", "--name-only", "-z", "--no-renames", `${span.first}^`, span.last, "--"],
          common,
          { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS },
        );
        for (const name of out.split("\0")) if (name !== "") theirs.add(name);
      }
      const gitDir = o.worktree === null ? null : await adminDirOf(common, o.worktree);
      if (o.worktree !== null && gitDir !== null) {
        const status = await git(
          o.worktree,
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            ...COMMIT_ADD_PATHSPEC,
          ],
          common,
          { gitDir, timeoutMs: CREW_GIT_SLOW_MS },
        );
        for (const p of changedPaths(status)) theirs.add(p);
      }
    } catch (e) {
      deps.log?.(redact(`mc commit: could not read ${o.run.id}'s changes: ${failure(e)}`, known));
      return { unreadable: { seatId: o.seatId, ticket } };
    }
    const shared = paths.filter((p) => theirs.has(p)).sort();
    if (shared.length > 0) clashes.push({ seatId: o.seatId, ticket, paths: shared });
  }
  return { clashes };
}

export function createMcTools(deps: McToolsDeps): McTool[] {
  const { config, store, bus } = deps;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? crewGit;

  /** The seat's live run, as the store has it now, or null when the call's run is not it. */
  function liveRun(ctx: McToolContext): { run: Run; worktree: string | null } | null {
    const row = store.seatSession(ctx.seatId);
    const run = store.run(ctx.runId);
    if (row?.runId !== ctx.runId || run === null || run.endedAt !== null) return null;
    return { run, worktree: row.worktree };
  }

  async function commit(ctx: McToolContext, args: unknown): Promise<Result> {
    const parsed = CommitArgs.safeParse(args);
    if (!parsed.success) return badArgs(parsed.error);
    const place = seatPlace(config, ctx.seatId);
    if (place === null) return { text: MC_RUN_ENDED, isError: true };
    if (seatDef(place.seat).mode !== "writer") return { text: MC_READ_ONLY_COMMIT, isError: true };
    const { seat, session } = place;
    const { message, remove } = parsed.data;
    // before the clone's queue, as the push reads them: a slow `gh auth token` holds no one up
    const known = await readKnown(deps, "commit");

    return deps.inClone(session.checkout, async () => {
      // Checked here, in the queue: a commit that waited behind a slow checkout must not land
      // after its run ended (or re-record strays the run's end cleared).
      const live = liveRun(ctx);
      if (live === null || live.worktree === null || live.run.branch === null) {
        return { text: MC_RUN_ENDED, isError: true };
      }
      const { run, worktree } = live;
      const branch = live.run.branch;
      // a message GitHub would act on is refused now, while the seat can still reword it; once
      // committed, only the operator can (the push checks again, as the backstop)
      const named = firstNamedRef(message);
      if (named !== null) return { text: commitNamedRefText(named), isError: true };
      const what = firstCommitNotifier(message, { repo: repoOf(deps, run), issue: issueOf(run) });
      if (what !== null) return { text: commitReferenceText(what), isError: true };
      const common = await realpath(join(session.checkout, ".git"));
      // the worktree's git dir as the clone registered it: never as the worktree's pointer says
      const gitDir = await adminDirOf(common, worktree);
      if (gitDir === null) throw new Error("the run's worktree is not registered in the clone");
      const g = (
        a: string[],
        o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
      ) => git(worktree, a, common, { gitDir, ...o });
      /** The merge in progress in the worktree (MERGE_HEAD), or null. */
      let mergeHead: string | null = null;
      // A pathless reset deletes MERGE_HEAD: during a merge the index stays as the seat left it.
      const reset = async (): Promise<void> => {
        if (mergeHead === null) await g(["reset", "-q"], { timeoutMs: CREW_GIT_SLOW_MS });
      };

      const head = await g(["symbolic-ref", "--quiet", "HEAD"]).then(
        (s) => s.trim(),
        () => null, // detached
      );
      if (head !== `refs/heads/${branch}`) return { text: notOnBranchText(branch), isError: true };
      mergeHead = await g(["rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}"]).then(
        (s) => s.trim(),
        (e: unknown) => {
          if ((e as { code?: unknown } | null)?.code === 1) return null;
          throw e;
        },
      );
      // only the merge of main that Mission Control started may be committed
      if (mergeHead !== null && mergeHead !== run.loop?.mainMerge?.mainSha) {
        return { text: MC_COMMIT_MERGE_UNKNOWN, isError: true };
      }

      let committed = false;
      /** HEAD before the commit ran; null until it starts. */
      let before: string | null = null;
      let result: Result;
      const writers = session.seats.filter((s) => s.id !== seat.id && seatDef(s).mode === "writer");
      /** The repo's own protected globs, on top of PROTECTED_FILES. */
      const extra = config.repos.find((r) => r.id === run.repoId)?.protectedFiles ?? [];
      /** What this call has deleted so far: every answer from then on says so. */
      const removed: string[] = [];
      /** The advisory lines about files another open run changed; appended to a commit's answer. */
      let clashNotes: string[] = [];
      const say = (r: Result): Result =>
        removed.length > 0 ? { ...r, text: `${removedText(removed)}\n${r.text}` } : r;
      try {
        const early = await removeFiles();
        if (early !== null) return early;
        await g(["add", "-A", ...COMMIT_ADD_PATHSPEC], { timeoutMs: CREW_GIT_SLOW_MS });
        result = await checkAndCommit();
      } catch (e) {
        if (timedOut(e) && !overflowed(e) && before !== null) {
          // the commit may have landed before git was killed: then it is the run's, and said so
          const after = await g(["rev-parse", "--verify", "HEAD"]).then(
            (x) => x.trim(),
            () => before,
          );
          if (after !== null && after !== before) {
            await reset().catch(() => {});
            return say(await recordCommit(after));
          }
        }
        // whatever failed, the index goes back to HEAD: nothing stays staged for a later commit
        await reset().catch(() => {});
        if (overflowed(e)) return say({ text: MC_COMMIT_TOO_BIG, isError: true });
        if (timedOut(e)) return say({ text: MC_COMMIT_TOO_SLOW, isError: true });
        throw e;
      }
      // Every answer but a commit leaves the index as HEAD has it (Nothing to commit included:
      // `add -A` may have staged what the diff did not show).
      if (!committed) await reset();
      return say(result);

      /**
       * The files the call lists in `remove`: every path is checked first, and one refusal deletes
       * nothing. Null when the commit goes on; else the answer.
       */
      async function removeFiles(): Promise<Result | null> {
        const listed = [...new Set(remove ?? [])];
        if (listed.length === 0) return null;
        const worktreeReal = await realpath(worktree);
        const outside: string[] = [];
        const others = new Map<string, string[]>();
        const kept: string[] = [];
        const foreign: string[] = [];
        const notFile: string[] = [];
        const linked: string[] = [];
        const missing: string[] = [];
        const deletes: string[] = [];
        for (const p of listed) {
          if (NOT_PRINTABLE_ASCII.test(p)) {
            foreign.push(p);
            continue;
          }
          if (isProtectedPath(p, extra)) {
            kept.push(p);
            continue;
          }
          const h = headEntryKind(
            await g(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", "HEAD", "--", p]),
            p,
          );
          const w = await worktreeEntry(worktreeReal, p, false);
          if (h === "folder" || h === "nested" || w === "folder") notFile.push(p);
          else if (w === "linked") linked.push(p);
          else if (h === "none" && w === "missing") missing.push(p);
          else if (h === "file" && !pathInArea(seat.area, p)) {
            const owner = writers.find((x) => pathInArea(x.area, p));
            if (owner === undefined) outside.push(p);
            else {
              const call = seatCallSign(owner.id);
              others.set(call, [...(others.get(call) ?? []), p]);
            }
          } else {
            if (w === "file") deletes.push(p);
          }
        }
        if (
          outside.length > 0 ||
          others.size > 0 ||
          kept.length > 0 ||
          foreign.length > 0 ||
          notFile.length > 0 ||
          linked.length > 0 ||
          missing.length > 0
        ) {
          const lines = [
            ...(outside.length > 0 ? [outsideAreaText(outside, seat.area)] : []),
            ...[...others].map(([call, ps]) => otherAreaText(ps, call)),
            ...(kept.length > 0 ? [protectedPathsText(kept)] : []),
            ...(foreign.length > 0 ? [nonAsciiPathsText(foreign)] : []),
            ...(notFile.length > 0 ? [removeNotFileText(notFile)] : []),
            ...(linked.length > 0 ? [removeLinkedText(linked)] : []),
            ...(missing.length > 0 ? [removeMissingText(missing)] : []),
            MC_REMOVE_REFUSED,
          ];
          return { text: lines.join("\n"), isError: true };
        }
        for (const p of deletes) {
          let seen: Awaited<ReturnType<typeof worktreeEntry>> | null = null;
          try {
            seen = await worktreeEntry(worktreeReal, p, true);
          } catch {
            // fails closed below
          }
          if (seen === "file") removed.push(p);
          else if (seen !== "missing") {
            return say({ text: MC_REMOVE_FAILED, isError: true });
          }
        }
        return null;
      }

      async function recordCommit(sha: string): Promise<Result> {
        const subject = (await g(["log", "-1", "--format=%s", sha, "--"])).trim();
        store.addRunCommit({ runId: run.id, repoId: run.repoId, branch, sha, at: now() });
        bus.emit("agents");
        const text = committedText(sha, branch, subject);
        return { text: clashNotes.length > 0 ? `${text}\n\n${clashNotes.join("\n")}` : text };
      }

      /** Those of the staged `paths` with a conflict marker line (`<<<<<<< ` or `>>>>>>> `). */
      async function withConflictMarkers(paths: readonly string[]): Promise<string[]> {
        const found: string[] = [];
        for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
          const out = await g(
            [
              "--literal-pathspecs",
              "grep",
              "--cached",
              "-I",
              "-l",
              "-z",
              "-E",
              "-e",
              "^(<<<<<<<|>>>>>>>) ",
              "--",
              ...paths.slice(i, i + PATHSPEC_CHUNK),
            ],
            { timeoutMs: CREW_GIT_SLOW_MS },
          ).catch((e: unknown) => {
            // exit 1: no match
            if ((e as { code?: unknown } | null)?.code === 1) return "";
            throw e;
          });
          found.push(...out.split("\0").filter((p) => p !== ""));
        }
        return found;
      }

      async function checkAndCommit(): Promise<Result> {
        // --ignore-submodules=none: a `.gitmodules` `ignore = all` would hide a staged gitlink
        const entries = stagedEntries(
          await g(
            [
              "diff",
              "--cached",
              "--raw",
              "-z",
              "--no-abbrev",
              "-M",
              "--ignore-submodules=none",
              "HEAD",
              "--",
            ],
            { timeoutMs: CREW_GIT_SLOW_MS },
          ),
        );
        let listing: string;
        try {
          listing = await g(["ls-files", "-s", "-z"], {
            timeoutMs: CREW_GIT_SLOW_MS,
            maxBuffer: INDEX_LIST_MAX_BUFFER,
          });
        } catch (e) {
          if (overflowed(e)) return { text: MC_INDEX_UNLISTABLE, isError: true };
          throw e;
        }
        const former = await filledFormerSubmodules(worktree, listing);
        const paths = [...new Set(entries.flatMap((e) => e.paths))];
        const special = new Set(
          entries.flatMap((e) =>
            e.newPath !== null && SPECIAL_MODES.has(e.mode) ? [e.newPath] : [],
          ),
        );

        // During a merge of main, a staged path whose index entry equals MERGE_HEAD's brings in
        // only main's version of it.
        const fromMain = new Set<string>();
        if (mergeHead !== null) {
          const left = (
            await g(["ls-files", "-u", "-z"], {
              timeoutMs: CREW_GIT_SLOW_MS,
              maxBuffer: INDEX_LIST_MAX_BUFFER,
            })
          )
            .split("\0")
            .flatMap((l) => (l.includes("\t") ? [l.slice(l.indexOf("\t") + 1)] : []));
          if (left.length > 0) {
            return { text: commitUnresolvedText([...new Set(left)]), isError: true };
          }
          const differs = new Set(
            (
              await g(["diff", "--cached", "--name-only", "--no-renames", "-z", mergeHead, "--"], {
                timeoutMs: CREW_GIT_SLOW_MS,
                maxBuffer: INDEX_LIST_MAX_BUFFER,
              })
            ).split("\0"),
          );
          for (const p of paths) if (!differs.has(p)) fromMain.add(p);
        }
        const own = paths.filter((p) => !fromMain.has(p));

        const outside: string[] = [];
        const others = new Map<string, string[]>();
        const kept: string[] = [];
        const links: string[] = [];
        const foreign: string[] = [];
        const strays: { path: string; kind: StrayKind }[] = [];
        for (const p of paths) {
          if (NOT_PRINTABLE_ASCII.test(p)) {
            // fail closed, before any other check: no name of this kind is committed
            foreign.push(p);
          } else if (fromMain.has(p)) {
            // main's own version of the path: no area, protected or stray check applies
            if (special.has(p)) links.push(p);
          } else if (isProtectedPath(p, extra)) {
            kept.push(p);
          } else if (!pathInArea(seat.area, p)) {
            const owner = writers.find((w) => pathInArea(w.area, p));
            if (owner === undefined) {
              outside.push(p);
              strays.push({ path: p, kind: "outside" });
            } else {
              const call = seatCallSign(owner.id);
              others.set(call, [...(others.get(call) ?? []), p]);
              strays.push({ path: p, kind: "other-area" });
            }
          } else if (special.has(p)) {
            links.push(p);
          }
        }

        // The seat's strays this commit no longer has were reverted: they go; the rest are
        // recorded (again), so a path it touched twice keeps one item.
        const at = now();
        const still = new Set(strays.map((s) => s.path));
        const gone = store
          .strays()
          .filter((s) => s.sessionId === session.id && s.agentId === seat.id && !still.has(s.path))
          .map((s) => s.path);
        if (gone.length > 0) store.clearStrays(session.id, gone);
        if (strays.length > 0) {
          store.addStrays(
            strays.map((s) => ({ sessionId: session.id, agentId: seat.id, at, ...s })),
          );
        }
        if (gone.length > 0 || strays.length > 0) bus.emit("attention");

        const refused =
          outside.length > 0 ||
          others.size > 0 ||
          links.length > 0 ||
          kept.length > 0 ||
          former.length > 0 ||
          foreign.length > 0;
        if (refused) {
          const lines = [
            ...(outside.length > 0 ? [outsideAreaText(outside, seat.area)] : []),
            ...[...others].map(([call, ps]) => otherAreaText(ps, call)),
            ...(links.length > 0 ? [specialPathsText(links)] : []),
            ...(kept.length > 0 ? [protectedPathsText(kept)] : []),
            ...(former.length > 0 ? [formerSubmoduleText(former)] : []),
            ...(foreign.length > 0 ? [nonAsciiPathsText(foreign)] : []),
            REVERT_STRAYS,
          ];
          return { text: lines.join("\n"), isError: true };
        }
        // a merge commits even with nothing to add: it joins main's history
        if (paths.length === 0 && mergeHead === null) return { text: NOTHING_TO_COMMIT };

        if (mergeHead !== null) {
          const marked = await withConflictMarkers(
            entries.flatMap((e) =>
              e.newPath !== null && !fromMain.has(e.newPath) ? [e.newPath] : [],
            ),
          );
          if (marked.length > 0) return { text: commitMarkersText(marked), isError: true };
        }

        // Two open runs changing one file may give two conflicting PRs. That is only worth a
        // note (the controller resolves a conflict at merge); it never stops a commit, and a run
        // whose changes cannot be read adds no note.
        const clash = await clashesWith(deps, run, own, known);
        if (!("unreadable" in clash)) {
          clashNotes = clash.clashes.map((c) =>
            clashText(c.paths, seatCallSign(c.seatId), c.ticket),
          );
        }

        // No secret goes into a commit, while the seat can still take it out (once committed,
        // only the operator can): every staged added line, read as the push reads them (as stored,
        // renames as whole files), and the message. `scanSecrets` reads log output, so the
        // staged diff goes in as one commit with no message.
        // (a merge leaves out the paths that are main's own: they are on GitHub already)
        const stagedDiff = (only: readonly string[]) =>
          g(
            [
              ...(only.length > 0 ? ["--literal-pathspecs"] : []),
              "diff",
              "--cached",
              "--text",
              "--no-textconv",
              "--no-ext-diff",
              "--no-renames",
              "--no-color",
              "--no-relative",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "HEAD",
              "--",
              ...only,
            ],
            { timeoutMs: CREW_GIT_SLOW_MS, maxBuffer: PUSH_SCAN_MAX_BUFFER },
          );
        let staged = "";
        if (fromMain.size === 0) staged = await stagedDiff([]);
        for (let i = 0; fromMain.size > 0 && i < own.length; i += PATHSPEC_CHUNK) {
          staged += await stagedDiff(own.slice(i, i + PATHSPEC_CHUNK));
        }
        const secret = [
          ...scanSecrets(`\0commit staged\n${staged}`, known),
          ...scanText("commit message", message, known),
        ][0];
        if (secret !== undefined) {
          store.addGuardHit({
            agentId: seat.id,
            runId: run.id,
            rule: "secret",
            text: mcToolHitText("secret", "commit"),
            at: now(),
          });
          bus.emit("guard");
          return { text: commitSecretText(secret.where, secret.line, secret.kind), isError: true };
        }

        const name = crewAuthorName(seatCallSign(seat.id));
        before = (await g(["rev-parse", "--verify", "HEAD"])).trim();
        await g(
          [
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--no-verify",
            "--cleanup=whitespace",
            `--message=${message}`,
          ],
          { env: { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name }, timeoutMs: CREW_GIT_SLOW_MS },
        );
        committed = true;
        return recordCommit((await g(["rev-parse", "--verify", "HEAD"])).trim());
      }
    });
  }

  async function askOperator(ctx: McToolContext, args: unknown): Promise<Result> {
    const parsed = AskArgs.safeParse(args);
    if (!parsed.success) return badArgs(parsed.error);
    const live = liveRun(ctx);
    if (live === null) return { text: MC_RUN_ENDED, isError: true };
    const at = now();
    store.addQuestion({
      agentId: ctx.seatId,
      runId: ctx.runId,
      text: parsed.data.question,
      at,
    });
    store.addComms({
      at,
      from: ctx.seatId,
      to: COMMS_CAPCOM,
      ticket: live.run.ticket ?? null,
      text: parsed.data.question,
    });
    bus.emit("attention");
    bus.emit("agents");
    return { text: ASKED_OPERATOR };
  }

  /** The refusal the run's loop alone decides (no loop, parked, in CI), else null. */
  function loopRefusal(loop: Run["loop"]): Result | null {
    if (loop === null || loop === undefined) return { text: EVIDENCE_NO_LOOP, isError: true };
    if (loop.phase === "parked") return { text: EVIDENCE_PARKED, isError: true };
    if (loop.phase === "ci") return { text: EVIDENCE_IN_CI, isError: true };
    return null;
  }

  async function reportEvidence(ctx: McToolContext, args: unknown): Promise<Result> {
    const parsed = EvidenceArgs.safeParse(args);
    if (!parsed.success) return badArgs(parsed.error);
    const note = parsed.data.note;
    const place = seatPlace(config, ctx.seatId);
    const first = liveRun(ctx);
    if (place === null || first === null) return ENDED;
    // a fast path: these refusals need no gh token read (the queue checks them again)
    const early = loopRefusal(first.run.loop);
    if (early !== null) return early;
    const known = await readKnown(deps, "report_evidence");

    // in the clone's queue: a commit in flight lands before the worktree is read
    const refusal = await deps.inClone(place.session.checkout, async (): Promise<Result | null> => {
      const live = liveRun(ctx);
      if (live === null || live.worktree === null) return ENDED;
      const { run } = live;
      // the loop as the queue sees it: the reconciler may have moved it while this waited
      const loop = run.loop;
      const refused = loopRefusal(loop);
      if (refused !== null) return refused;
      if (loop === null || loop === undefined) return ENDED; // unreachable: loopRefusal said so
      const common = await realpath(join(place.session.checkout, ".git"));
      const gitDir = await adminDirOf(common, live.worktree);
      if (gitDir === null) throw new Error("the run's worktree is not registered in the clone");
      const status = await git(
        live.worktree,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...COMMIT_ADD_PATHSPEC],
        common,
        { gitDir, timeoutMs: CREW_GIT_SLOW_MS },
      );
      const dirty = changedPaths(status);
      if (dirty.length > 0) return { text: evidenceUncommittedText(dirty), isError: true };

      const newest = store.newestRunCommit(run.id);
      const reported = store.latestEvidence(run.id);
      const fresh =
        newest !== null &&
        (reported === null || newest.at > reported.at) &&
        newest.sha !== loop.ciFailedSha;
      if (!fresh && !note.startsWith(EVIDENCE_RULING_PREFIX)) {
        return { text: EVIDENCE_NO_COMMIT, isError: true };
      }

      const problem = prTextProblem(note, {
        repo: repoOf(deps, run),
        issue: issueOf(run),
        known,
        label: "evidence note",
        unclosed: true,
      });
      if (problem !== null) {
        if (problem.problem === "secret") {
          store.addGuardHit({
            agentId: ctx.seatId,
            runId: run.id,
            rule: "secret",
            text: mcToolHitText("secret", "report_evidence"),
            at: now(),
          });
          bus.emit("guard");
        }
        return { text: evidenceTextText(evidenceProblemText(problem)), isError: true };
      }
      store.addEvidence(run.id, note, now());
      return null;
    });
    if (refusal !== null) return refusal;
    bus.emit("agents");
    deps.onEvidence?.(ctx.seatId, ctx.runId);
    return { text: EVIDENCE_RECORDED };
  }

  async function reportFindings(ctx: McToolContext, args: unknown): Promise<Result> {
    const parsed = FindingsArgs.safeParse(args);
    if (!parsed.success) return badArgs(parsed.error);
    const { verdict, summary, findings } = parsed.data;
    const live = liveRun(ctx);
    if (live === null) return ENDED;
    const { run } = live;
    const review = run.reviewId == null ? null : store.review(run.reviewId);
    if (review === null || review.runId !== run.id) {
      return { text: FINDINGS_NOT_A_REVIEW, isError: true };
    }
    if (review.state === "reported") return { text: FINDINGS_ALREADY };
    if (review.state !== "running") return { text: FINDINGS_DROPPED, isError: true };
    const badFile = findings.findIndex((f) => !findingFileOk(f.file));
    if (badFile !== -1) return { text: findingFileText(badFile + 1), isError: true };
    const blocking = findings.filter((f) => BLOCKING_SEVERITIES.includes(f.severity)).length;
    if ((verdict.spec === "fail" || verdict.quality === "fail") && blocking === 0) {
      return { text: FINDINGS_FAIL_NEEDS_BLOCKING, isError: true };
    }
    if (blocking > 0 && verdict.spec === "pass" && verdict.quality === "pass") {
      return { text: FINDINGS_BLOCKING_NEEDS_FAIL, isError: true };
    }
    const at = now();
    if (!store.recordFindings(review.id, run.id, { verdict, summary, findings, at })) {
      const again = store.review(review.id);
      return again?.state === "reported"
        ? { text: FINDINGS_ALREADY }
        : { text: FINDINGS_DROPPED, isError: true };
    }
    store.addLoopEvent(
      `${review.authorRunId}:review:${review.id}:reported`,
      review.authorRunId,
      reviewedEventText(seatCallSign(ctx.seatId), review.sha, blocking, findings.length - blocking),
      at,
    );
    bus.emit("agents");
    deps.onFindings?.(ctx.seatId, ctx.runId);
    return { text: FINDINGS_RECORDED };
  }

  async function reportPlan(ctx: McToolContext, args: unknown): Promise<Result> {
    const parsed = PlanArgs.safeParse(args);
    if (!parsed.success) return badArgs(parsed.error);
    const plan = parsed.data.plan;
    const live = liveRun(ctx);
    if (live === null) return ENDED;
    const { run } = live;
    const place = seatPlace(config, ctx.seatId);
    if (place === null) return ENDED;
    if (seatDef(place.seat).loop !== "plan") return { text: MC_PLAN_NOT_FAO, isError: true };
    const issue = issueOf(run);
    const repo = repoOf(deps, run);
    if (issue === null || repo === "") return ENDED;
    const call = seatCallSign(ctx.seatId);
    const override: ProfileOverride | undefined =
      parsed.data.profile !== undefined && parsed.data.profile_reason !== undefined
        ? { profile: parsed.data.profile, reason: parsed.data.profile_reason, by: "planner" }
        : undefined;
    if (override !== undefined) {
      const profiles = deps.profiles?.() ?? DEFAULT_PROFILES;
      if (profiles instanceof Error) {
        return { text: planNoProfilesText(profiles.message), isError: true };
      }
      if (!profiles.some((p) => p.name === override.profile)) {
        return {
          text: planUnknownProfileText(
            override.profile,
            profiles.map((p) => p.name),
          ),
          isError: true,
        };
      }
    }
    const known = await readKnown(deps, "report_plan");

    const problem = prTextProblem(plan, { repo, issue, known, label: "plan", unclosed: true });
    if (problem !== null) {
      if (problem.problem === "secret") {
        store.addGuardHit({
          agentId: ctx.seatId,
          runId: run.id,
          rule: "secret",
          text: mcToolHitText("secret", "report_plan"),
          at: now(),
        });
        bus.emit("guard");
      }
      return { text: planTextText(evidenceProblemText(problem)), isError: true };
    }

    const written = await queued(planQueue, `${run.repoId}#${issue}`, async (): Promise<Result> => {
      const cwd = crewDir(deps.dbPath);
      const failed = (what: string, r: { code: number | null; stderr: string }): Result => {
        deps.log?.(
          redact(`mc report_plan: gh ${what} failed (${String(r.code)}): ${r.stderr}`, known),
        );
        return { text: MC_PLAN_GH_FAILED, isError: true };
      };
      const viewed = await deps.gh(
        ["issue", "view", String(issue), `--repo=${repo}`, "--json=body,state"],
        { cwd },
      );
      if (viewed.code !== 0) return failed("issue view", viewed);
      let issueJson: { body?: unknown; state?: unknown };
      try {
        issueJson = JSON.parse(viewed.stdout) as { body?: unknown; state?: unknown };
      } catch {
        return failed("issue view", { code: viewed.code, stderr: "not JSON" });
      }
      if (typeof issueJson !== "object" || issueJson === null) {
        return failed("issue view", { code: viewed.code, stderr: "not an object" });
      }
      if (issueJson.state !== "OPEN") return { text: MC_PLAN_ISSUE_CLOSED, isError: true };
      const body = String(issueJson.body ?? "");
      if (PLAN_HEADING_LINE.test(body)) return { text: MC_PLAN_ALREADY, isError: true };
      if (unclosedMarkdown(body)) return { text: MC_PLAN_BODY_UNCLOSED, isError: true };

      const tests = planTestCount(plan);
      if (tests === null) return { text: MC_PLAN_NO_TESTS, isError: true };
      const doneWhen = doneWhenCount(body);
      if (tests < doneWhen) return { text: planFewTestsText(tests, doneWhen), isError: true };
      if (live.worktree !== null) {
        const missing: string[] = [];
        for (const p of planPaths(plan)) {
          try {
            await lstat(join(live.worktree, p));
          } catch {
            missing.push(p);
          }
        }
        if (missing.length > 0) return { text: planMissingPathsText(missing), isError: true };
      }

      const next = [
        body.trim() === "" ? "" : `${body.trimEnd()}\n\n`,
        `${PLAN_HEADING}\n\n${plan.trim()}\n\n`,
        `${planByLine(call)}\n`,
      ].join("");
      if (Array.from(next).length > TICKET_BODY_MAX) {
        const room = TICKET_BODY_MAX - (Array.from(next).length - Array.from(plan.trim()).length);
        return {
          text: room > 0 ? planTooLongText(TICKET_BODY_MAX, room) : MC_PLAN_NO_ROOM,
          isError: true,
        };
      }

      const file = crewPrBodyPath(deps.dbPath);
      try {
        await writeFile(file, next, { mode: 0o600, flag: "wx" });
        const edited = await deps.gh(
          ["issue", "edit", String(issue), `--repo=${repo}`, `--body-file=${file}`],
          { cwd },
        );
        if (edited.code !== 0) return failed("issue edit", edited);
      } finally {
        await rm(file, { force: true });
      }
      return { text: MC_PLAN_WRITTEN };
    });
    if (written.isError === true) return written;
    const at = now();
    if (override !== undefined) store.setProfileOverride(run.repoId, issue, override, at);
    const planned = planWrittenText(run.ticket ?? run.id);
    store.addLoopEvent(`${run.id}:plan`, run.id, planned, at);
    const watcher = place.session.seats.find((s) => !s.retiring && seatDef(s).loop === "watch");
    store.addComms({
      at,
      from: ctx.seatId,
      to: watcher?.id ?? COMMS_CAPCOM,
      ticket: run.ticket ?? null,
      text: planned,
    });
    bus.emit("agents");
    deps.onPlanned?.(ctx.seatId, ctx.runId);
    return written;
  }

  return [
    {
      name: MC_TOOL_NAMES.commit,
      description:
        "Commit every change in your worktree to your run's branch. Mission Control makes the commit: you cannot run git commit yourself. To delete files, list them in remove: Mission Control deletes them first, then commits the deletions with your other changes. A change outside your area, in another agent's area, to a protected file (build, install and CI config), or a symlink or nested repository refuses the whole commit and is reported to the operator; revert it and commit again. A file another agent's open run has also changed does not stop the commit: the answer carries a note naming that agent and ticket, as the two PRs may conflict at merge. A file in remove that may not be deleted refuses the call before anything is deleted; files deleted before a later refusal stay deleted.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            minLength: 1,
            maxLength: MC_TEXT_MAX,
            description: "The commit message: a conventional subject line, then an optional body.",
          },
          remove: {
            type: "array",
            maxItems: MC_REMOVE_MAX,
            items: { type: "string", minLength: 1, maxLength: MC_REMOVE_PATH_MAX },
            description:
              "Files to delete, as paths from the repo's top (apps/server/src/old.ts); files only, not folders. Each must be in your area, unless it is a new file your branch doesn't have yet.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      modes: ["writer"],
      call: commit,
    },
    {
      name: MC_TOOL_NAMES.askOperator,
      description:
        "Ask the operator a question you cannot answer from the ticket, the code or the repo. The answer arrives later as a message; carry on with what you can meanwhile.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: MC_TEXT_MAX,
            description: "The question, with the context the operator needs to answer it.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      modes: ["writer", "read-only"],
      call: askOperator,
    },
    {
      name: MC_TOOL_NAMES.reportEvidence,
      description:
        "Report that the ticket's work is done and committed: a short note of what changed and how to deploy it. Mission Control pushes, opens the draft PR and runs CI, and messages you if CI fails. Commit everything first with mc commit; the note is posted to GitHub, so it may not @mention anyone or reference any issue but your ticket, inside backticks too.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            minLength: 1,
            maxLength: MC_EVIDENCE_MAX,
            description:
              "What changed and how to deploy it. Start with Ruling: to report a decision with no change.",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
      modes: ["writer", "read-only"],
      call: reportEvidence,
    },
    {
      name: MC_TOOL_NAMES.reportFindings,
      description:
        "Report your review, once, when you are done: every finding at every severity, each with file, line (0 for the whole file), a one-line summary, a failure scenario and the exact fix, plus your verdict on spec and quality. Mission Control decides what happens next: Critical and Important findings go back to the author to fix; Minor ones are logged in the PR body. An empty list with pass verdicts means nothing to fix.",
      inputSchema: {
        type: "object",
        properties: {
          verdict: {
            type: "object",
            properties: {
              spec: {
                type: "string",
                enum: [...VERDICTS],
                description: "Does the change do what the ticket asks?",
              },
              quality: {
                type: "string",
                enum: [...VERDICTS],
                description: "Is it correct and tested?",
              },
            },
            required: ["spec", "quality"],
            additionalProperties: false,
          },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: REVIEW_SUMMARY_MAX,
            description: "Two or three sentences on the change as a whole.",
          },
          findings: {
            type: "array",
            maxItems: REVIEW_FINDINGS_MAX,
            items: {
              type: "object",
              properties: {
                severity: {
                  type: "string",
                  enum: [...FINDING_SEVERITIES],
                  description:
                    "Critical: wrong behaviour, data loss, a security hole or an opened gate. Important: a real bug in a likely case, a missing test, a ticket requirement not met. Minor: anything else.",
                },
                file: {
                  type: "string",
                  minLength: 1,
                  maxLength: FINDING_FILE_MAX,
                  description: "Repo-relative path.",
                },
                line: {
                  type: "integer",
                  minimum: 0,
                  maximum: 1_000_000,
                  description: "1-based line; 0 for the whole file.",
                },
                summary: {
                  type: "string",
                  minLength: 1,
                  maxLength: FINDING_SUMMARY_MAX,
                  description: "One line: what is wrong.",
                },
                scenario: {
                  type: "string",
                  minLength: 1,
                  maxLength: FINDING_SCENARIO_MAX,
                  description: "The inputs or steps, and what goes wrong.",
                },
                fix: {
                  type: "string",
                  minLength: 1,
                  maxLength: FINDING_FIX_MAX,
                  description: "The exact change to make: what to write, and where.",
                },
              },
              required: ["severity", "file", "line", "summary", "scenario", "fix"],
              additionalProperties: false,
            },
          },
        },
        required: ["verdict", "summary", "findings"],
        additionalProperties: false,
      },
      modes: ["scratch"],
      call: reportFindings,
    },
    {
      name: MC_TOOL_NAMES.reportPlan,
      description:
        "Write your plan into the ticket, once, when it is finished: Mission Control appends it to the issue body under ## Plan, for the developer's brief, then ends this run. It is posted to GitHub: no @mentions, no other issues' numbers, no secrets, no unclosed code blocks.",
      inputSchema: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            minLength: 1,
            maxLength: MC_PLAN_MAX,
            description:
              "The plan alone, with no heading of your own: Mission Control adds ## Plan.",
          },
          profile: {
            type: "string",
            pattern: PROFILE_NAME.source,
            description:
              "Another template profile for the developer to run, if the one picked does not fit. Give profile_reason with it.",
          },
          profile_reason: {
            type: "string",
            minLength: 1,
            maxLength: PROFILE_REASON_MAX,
            description: "Why that template fits better; recorded with the choice.",
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
      modes: [],
      grantable: ["read-only"],
      call: reportPlan,
    },
  ];
}
