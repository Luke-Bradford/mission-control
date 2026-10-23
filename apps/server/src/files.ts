/**
 * What a loop's worktree changed, for the Agent page's Files tab. Read-only git only: the live
 * loops are observed, so every call passes `--no-optional-locks` (never takes the index lock or
 * rewrites the index) and, on a git that knows it, `--no-lazy-fetch` (a partial clone never fetches
 * blobs into its object store), turns fsmonitor off (never starts a daemon in their worktree), ignores the global and
 * system attributes files, and runs with no `GIT_*` variable from the server's environment
 * (`GIT_ATTR_SOURCE`, `GIT_DIR`, `GIT_CONFIG_PARAMETERS`…). `diff` also refuses external diff
 * drivers and textconv, and never looks inside submodules (`--ignore-submodules=all`: a status
 * inside a stat-dirty submodule would run that submodule's filters).
 *
 * `git diff HEAD` compares the work tree, and for a file whose stat changed it runs the file's
 * clean filter, a configured program (git-lfs's writes into `.git/lfs/objects`). So the
 * uncommitted diff only runs once the repo's attributes are known to name no `filter=`: every
 * `.gitattributes` git lists, ignored ones included (one it tracks but is missing from disk counts
 * as a filter, since git then reads the index copy), `info/attributes`, and no `attr.tree` setting; otherwise it is
 * skipped and the note says so. The committed range (`origin/HEAD...HEAD`) compares two trees and
 * `ls-files --others` lists names only: neither runs a filter.
 *
 * `fileDiff` shows one listed file with the same calls, limited to that path; an untracked file is
 * read from disk only when its real path is inside the worktree.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { type ChangedFiles, DIFF_MAX_CHARS, type FileDiff } from "@mc/core";
import { cleanText } from "./clean.ts";

const execFileP = promisify(execFile);

export const GIT_TIMEOUT_MS = 5000;
export const GIT_MAX_BUFFER = 4 * 1024 * 1024;
export const FILES_MAX = 200;
export const NO_ORIGIN_HEAD_NOTE = "no origin/HEAD: showing uncommitted changes only";
export const NO_WORKTREE_NOTE = "No worktree: this seat has no run on it.";
export const FILTERS_NOTE = "repo uses git filters: uncommitted changes not read";
const FILTERS_UNKNOWN_NOTE = "could not check for git filters: uncommitted changes not read";
/** An attribute line that sets a filter driver (a macro's `[attr]x filter=y` included). */
const FILTER_ATTR = /(^|\s)filter=/m;

/** Runs git with these arguments and returns its stdout; rejects on failure. */
export type GitExec = (args: string[]) => Promise<string>;

/**
 * git's environment: the server's, less every `GIT_*` variable (none may point git at another
 * repo, attribute source or config), with the system-wide attributes file off.
 */
export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_")) out[k] = v;
  out.GIT_ATTR_NOSYSTEM = "1";
  return out;
}

/** No shell; 5 s timeout; 4 MiB of output at most. */
export const realGitExec: GitExec = async (args) =>
  (
    await execFileP("git", args, {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      env: gitEnv(process.env),
    })
  ).stdout;

/**
 * Per git runner: the `--no-lazy-fetch` probe (git 2.44+). Only a success is kept: a failure may
 * be transient (a timeout, a busy machine), so the next call probes again.
 */
const lazyFetchProbe = new WeakMap<GitExec, Promise<boolean>>();

/**
 * `--no-lazy-fetch` when this git knows it (`git --no-lazy-fetch version` exits 0), else nothing:
 * an older git refuses the unknown option and every call would fail. A git that old predates lazy
 * fetching in diff and ls-files too.
 */
function noLazyFetch(exec: GitExec): Promise<string[]> {
  let probe = lazyFetchProbe.get(exec);
  if (!probe) {
    const p = exec(["--no-lazy-fetch", "version"]).then(
      () => true,
      () => {
        if (lazyFetchProbe.get(exec) === p) lazyFetchProbe.delete(exec);
        return false;
      },
    );
    probe = p;
    lazyFetchProbe.set(exec, p);
  }
  return probe.then((ok) => (ok ? ["--no-lazy-fetch"] : []));
}

/** Every git call failed: nothing can be shown. */
export class GitFailed extends Error {
  /** The git subcommand that failed (`diff`, `ls-files`…) and its exit code (or spawn error code). */
  readonly command: string | null;
  readonly exitCode: number | string | null;
  /** The signal that ended it (`SIGTERM` on a timeout, when there is no exit code). */
  readonly signal: string | null;
  /** What the filter check found before everything failed (fixed text), so it is not lost. */
  readonly note: string | null;

  constructor(
    message = "git failed",
    detail: {
      command?: string | null;
      exitCode?: number | string | null;
      signal?: string | null;
      note?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "GitFailed";
    this.command = detail.command ?? null;
    this.exitCode = detail.exitCode ?? null;
    this.signal = detail.signal ?? null;
    this.note = detail.note ?? null;
  }
}

const HEAD_MOVED_MESSAGE = "HEAD moved while the files were read";
/** A list is read again this many times when a commit lands during it. */
const READ_ATTEMPTS = 2;

function signalOf(e: unknown): string | null {
  const signal = (e as { signal?: unknown } | null)?.signal;
  return typeof signal === "string" ? signal : null;
}

/** The subcommand of a git argument list: the first word that is not an option or an option's value. */
function subcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return a;
  }
  return null;
}

function exitCodeOf(e: unknown): number | string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? code : null;
}

type FileRow = ChangedFiles["files"][number];

const count = (s: string | undefined): number | null =>
  s !== undefined && /^\d+$/.test(s) ? Number(s) : null;

/** `--numstat -z`: `add\tdel\tpath\0` per file; a binary file has `-` counts. */
function parseNumstat(out: string, state: FileRow["state"]): FileRow[] {
  const rows: FileRow[] = [];
  for (const rec of out.split("\0")) {
    const m = /^([^\t]*)\t([^\t]*)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    rows.push({ path: m[3] as string, add: count(m[1]), del: count(m[2]), state });
  }
  return rows;
}

const parseUntracked = (out: string): FileRow[] =>
  out
    .split("\0")
    .filter((p) => p !== "")
    .map((path) => ({ path, add: null, del: null, state: "untracked" as const }));

/** A file's text; null when it does not exist; throws on any other read failure. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Whether a filter may apply in this worktree: `attr.tree` is set (attributes come from a tree),
 * or an attributes file names one: the root and every nested `.gitattributes` git lists (tracked
 * or not ignored; a listed one missing from disk counts, as git reads the index copy), and
 * `info/attributes` in the common git dir. Throws when that cannot be known.
 */
async function usesFilters(worktree: string, base: string[], exec: GitExec): Promise<boolean> {
  const pathspec = ["--", ".gitattributes", ":(glob)**/.gitattributes"];
  const [listed, ignored, commonDir, attrTree] = await Promise.all([
    exec([...base, "ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspec]),
    // ignored ones apply too; --directory stops at a wholly ignored directory (listed with a
    // trailing `/`, and holding no tracked file a diff could filter) instead of walking it
    exec([
      ...base,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      ...pathspec,
    ]),
    exec([...base, "rev-parse", "--git-common-dir"]),
    exec([...base, "config", "--default", "", "--get", "attr.tree"]),
  ]);
  if (attrTree.trim() !== "") return true;
  const listedFiles = `${listed}\0${ignored}`
    .split("\0")
    .filter((p) => p !== "" && !p.endsWith("/"))
    .map((p) => join(worktree, p));
  for (const f of listedFiles) {
    const text = await readIfExists(f);
    if (text === null || FILTER_ATTR.test(text)) return true;
  }
  const common = commonDir.trim();
  for (const f of [
    join(worktree, ".gitattributes"),
    join(isAbsolute(common) ? common : join(worktree, common), "info", "attributes"),
  ]) {
    if (FILTER_ATTR.test((await readIfExists(f)) ?? "")) return true;
  }
  return false;
}

/** The read-only arguments every call in a worktree starts with (see the module comment). */
async function readOnlyBase(worktree: string, exec: GitExec): Promise<string[]> {
  return [
    "--no-optional-locks",
    ...(await noLazyFetch(exec)),
    "-c",
    "core.fsmonitor=false",
    "-C",
    worktree,
    "-c",
    "core.attributesFile=/dev/null",
  ];
}

/** `diff` with no external driver, textconv or submodule look-inside; a rename is a delete and an add. */
const SAFE_DIFF = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=all",
  "--no-renames",
];

/** The committed range: the branch's own commits since it left `origin/HEAD` (from the merge base). */
const COMMITTED_RANGE = "origin/HEAD...HEAD";

export async function changedFiles(
  worktree: string,
  exec: GitExec = realGitExec,
): Promise<ChangedFiles> {
  return (await listChanged(worktree, exec)).list;
}

/** HEAD's sha, or null when git cannot name it. */
const headSha = (base: string[], exec: GitExec): Promise<string | null> =>
  exec([...base, "rev-parse", "--verify", "HEAD"]).then(
    (out) => out.trim() || null,
    () => null,
  );

/**
 * The list, and for each listed (cleaned) path the path exactly as git gave it. The reads are
 * several git calls, so HEAD is named before and after: a commit landing between them makes the
 * list a mix of two states, so it is read again, and a HEAD that moves every time is GitFailed.
 */
async function listChanged(
  worktree: string,
  rawExec: GitExec,
): Promise<{ list: ChangedFiles; raw: Map<string, string> }> {
  // The probe is cached per runner, so it gets the caller's, not the wrapper.
  const base = await readOnlyBase(worktree, rawExec);
  for (let attempt = 1; ; attempt++) {
    const before = await headSha(base, rawExec);
    const read = await readChanged(worktree, rawExec, base);
    if ((await headSha(base, rawExec)) === before) {
      return { list: { ...read.list, sha: before }, raw: read.raw };
    }
    if (attempt >= READ_ATTEMPTS) throw new GitFailed(HEAD_MOVED_MESSAGE);
  }
}

async function readChanged(
  worktree: string,
  rawExec: GitExec,
  base: string[],
): Promise<{ list: Omit<ChangedFiles, "sha">; raw: Map<string, string> }> {
  // The first call to fail, kept for GitFailed: its command, code and signal, never git's message.
  let firstFailure: ConstructorParameters<typeof GitFailed>[1];
  const exec: GitExec = (args) =>
    rawExec(args).catch((e: unknown) => {
      firstFailure ??= { command: subcommand(args), exitCode: exitCodeOf(e), signal: signalOf(e) };
      throw e;
    });
  // -z: paths unquoted, one per record.
  const diff = (range: string) => [...base, ...SAFE_DIFF, "--numstat", "-z", range];
  const notes: string[] = [];
  // The uncommitted diff waits for the filter check; it is never run when one may apply.
  const worktreeDiff = async (): Promise<string | null> => {
    let filtered: boolean;
    try {
      filtered = await usesFilters(worktree, base, exec);
    } catch {
      notes.push(FILTERS_UNKNOWN_NOTE);
      return null;
    }
    if (filtered) {
      notes.push(FILTERS_NOTE);
      return null;
    }
    return exec(diff("HEAD"));
  };
  const [committed, uncommitted, untracked] = await Promise.allSettled([
    exec(diff(COMMITTED_RANGE)),
    worktreeDiff(),
    exec([...base, "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const read = [committed, uncommitted, untracked].filter(
    (r) => r.status === "fulfilled" && r.value !== null,
  );
  // The notes so far come from the filter check alone: they stay with the failure.
  if (read.length === 0) {
    throw new GitFailed("git failed", { ...firstFailure, note: notes.join(" · ") || null });
  }

  // The branch's own commits; the usual failure is a clone with no origin/HEAD.
  if (committed.status === "rejected") notes.unshift(NO_ORIGIN_HEAD_NOTE);
  if (uncommitted.status === "rejected") notes.push("git could not read uncommitted changes");
  if (untracked.status === "rejected") notes.push("git could not list untracked files");

  // Later states replace earlier ones: a committed file edited again is uncommitted.
  const byPath = new Map<string, FileRow>();
  const raw = new Map<string, string>();
  const rows = [
    ...(committed.status === "fulfilled" ? parseNumstat(committed.value, "committed") : []),
    ...(uncommitted.status === "fulfilled" && uncommitted.value !== null
      ? parseNumstat(uncommitted.value, "uncommitted")
      : []),
    ...(untracked.status === "fulfilled" ? parseUntracked(untracked.value) : []),
  ];
  for (const r of rows) {
    const path = cleanText(r.path);
    byPath.delete(path); // re-inserted last, so the order follows the latest state
    byPath.set(path, { ...r, path });
    raw.set(path, r.path);
  }
  const all = [...byPath.values()];
  for (const row of all.slice(0, FILES_MAX)) {
    row.commitSha = null;
    if (row.state !== "committed") continue;
    try {
      const sha = (
        await exec([
          ...base,
          "log",
          "--no-show-signature",
          "--no-patch",
          "-1",
          "--format=%H",
          "origin/HEAD..HEAD",
          "--",
          `:(literal)${raw.get(row.path)}`,
        ])
      ).trim();
      if (/^[a-f0-9]{40,64}$/.test(sha)) row.commitSha = sha;
    } catch {
      notes.push("git could not read a file commit");
    }
  }
  if (all.length > FILES_MAX) notes.push(`showing the first ${FILES_MAX} of ${all.length} files`);
  const note = notes.length > 0 ? notes.join(" · ") : null;
  return { list: { files: all.slice(0, FILES_MAX), note }, raw };
}

/** An untracked file is read this far at most: enough bytes for DIFF_MAX_CHARS characters. */
const UNTRACKED_READ_MAX = DIFF_MAX_CHARS * 4;
/** git's own binary test: a NUL in the first 8000 bytes. */
const BINARY_SNIFF = 8000;
/** Node's error when a child's stdout passed maxBuffer; it carries what was read. */
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/** git's message (its stderr, else the error's own), with the worktree path taken out. */
function gitMessage(e: unknown, worktree: string): string {
  const { stderr, message } = (e ?? {}) as { stderr?: unknown; message?: unknown };
  const raw =
    typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(message ?? "git failed");
  return raw.trim().split(worktree).join("<worktree>");
}

/**
 * An untracked file's first UNTRACKED_READ_MAX bytes (`cut` when there is more); null unless it is
 * a regular file whose real path is inside the worktree's (a symlink out of it is never followed),
 * or when it cannot be read.
 */
async function readUntracked(
  worktree: string,
  path: string,
): Promise<{ bytes: Buffer; cut: boolean } | null> {
  let fh: FileHandle | undefined;
  try {
    const root = await realpath(worktree);
    const real = await realpath(join(root, path));
    if (!real.startsWith(root + sep)) return null;
    // O_NOFOLLOW: the resolved path is not swapped for a link meanwhile; O_NONBLOCK: a FIFO
    // never blocks the open.
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const bytes = Buffer.alloc(Math.min(st.size, UNTRACKED_READ_MAX));
    const { bytesRead } = await fh.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, bytesRead), cut: st.size > bytesRead };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * One file's diff for the Files tab. Only a path in the current `changedFiles` list, listed under
 * git's own name (cleaning left it unchanged), is read (null otherwise): `committed` → the committed range; `uncommitted` → `diff HEAD`, which a row in that
 * state shows the filter check passed for in this same call; `untracked` → the file's contents as
 * added lines. The same read-only calls as the list, plus `--no-color` and a literal pathspec.
 * A binary file (numstat's `-` counts, or a NUL as git tests) has no text. Cleaned and cut at
 * DIFF_MAX_CHARS. Throws GitFailed, with git's message less the worktree path, when git fails.
 */
export async function fileDiff(
  worktree: string,
  path: string,
  exec: GitExec = realGitExec,
): Promise<FileDiff | null> {
  const { list, raw } = await listChanged(worktree, exec);
  const row = list.files.find((f) => f.path === path);
  // A name cleaning changed (control characters, a redaction) is not the file git listed: the
  // cleaned name may be another, unlisted file (an ignored `.env`), so it is never read.
  if (!row || raw.get(path) !== path) return null;
  const { sha } = list;
  const binary: FileDiff = { path, text: "", truncated: false, binary: true, sha };
  const done = (raw: string, cut: boolean): FileDiff => {
    const text = cleanText(raw, DIFF_MAX_CHARS);
    // cleanText marks its own cut with `…`; text that only shrank below the cut is whole
    const truncated = cut || (raw.length > DIFF_MAX_CHARS && text.endsWith("…"));
    return { path, text, truncated, binary: false, sha };
  };

  if (row.state === "untracked") {
    const file = await readUntracked(worktree, path);
    if (!file) return null;
    if (file.bytes.subarray(0, BINARY_SNIFF).includes(0)) return binary;
    const lines = new TextDecoder().decode(file.bytes).split("\n");
    if (lines.at(-1) === "") lines.pop();
    return done(lines.map((l) => `+${l}`).join("\n"), file.cut);
  }
  if (row.add === null && row.del === null) return binary;

  // Against the commit the list was read at, so a commit landing since cannot empty the diff of a
  // file the list showed.
  const head = sha ?? "HEAD";
  const range = row.state === "committed" ? `origin/HEAD...${head}` : head;
  const base = await readOnlyBase(worktree, exec);
  try {
    return done(
      await exec([...base, ...SAFE_DIFF, "--no-color", range, "--", `:(literal)${path}`]),
      false,
    );
  } catch (e) {
    // past GIT_MAX_BUFFER: show what was read, cut
    const { code, stdout } = (e ?? {}) as { code?: unknown; stdout?: unknown };
    if (code === MAX_BUFFER_CODE && typeof stdout === "string") return done(stdout, true);
    throw new GitFailed(gitMessage(e, worktree));
  }
}
