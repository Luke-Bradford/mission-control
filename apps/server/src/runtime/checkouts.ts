/**
 * A crew run's checkout: a branch and a git worktree in Mission Control's own clone of the repo
 * (spec §5). The clone is Mission Control's, so git here writes (fetch, worktree add/remove), but
 * every call goes through `crewGit`: a seat writes inside its worktree and its branch, so nothing
 * it could have changed is trusted. The base of a new branch is read from origin itself, and a
 * reused branch is never reset. A start that fails leaves nothing it created behind.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  branchFor,
  CANNOT_START,
  codexPnpmStoreDir,
  DIFF_CUT_LINE,
  MC_TMP_DIR_NAME,
  PNPM_STORE_DIR_NAME,
  PNPM_STORE_ENV,
  REVIEW_DIFF_FILE,
  REVIEW_DIFF_MAX,
  REVIEW_DIFF_MAX_BUFFER,
  REVIEW_INPUT_DIR,
  REVIEW_SINCE_FILE,
  type SessionCheckoutOutcome,
  scratchName,
} from "@mc/core";
import { type CrewSessionConfig, managedSessionPath, realish, SEAT_ID } from "../config.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "../files.ts";
import {
  assertSeatGitConfig,
  crewGit,
  crewGitBytes,
  overflowed,
  SAFE_CONFIG,
  timedOut,
} from "./git.ts";

const execFileP = promisify(execFile);

async function checkSeatGitConfig(path: string): Promise<void> {
  await assertSeatGitConfig(path).catch((e: unknown) => {
    throw new CheckoutError(
      "worktree",
      `${CANNOT_START}: ${e instanceof Error ? e.message : "git config check failed"}`,
      { cause: e },
    );
  });
}

/** fetch, ls-remote, worktree add and remove (a whole tree written or deleted) can take over 5 s. */
export const CREW_GIT_SLOW_MS = 120_000;
/** The author and committer of the merge commit the hub makes. */
export const MC_MERGE_AUTHOR = "Mission Control";
export const mainMergeArgs = (branch: string, mainSha: string): string[] => [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "rerere.enabled=false",
  "merge",
  "--no-ff",
  "--no-edit",
  "--no-verify",
  "-m",
  `Merge main into ${branch}`,
  mainSha,
];

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const INSTALL_MAX_BUFFER = 16 * 1024 * 1024;
/**
 * What `pnpm install` reads (manifests in all three formats; pnpm 11 prefers `.pnpmfile.mjs`): a
 * branch whose copy of any of these is not origin's is not installed from.
 */
const PNPM_INPUTS = new Set([
  "package.json",
  "package.yaml",
  "package.json5",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
]);
const WORKSPACE_FILE = "pnpm-workspace.yaml";
/** Variables pnpm's CI detection reads. */
const CI_MARKERS = new Set([
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "RUN_ID",
  "GITHUB_ACTIONS",
]);
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/m;
const CHECKOUT_TEXT = "the crew checkout is missing or has uncommitted changes";

export type CheckoutErrorCode =
  | "checkout"
  | "fetch"
  | "base"
  | "branch"
  | "path"
  | "worktree"
  | "protected"
  | "install"
  | "dirty";

/**
 * A refused checkout. `message` is fixed text a route may send; `detail` (a path, git's own text)
 * is for the server log only.
 */
export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  readonly detail: string | null;
  constructor(
    code: CheckoutErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(message, options);
    this.name = "CheckoutError";
    this.code = code;
    this.detail = options?.detail ?? null;
  }
}

/** A folder whose git repository the crew clone must not share: the hub's checkout, a loop's worktree. */
export interface RepoPeer {
  /** How a refusal names it: `the hub's checkout`, `loop <id> worktree`. */
  label: string;
  dir: string;
}

/**
 * What the commit tool's `add -A` stages: the whole worktree except package stores, Python
 * environments, caches, build metadata and coverage output, at the top or nested. Codex's stable
 * pnpm store is under `.mc-tmp/`; Claude's caches live in its sandbox temp root. This is the
 * backstop for a repo that does not ignore the legacy `.pnpm-store`.
 */
export const COMMIT_ADD_PATHSPEC = [
  "--",
  ":(top)",
  `:(top,exclude,glob)**/${MC_TMP_DIR_NAME}/**`,
  `:(top,exclude,glob)**/${PNPM_STORE_DIR_NAME}/**`,
  ":(top,exclude,glob)**/__pycache__/**",
  ":(top,exclude,glob)**/.pytest_cache/**",
  ":(top,exclude,glob)**/.ruff_cache/**",
  ":(top,exclude,glob)**/.mypy_cache/**",
  ":(top,exclude,glob)**/.venv/**",
  ":(top,exclude,glob)**/.coverage",
  ":(top,exclude,glob)**/.coverage.*",
  ":(top,exclude,glob)**/.hypothesis/**",
  ":(top,exclude,glob)**/*.egg-info/**",
  ":(top,exclude,glob)**/.tox/**",
  ":(top,exclude,glob)**/.nox/**",
  ":(top,exclude,glob)**/htmlcov/**",
  ":(top,exclude,glob)**/.ipynb_checkpoints/**",
] as const;

/** Keep a worktree-local Codex store out of status as well as the commit pathspec. */
async function addMcTmpExclude(gitCommonDir: string): Promise<void> {
  const path = join(gitCommonDir, "info", "exclude");
  const line = `${MC_TMP_DIR_NAME}/`;
  await mkdir(dirname(path), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing.split("\n").includes(line)) return;
  await writeFile(path, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`, {
    mode: 0o600,
  });
}

/**
 * Create the stable Codex pnpm store before pnpm does. Checking each component before creating
 * the next prevents an untrusted worktree from redirecting the host install through a link.
 */
async function prepareCodexPnpmStore(worktree: string, name: string): Promise<void> {
  const privateDirectory = async (path: string, expected: string) => {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      (await realpath(path)) !== expected
    )
      throw new Error("Codex pnpm store must be a private directory owned by the server");
  };
  try {
    const root = await realpath(worktree);
    const tmp = join(root, MC_TMP_DIR_NAME);
    await privateDirectory(tmp, tmp);
    const store = codexPnpmStoreDir(root);
    await privateDirectory(store, store);
  } catch (e) {
    throw new CheckoutError(
      "install",
      `pnpm install failed for ${name} (private store unavailable)`,
      { cause: e },
    );
  }
}

export type ReuseSync =
  | { kind: "up-to-date" }
  | { kind: "merged"; sha: string; before: string }
  | { kind: "conflict"; mainSha: string; files: string[] }
  | { kind: "skipped"; why: "dirty" | "merging" | "failed" };

export interface PendingCheckouts {
  isPending(path: string): boolean;
  markPending(path: string): void;
  clearPending(path: string): void;
}

export interface CheckoutInput {
  /** Mission Control's clone of the repo (a session's `checkout`). */
  checkout: string;
  /** `crew.worktrees`. */
  worktreesRoot: string;
  /** The session's id: its worktrees are made in `{worktreesRoot}/{sessionId}`. */
  sessionId: string;
  seatId: string;
  issue: number;
  title: string;
  pending?: PendingCheckouts;
  /** Checked at this start against the clone's git repository; none given, none checked. */
  peers?: readonly RepoPeer[];
}

export interface Checkout {
  branch: string;
  /** `{worktreesRoot}/{sessionId}/{seatId}-{issue}`; an older run's is the flat `{worktreesRoot}/{seatId}-{issue}`. */
  path: string;
  /** false: this ticket's worktree already existed and is reused. */
  created: boolean;
  /** Porcelain status captured before syncing a reused ticket worktree. */
  leftoverChanges?: readonly string[];
  /** origin's default branch as origin reported it at the start; a new branch starts here. */
  baseSha: string;
  /** The worktree's own git dir, `<clone>/.git/worktrees/<name>` (for the seat's sandbox). */
  gitDir: string;
}

/** Why a git call failed, from its `fatal:` line. */
function gitReason(e: unknown): string {
  const stderr = String((e as { stderr?: unknown }).stderr ?? "");
  const fatal = stderr.split("\n").find((l) => l.startsWith("fatal: "));
  return fatal ? fatal.slice("fatal: ".length) : "git failed";
}

const succeeds = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

/**
 * The real path of `dir`'s git common directory, or null when git cannot say (a missing folder).
 * Read-only, as `gitCommonDir` in config.ts: hooks and fsmonitor off, no optional locks, no prompt
 * and none of the server's `GIT_*` settings. It runs in a live loop's worktree too.
 */
async function peerCommonDir(dir: string): Promise<string | null> {
  try {
    const r = await execFileP(
      "git",
      [
        ...SAFE_CONFIG,
        "--no-optional-locks",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return await realpath(r.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * The clone's `.git` (real path), once the checkout is a clean git top level and shares its git
 * repository with none of `peers`. A peer git cannot read is skipped, and checked again at the next
 * start. Nothing is written before this returns.
 */
export async function cloneGitDir(
  checkout: string,
  peers: readonly RepoPeer[] = [],
): Promise<string> {
  let common: string;
  try {
    common = await realpath(join(checkout, ".git"));
    const o = { gitDir: common };
    const top = (await crewGit(checkout, ["rev-parse", "--show-toplevel"], common, o)).trim();
    const status = await crewGit(
      checkout,
      ["--no-optional-locks", "status", "--porcelain"],
      common,
      o,
    );
    if ((await realpath(top)) !== (await realpath(checkout)) || status !== "") {
      throw new CheckoutError("checkout", CHECKOUT_TEXT);
    }
  } catch {
    // missing, not a repo, redirected: all the same to the operator
    throw new CheckoutError("checkout", CHECKOUT_TEXT);
  }
  for (const peer of peers) {
    if ((await peerCommonDir(peer.dir)) === common) {
      throw new CheckoutError(
        "checkout",
        `the crew clone shares its git repository with ${peer.label}`,
      );
    }
  }
  return common;
}

/**
 * The admin dir (`<common>/worktrees/<name>`) whose `gitdir` file names `path`, or null. Read from
 * the clone's side: a seat cannot write another worktree's admin dir or its own `gitdir`.
 */
export async function adminDirOf(common: string, path: string): Promise<string | null> {
  const want = await realpath(path).catch(() => null);
  if (want === null) return null;
  const dir = join(common, "worktrees");
  for (const name of await readdir(dir).catch(() => [])) {
    const pointer = (await readFile(join(dir, name, "gitdir"), "utf8").catch(() => "")).trim();
    if (!pointer || basename(pointer) !== ".git") continue;
    if ((await realpath(dirname(pointer)).catch(() => null)) === want) return join(dir, name);
  }
  return null;
}

/**
 * A pending path is owned by this start even if add never finished its metadata. Check its
 * location and any surviving pointers before removing it; never follow a redirected worktree.
 */
async function removePending(
  common: string,
  path: string,
  root: string,
  inClone: (args: string[], timeoutMs?: number) => Promise<string>,
): Promise<void> {
  const refuse = () => new CheckoutError("path", `${path} is not this run's checkout`);
  const rootPath = realish(root);
  const parent = realish(dirname(path));
  const expectedParent =
    resolve(dirname(path)) === resolve(root) ? rootPath : join(rootPath, basename(dirname(path)));
  if (parent !== expectedParent) throw refuse();
  const disk = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (disk !== null && !disk.isDirectory()) throw refuse();
  const adminRoot = join(common, "worktrees");
  const admins = new Set<string>();
  const dotGit = join(path, ".git");
  const pointer = await lstat(dotGit).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (pointer !== null) {
    if (!pointer.isFile()) throw refuse();
    const text = (await readFile(dotGit, "utf8")).trim();
    if (!text.startsWith("gitdir: ")) throw refuse();
    const admin = resolve(path, text.slice("gitdir: ".length));
    if (dirname(admin) !== adminRoot) throw refuse();
    admins.add(admin);
  }
  for (const name of await readdir(adminRoot).catch(() => [])) {
    const admin = join(adminRoot, name);
    const back = (await readFile(join(admin, "gitdir"), "utf8").catch(() => "")).trim();
    if (back && resolve(admin, back) === join(parent, basename(path), ".git")) admins.add(admin);
  }
  for (const admin of admins) {
    const stat = await lstat(admin).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (stat === null) continue;
    if (!stat.isDirectory() || (await realpath(admin)) !== admin) throw refuse();
    for (const file of ["gitdir", "commondir"]) {
      const entry = await lstat(join(admin, file)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      });
      if (entry === null) continue;
      if (!entry.isFile()) throw refuse();
      const value = (await readFile(join(admin, file), "utf8")).trim();
      const expected = file === "gitdir" ? join(parent, basename(path), ".git") : common;
      if (resolve(admin, value) !== expected) throw refuse();
    }
  }
  // Two forces also remove Git's "initializing" lock left by an interrupted add.
  await inClone(["worktree", "remove", "--force", "--force", "--", path], CREW_GIT_SLOW_MS).catch(
    () => {},
  );
  // Git cannot remove a registration with missing HEAD/commondir, or an orphan with no .git.
  await rm(path, { recursive: true, force: true });
  for (const admin of admins) await rm(admin, { recursive: true, force: true });
  await inClone(["worktree", "prune"]);
}

/**
 * Refuses a reused branch whose ref changes an install input, compared with origin's default
 * branch. The early message only: the ref can move, so `refuseChangedInputs` decides.
 */
async function refuseInstallInputs(
  inClone: (args: string[]) => Promise<string>,
  baseSha: string,
  rev: string,
  subject: string,
  inputs: ReadonlySet<string>,
): Promise<void> {
  let changed: string[];
  try {
    // --no-renames: a renamed .npmrc is listed under its old name too
    const out = await inClone([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "--end-of-options",
      `${baseSha}...${rev}`,
      "--",
    ]);
    changed = out.split("\0").filter(Boolean);
  } catch (e) {
    throw new CheckoutError(
      "protected",
      `could not compare ${subject} with origin; Mission Control won't install from it`,
      { cause: e },
    );
  }
  const hit = changed.find((f) => inputs.has(f.split("/").pop() ?? ""));
  if (hit !== undefined) {
    throw new CheckoutError(
      "protected",
      `${subject} changes ${hit}; Mission Control won't install from it`,
    );
  }
}

/**
 * The install, from the lockfile only: no lifecycle scripts, no `.pnpmfile.cjs`, and packages
 * cloned or copied out of the shared store, never hardlinked (a seat's writes inside its own
 * node_modules must not reach the store).
 */
export const INSTALL_ARGS = [
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--ignore-pnpmfile",
  "--package-import-method=clone-or-copy",
] as const;

const refuse = (subject: string, what: string) =>
  new CheckoutError("protected", `${subject} ${what}; Mission Control won't install from it`);

/**
 * Refuses a branch whose tree has a symlink or anything under the tool's install directory: the
 * host install could follow a committed link and write (or delete) outside the worktree. The
 * early, clearer refusal; `inspectDisk` is the check that counts.
 */
async function refuseUnsafeTree(
  inClone: (args: string[]) => Promise<string>,
  rev: string,
  subject: string,
  installDir: string,
): Promise<void> {
  let out: string;
  try {
    out = await inClone(["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", rev]);
  } catch (e) {
    throw new CheckoutError(
      "protected",
      `could not list ${subject}; Mission Control won't install from it`,
      { cause: e },
    );
  }
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const file = entry.slice(tab + 1);
    if (entry.startsWith("120000 ")) throw refuse(subject, `has a symlink at ${file}`);
    if (file.split("/").includes(installDir)) throw refuse(subject, `has ${file}`);
  }
}

/**
 * What makes the worktree on disk unsafe to install in, or null: any symlink (the top-level `.git`
 * pointer file aside; symlinked dirs are never followed), or any directory where `tool.installDir`
 * resolves. Every install input found on the way is added to `found`. Lookups go through the
 * filesystem (`lstat(join(dir, name))`), so its case and Unicode folding apply (a tracked
 * `NODE_MODULES` is `node_modules` on APFS). This, not the tree listing, is authoritative: the
 * ref another seat can move is not necessarily what was checked out.
 */
async function inspectDisk(
  root: string,
  tool: InstallTool,
  found: string[],
  rel = "",
): Promise<string | null> {
  const dir = join(root, rel);
  const prefix = rel ? `${rel}/` : "";
  if (await succeeds(lstat(join(dir, tool.installDir)))) return `has ${prefix}${tool.installDir}`;
  for (const name of tool.inputs) {
    if (await succeeds(lstat(join(dir, name)))) found.push(`${prefix}${name}`);
  }
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (rel === "" && d.name === ".git" && d.isFile()) continue;
    if (d.isSymbolicLink()) return `has a symlink at ${prefix}${d.name}`;
    if (d.isDirectory()) {
      const unsafe = await inspectDisk(root, tool, found, `${prefix}${d.name}`);
      if (unsafe !== null) return unsafe;
    }
  }
  return null;
}

const NOT_ORIGIN = "the clone's objects don't match origin";
const gitId = (type: string, body: Buffer) =>
  createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
type ObjectType = "commit" | "tree" | "blob";
/** `file` names the base file being read, for the text of a failed read. */
type ReadObject = (type: ObjectType, id: string, file: string) => Promise<Buffer>;

/** The largest base object read: a lockfile can pass the 4 MiB default. */
const BASE_OBJECT_MAX = 64 * 1024 * 1024;

/**
 * Reads objects from the clone, each re-hashed against the id asked for: a seat can rewrite loose
 * objects in the shared store, and git reads them back unverified. A read that fails says why
 * (too big, too slow, git's own failure); only an object that doesn't hash to its id is "not origin".
 */
function verifiedObjects(read: (args: string[], maxBuffer: number) => Promise<Buffer>): ReadObject {
  const seen = new Map<string, Buffer>();
  return async (type, id, file) => {
    const hit = seen.get(id);
    if (hit !== undefined) return hit;
    const body = await read(["cat-file", type, id], BASE_OBJECT_MAX).catch((e) => {
      // an overflowed child is `killed` too: ask about the overflow first
      const why = overflowed(e)
        ? `${file} in origin's default branch is over ${BASE_OBJECT_MAX / 1024 / 1024} MiB`
        : `could not read ${file} from the crew clone (${timedOut(e) ? "timed out" : "git failed"})`;
      throw new CheckoutError("protected", why, { cause: e });
    });
    if (gitId(type, body) !== id) throw new CheckoutError("protected", NOT_ORIGIN);
    seen.set(id, body);
    return body;
  };
}

/** A raw tree's entry for `name`: `<mode> <name>\0<20-byte id>` repeated. */
function treeEntry(tree: Buffer, name: string): { mode: string; id: string } | null {
  const want = Buffer.from(name);
  for (let i = 0; i < tree.length; ) {
    const sp = tree.indexOf(0x20, i);
    const nul = sp < 0 ? -1 : tree.indexOf(0, sp);
    if (nul < 0 || nul + 21 > tree.length) throw new CheckoutError("protected", NOT_ORIGIN);
    if (tree.subarray(sp + 1, nul).equals(want)) {
      return {
        mode: tree.toString("latin1", i, sp),
        id: tree.subarray(nul + 1, nul + 21).toString("hex"),
      };
    }
    i = nul + 21;
  }
  return null;
}

/** The verified entry at `file`, including non-regular entries, or null when absent. */
async function baseEntry(read: ReadObject, baseSha: string, file: string) {
  const head = (await read("commit", baseSha, file)).toString("latin1").split("\n", 1)[0] ?? "";
  const tree = /^tree ([0-9a-f]{40})$/.exec(head)?.[1];
  if (tree === undefined) throw new CheckoutError("protected", NOT_ORIGIN);
  let id = tree;
  const parts = file.split("/");
  for (const [k, part] of parts.entries()) {
    const e = treeEntry(await read("tree", id, file), part);
    if (e === null) return null;
    if (k === parts.length - 1) return e;
    if (e.mode !== "40000") return null;
    id = e.id;
  }
  return null;
}

/** The verified blob id of a regular file, or null. */
async function baseBlob(read: ReadObject, baseSha: string, file: string): Promise<string | null> {
  const entry = await baseEntry(read, baseSha, file);
  if (entry === null || (entry.mode !== "100644" && entry.mode !== "100755")) return null;
  await read("blob", entry.id, file);
  return entry.id;
}

/**
 * `file` (a repo-relative path) as it is in commit `baseSha` of the clone at `checkout`, read from
 * hash-verified objects as the install inputs are; null when it is not a regular file there (absent,
 * a symlink, a directory, a submodule). Throws `CheckoutError("protected", …)` when the clone's
 * objects don't hash to their ids, or the clone is not a sha1 repository (its own message). Reads
 * only.
 */
export async function readBaseFile(
  checkout: string,
  baseSha: string,
  file: string,
): Promise<Buffer | null> {
  const entry = await readBaseEntry(checkout, baseSha, file);
  return entry?.body ?? null;
}

/** Reads the tree mode and bytes through the same verified reader used by install inputs. */
export async function readBaseEntry(
  checkout: string,
  baseSha: string,
  file: string,
): Promise<{ mode: string; body: Buffer | null } | null> {
  const common = await realpath(join(checkout, ".git")).catch((e) => {
    throw new CheckoutError("checkout", CHECKOUT_TEXT, { cause: e });
  });
  const inClone = (args: string[], maxBuffer?: number) =>
    crewGitBytes(checkout, args, common, { gitDir: common, maxBuffer });
  const format = (
    await inClone(["rev-parse", "--show-object-format"]).catch((e) => {
      throw new CheckoutError("checkout", "could not read the crew clone", { cause: e });
    })
  )
    .toString("utf8")
    .trim();
  // the ids are re-hashed as sha1: a sha256 clone's would never match
  if (format !== "sha1") {
    throw new CheckoutError("protected", `the crew clone is a ${format} repository`);
  }
  const read = verifiedObjects(inClone);
  const entry = await baseEntry(read, baseSha, file);
  if (entry === null) return null;
  const regular = entry.mode === "100644" || entry.mode === "100755";
  return { mode: entry.mode, body: regular ? await read("blob", entry.id, file) : null };
}

/**
 * Install trust comes from content: every install input on disk must be, byte for byte, the file
 * at that path in origin's default branch, read from hash-verified objects.
 */
async function refuseChangedInputs(
  path: string,
  tool: InstallTool,
  inputs: string[],
  read: ReadObject,
  baseSha: string,
  subject: string,
): Promise<void> {
  // Without its root project/workspace file, the tool walks up to an ancestor's.
  for (const file of tool.rootInputs) {
    if (!inputs.includes(file) && (await baseBlob(read, baseSha, file)) !== null) {
      throw refuse(subject, `changes ${file}`);
    }
  }
  for (const file of inputs) {
    const expected = await baseBlob(read, baseSha, file);
    const onDisk = join(path, file);
    const actual = (await lstat(onDisk)).isFile() ? gitId("blob", await readFile(onDisk)) : null;
    if (expected === null || actual !== expected) throw refuse(subject, `changes ${file}`);
  }
}

/**
 * pnpm's environment for an install in `worktree`: the server's, without git's or a parent pnpm
 * run's settings and without CI markers, plus `CI=false` (ci-info then reports not-CI whatever
 * else is set; under CI pnpm purges a mismatched node_modules without asking) and the worktree as
 * the workspace root (pnpm never walks up to an ancestor's workspace).
 */
export function installEnv(worktree: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(gitEnv(process.env))) {
    if (!k.toLowerCase().startsWith("npm_") && !CI_MARKERS.has(k)) env[k] = v;
  }
  env.CI = "false";
  env.NPM_CONFIG_WORKSPACE_DIR = worktree;
  env[PNPM_STORE_ENV] = codexPnpmStoreDir(worktree);
  return env;
}

/**
 * Installs from the lockfile only and builds no sdist. The project, workspace and local deps are
 * never built. Packages are copied, so writes to `.venv` never reach uv's cache. Never passes
 * `--compile-bytecode`.
 */
export const UV_SYNC_ARGS = [
  "sync",
  "--no-config",
  "--no-python-downloads",
  "--frozen",
  "--no-build",
  "--no-install-workspace",
  "--no-install-local",
  "--link-mode=copy",
] as const;

/** Remove inherited Python settings and pin uv's environment to this worktree. */
export function uvInstallEnv(worktree: string): NodeJS.ProcessEnv {
  const env = installEnv(worktree);
  for (const key of Object.keys(env)) {
    if (key.startsWith("UV_") || key.startsWith("PIP_")) delete env[key];
  }
  for (const key of ["VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"]) {
    delete env[key];
  }
  env.UV_PROJECT_ENVIRONMENT = join(worktree, ".venv");
  return env;
}

interface InstallTool {
  label: string;
  command: string;
  lockfile: string;
  inputs: ReadonlySet<string>;
  rootInputs: readonly string[];
  required: readonly string[];
  installDir: string;
  args: readonly string[];
  env: (worktree: string) => NodeJS.ProcessEnv;
  reason: (out: string) => string | null;
}

const PNPM_TOOL: InstallTool = {
  label: "pnpm install",
  command: "pnpm",
  lockfile: "pnpm-lock.yaml",
  inputs: PNPM_INPUTS,
  rootInputs: [WORKSPACE_FILE],
  required: [],
  installDir: "node_modules",
  args: INSTALL_ARGS,
  env: installEnv,
  reason: (out) => /ERR_PNPM_[A-Z_]+/.exec(out)?.[0] ?? null,
};
const UV_TOOL: InstallTool = {
  label: "uv sync",
  command: "uv",
  lockfile: "uv.lock",
  inputs: new Set(["pyproject.toml", "uv.lock", "uv.toml", ".python-version"]),
  rootInputs: ["pyproject.toml", "uv.toml", ".python-version"],
  required: ["pyproject.toml"],
  installDir: ".venv",
  args: UV_SYNC_ARGS,
  env: uvInstallEnv,
  reason: () => null,
};
const INSTALL_TOOLS = [PNPM_TOOL, UV_TOOL];

/** Injectable process runner: tests never invoke a real uv. */
export type InstallRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
  },
) => Promise<unknown>;

/** The sandbox has no network, so dependencies are installed here, without running package code. */
async function install(
  tool: InstallTool,
  path: string,
  name: string,
  run: InstallRunner = execFileP,
): Promise<void> {
  try {
    await run(tool.command, [...tool.args], {
      cwd: path,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
      encoding: "utf8",
      env: tool.env(path),
    });
  } catch (e) {
    const x = e as { killed?: boolean; code?: unknown; stdout?: unknown; stderr?: unknown };
    if (tool === UV_TOOL && x.code === "ENOENT") {
      throw new CheckoutError("install", `uv sync failed for ${name} (uv not found)`, { cause: e });
    }
    const out = `${String(x.stdout ?? "")}\n${String(x.stderr ?? "")}`;
    const why = x.killed ? "timed out" : (tool.reason(out) ?? `exit ${String(x.code)}`);
    throw new CheckoutError("install", `${tool.label} failed for ${name} (${why})`, { cause: e });
  }
}

/**
 * Read registry assignments as TOML tokens, including quoted/escaped keys and dotted/table
 * syntax. This deliberately accepts only single-line strings (as emitted by uv); unsupported
 * string syntax fails closed instead of hiding a registry. uv validates the remaining grammar.
 */
function refuseUnsafeUvRegistries(lock: string, subject: string): void {
  const tokens: { value: string; string: boolean }[] = [];
  const token = /\s+|#[^\r\n]*|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'|[\w-]+|[^\s]/gy;
  for (const match of lock.matchAll(token)) {
    const raw = match[0];
    if (/^\s|^#/.test(raw)) continue;
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    let value = raw;
    if (quoted) {
      // Triple-quoted strings may contain otherwise meaningful tokens; refuse them entirely.
      if (lock.slice(match.index, match.index + 3) === raw[0].repeat(3) || raw.length < 2) {
        throw refuse(subject, "has unsupported string syntax in uv.lock");
      }
      try {
        value = raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
      } catch {
        throw refuse(subject, "has unsupported string syntax in uv.lock");
      }
    }
    tokens.push({ value, string: quoted });
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "registry" || tokens[i + 1]?.value !== "=" || tokens[i + 1]?.string) {
      continue;
    }
    const registry = tokens[i + 2];
    let valid = false;
    if (registry?.string && registry.value.startsWith("https://")) {
      try {
        valid = new URL(registry.value).protocol === "https:";
      } catch {}
    }
    if (!valid) throw refuse(subject, "has a non-HTTPS registry in uv.lock");
  }
}

/**
 * Every present tool's checks first, then the installs in table order (pnpm's symlinked
 * node_modules must not meet uv's disk check).
 */
async function installAll(
  s: {
    checkout: string;
    common: string;
    inClone: (args: string[]) => Promise<string>;
    path: string;
    rev: string;
    base: string;
    compare: boolean;
    subject: string;
    name: string;
  },
  run: InstallRunner,
): Promise<void> {
  const picked: InstallTool[] = [];
  for (const tool of INSTALL_TOOLS) {
    if (await succeeds(lstat(join(s.path, tool.lockfile)))) picked.push(tool);
  }
  for (const tool of picked) {
    await refuseUnsafeTree(s.inClone, s.rev, s.subject, tool.installDir);
    if (s.compare) await refuseInstallInputs(s.inClone, s.base, s.rev, s.subject, tool.inputs);
    const found: string[] = [];
    const unsafe = await inspectDisk(s.path, tool, found);
    if (unsafe !== null) throw refuse(s.subject, unsafe);
    const format = (await s.inClone(["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1") throw refuse(s.subject, `is in a ${format} repository`);
    const read = verifiedObjects((args, maxBuffer) =>
      crewGitBytes(s.checkout, args, s.common, { gitDir: s.common, maxBuffer }),
    );
    await refuseChangedInputs(s.path, tool, found, read, s.base, s.subject);
    for (const file of tool.required) {
      if (!found.includes(file)) throw refuse(s.subject, `has no ${file}`);
    }
    if (tool === UV_TOOL) {
      // --no-config does not disable discovery of a parent project's workspace.
      let parent = dirname(await realpath(s.path));
      for (;;) {
        for (const file of ["pyproject.toml", "uv.toml"]) {
          try {
            await lstat(join(parent, file));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw e;
          }
          throw refuse(s.subject, `has an ancestor ${file}`);
        }
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      for (const file of found.filter((file) => basename(file) === ".python-version")) {
        const lines = (await readFile(join(s.path, file), "utf8")).split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          if (!/^(cpython-|pypy-|graalpy-)?\d+(\.\d+){0,2}[a-z0-9.+-]*$/.test(line)) {
            throw refuse(s.subject, `has a non-version interpreter in ${file}`);
          }
        }
      }
      refuseUnsafeUvRegistries(await readFile(join(s.path, "uv.lock"), "utf8"), s.subject);
    }
  }
  for (const tool of picked) {
    if (tool === PNPM_TOOL) {
      await prepareCodexPnpmStore(s.path, s.name);
      await addMcTmpExclude(s.common);
    }
    await install(tool, s.path, s.name, run);
  }
}

/**
 * What every checkout starts with: the seat checkout name is valid, the clone is clean, and
 * origin's default branch tip is read and fetched. The tip is read from origin itself before the
 * fetch, so the fetch brings its objects; never from a local ref a seat could move.
 */
async function fetchBase(i: Omit<CheckoutInput, "title">) {
  const name = `${i.seatId}-${i.issue}`;
  if (!SEAT_ID.test(i.seatId) || !Number.isSafeInteger(i.issue) || i.issue < 1) {
    throw new CheckoutError("path", `${name} is not a seat checkout name`);
  }
  return fetchBaseAs(i, name);
}

/** `fetchBase` for a checkout named `name` (already checked); the root must be absolute. */
async function fetchBaseAs(
  i: {
    checkout: string;
    worktreesRoot: string;
    sessionId: string;
    peers?: readonly RepoPeer[];
  },
  name: string,
) {
  if (!isAbsolute(i.worktreesRoot)) {
    throw new CheckoutError("path", "crew.worktrees is not an absolute path");
  }
  if (!SEAT_ID.test(i.sessionId)) {
    throw new CheckoutError("path", `${i.sessionId} is not a session id`);
  }
  const path = join(i.worktreesRoot, i.sessionId, name);
  const common = await cloneGitDir(i.checkout, i.peers);
  const inClone = (args: string[], timeoutMs?: number) =>
    crewGit(i.checkout, args, common, { gitDir: common, timeoutMs });
  await checkSeatGitConfig(i.checkout);
  const baseSha = await fetchOriginBase(inClone);
  return { name, path, flat: join(i.worktreesRoot, name), common, inClone, baseSha };
}

/** Origin's default tip, read from origin and fetched (see `fetchBase`). */
async function fetchOriginBase(
  inClone: (args: string[], timeoutMs?: number) => Promise<string>,
): Promise<string> {
  let listed: string;
  try {
    listed = await inClone(["ls-remote", "origin", "HEAD"], CREW_GIT_SLOW_MS);
  } catch (e) {
    throw new CheckoutError("fetch", "could not reach origin", { cause: e });
  }
  const baseSha = SHA.exec(listed)?.[1];
  if (baseSha === undefined) throw new CheckoutError("base", "origin has no default branch");
  try {
    // --prune: an origin branch is only one origin has now, not a ref left (or planted) here
    await inClone(["fetch", "--quiet", "--prune", "origin"], CREW_GIT_SLOW_MS);
  } catch (e) {
    throw new CheckoutError("fetch", "could not reach origin", { cause: e });
  }
  if (!(await succeeds(inClone(["cat-file", "-e", `${baseSha}^{commit}`])))) {
    throw new CheckoutError("base", "origin's default branch was not fetched");
  }
  return baseSha;
}

async function ticketBranch(
  inClone: (args: string[]) => Promise<string>,
  issue: number,
): Promise<string | null> {
  let refs: string;
  try {
    refs = await inClone([
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/feature/${issue}`,
      `refs/heads/feature/${issue}-*`,
      `refs/remotes/origin/feature/${issue}`,
      `refs/remotes/origin/feature/${issue}-*`,
    ]);
  } catch (e) {
    throw new CheckoutError("worktree", `could not list the branches of #${issue}`, {
      cause: e,
      detail: gitReason(e),
    });
  }
  const pattern = new RegExp(`^feature/${issue}(?:-[^/]+)?$`);
  const branches = new Set(
    refs
      .split("\n")
      .map((ref) => ref.replace(/^refs\/(?:heads|remotes\/origin)\//, ""))
      .filter((branch) => pattern.test(branch)),
  );
  if (branches.size > 1) {
    throw new CheckoutError(
      "branch",
      `#${issue} has more than one branch (${branches.size}); delete the extra ones`,
    );
  }
  return branches.values().next().value ?? null;
}

/** A fresh detached copy of the ticket's branch, or origin's default tip when it has none. */
export async function prepareReadOnlyCheckout(
  i: Omit<CheckoutInput, "title" | "pending">,
): Promise<Checkout> {
  const { name, path: inSession, flat, common, inClone, baseSha } = await fetchBase(i);
  const path =
    (await succeeds(lstat(inSession))) || !(await succeeds(lstat(flat))) ? inSession : flat;
  const branch = await ticketBranch(inClone, i.issue);
  const refSha = (ref: string) =>
    inClone(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).then(
      (s) => s.trim(),
      () => null,
    );
  const sha =
    branch === null
      ? baseSha
      : ((await refSha(`refs/heads/${branch}`)) ??
        (await refSha(`refs/remotes/origin/${branch}`)) ??
        baseSha);
  const cannotAdd = (e: unknown) =>
    new CheckoutError("worktree", `could not create a read-only worktree for ${name}`, {
      cause: e,
      detail: gitReason(e),
    });
  if (await succeeds(lstat(path))) {
    try {
      await existingReadOnlyCheckout(i.checkout, path, branch);
    } catch {
      throw new CheckoutError(
        "path",
        `the worktree path for ${name} exists and is not this ticket's checkout`,
        { detail: path },
      );
    }
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch((e) => {
      throw cannotAdd(e);
    });
  }
  try {
    await inClone(["worktree", "prune"]);
    await inClone(["worktree", "add", "--quiet", "--detach", "--", path, sha], CREW_GIT_SLOW_MS);
  } catch (e) {
    throw cannotAdd(e);
  }
  try {
    const gitDir = await adminDirOf(common, path);
    if (gitDir === null) {
      throw new CheckoutError(
        "worktree",
        `could not create a read-only worktree for ${name}: not registered`,
      );
    }
    await checkSeatGitConfig(path);
    await installAll(
      {
        checkout: i.checkout,
        common,
        inClone,
        path,
        rev: sha,
        base: baseSha,
        compare: branch !== null,
        subject: branch ? `branch ${branch}` : "origin's default branch",
        name: branch ?? name,
      },
      execFileP,
    );
    return { branch: branch ?? "", path, created: true, baseSha, gitDir };
  } catch (e) {
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch(() => {});
    throw e;
  }
}

/** A fresh detached worktree at origin's default tip, `{root}/{seatId}-{issue}`; no branch, no install. */
export async function preparePlanCheckout(i: Omit<CheckoutInput, "title">): Promise<Checkout> {
  const name = `${i.seatId}-${i.issue}`;
  if (!SEAT_ID.test(i.seatId) || !Number.isSafeInteger(i.issue) || i.issue < 1) {
    throw new CheckoutError("path", `${name} is not a seat checkout name`);
  }
  return prepareDetachedCheckout({
    checkout: i.checkout,
    worktreesRoot: i.worktreesRoot,
    sessionId: i.sessionId,
    name,
    peers: i.peers,
  });
}

/** What a seat checkout's folder name looks like (`flight-1-watch`, `guido-1-232`). */
const CHECKOUT_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * A fresh detached worktree at origin's default tip, `{root}/{name}`; no branch, no install. A
 * leftover worktree at the path is replaced.
 */
export async function prepareDetachedCheckout(i: {
  checkout: string;
  worktreesRoot: string;
  sessionId: string;
  name: string;
  peers?: readonly RepoPeer[];
}): Promise<Checkout> {
  if (!CHECKOUT_NAME.test(i.name)) {
    throw new CheckoutError("path", `${i.name} is not a seat checkout name`);
  }
  const { name, path, common, inClone, baseSha } = await fetchBaseAs(i, i.name);
  const cannotAdd = (e: unknown) =>
    new CheckoutError("worktree", `could not create a plan worktree for ${name}`, {
      cause: e,
      detail: gitReason(e),
    });
  if (await succeeds(lstat(path))) {
    if ((await adminDirOf(common, path)) === null) {
      throw new CheckoutError(
        "path",
        `the worktree path for ${name} exists and is not this ticket's checkout`,
        { detail: path },
      );
    }
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch((e) => {
      throw cannotAdd(e);
    });
  }
  try {
    await inClone(["worktree", "prune"]);
    await inClone(
      ["worktree", "add", "--quiet", "--detach", "--", path, baseSha],
      CREW_GIT_SLOW_MS,
    );
  } catch (e) {
    throw cannotAdd(e);
  }
  const gitDir = await adminDirOf(common, path);
  if (gitDir === null) {
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch(() => {});
    throw new CheckoutError(
      "worktree",
      `could not create a plan worktree for ${name}: not registered`,
    );
  }
  return { branch: "", path, created: true, baseSha, gitDir };
}

async function syncReused(
  path: string,
  common: string,
  gitDir: string,
  branch: string,
  baseSha: string,
): Promise<ReuseSync> {
  const w = (args: string[], env?: NodeJS.ProcessEnv) =>
    crewGit(path, args, common, { gitDir, timeoutMs: CREW_GIT_SLOW_MS, env });
  try {
    const merging = await w(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      (s) => s.trim(),
      (e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === 1) return null;
        throw e;
      },
    );
    if (merging !== null) {
      const files = (await w(["diff", "--name-only", "--diff-filter=U", "-z"]))
        .split("\0")
        .filter(Boolean);
      if (
        files.length > 0 &&
        (await succeeds(w(["merge-base", "--is-ancestor", merging, baseSha])))
      ) {
        return { kind: "conflict", mainSha: merging, files };
      }
      return { kind: "skipped", why: "merging" };
    }
    const current = await w(["merge-base", "--is-ancestor", baseSha, "HEAD"]).then(
      () => true,
      (e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === 1) return false;
        throw e;
      },
    );
    if (current) return { kind: "up-to-date" };
    const status = await w([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      ...COMMIT_ADD_PATHSPEC,
    ]);
    if (status !== "") return { kind: "skipped", why: "dirty" };
    const before = (await w(["rev-parse", "--verify", "HEAD"])).trim();
    try {
      await w(mainMergeArgs(branch, baseSha), {
        GIT_AUTHOR_NAME: MC_MERGE_AUTHOR,
        GIT_COMMITTER_NAME: MC_MERGE_AUTHOR,
      });
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 1) {
        const files = (await w(["diff", "--name-only", "--diff-filter=U", "-z"]))
          .split("\0")
          .filter(Boolean);
        if (files.length > 0) return { kind: "conflict", mainSha: baseSha, files };
      }
      await w(["merge", "--abort"]).catch(() => {});
      return { kind: "skipped", why: "failed" };
    }
    return { kind: "merged", sha: (await w(["rev-parse", "--verify", "HEAD"])).trim(), before };
  } catch {
    return { kind: "skipped", why: "failed" };
  }
}

/** Sync only after the caller has stored the run, under its clone lock; record the result immediately. */
export async function syncReusedWorktree(
  checkout: string,
  worktree: Checkout,
  opts: { syncMain: boolean },
): Promise<ReuseSync | undefined> {
  if (!opts.syncMain || worktree.created) return undefined;
  const common = await realpath(join(checkout, ".git"));
  return syncReused(worktree.path, common, worktree.gitDir, worktree.branch, worktree.baseSha);
}

/** A reused uv worktree is not reinstalled after a sync. */
export const UV_REUSED_NOTE =
  "dependencies changed; uv reinstall is not supported in a reused worktree";

/**
 * After a recorded merge, install if its diff changed an install input. Retains checkout trust
 * checks; a refusal or failure is returned for the caller's answer, without hiding the merge.
 * The caller holds the clone lock.
 */
export async function installAfterSync(
  checkout: string,
  worktree: Pick<Checkout, "path" | "gitDir" | "branch" | "baseSha">,
  before: string,
): Promise<string | undefined> {
  try {
    const common = await realpath(join(checkout, ".git"));
    const w = (args: string[]) => crewGit(worktree.path, args, common, { gitDir: worktree.gitDir });
    const changed = (
      await w(["diff", "--name-only", "--no-renames", "-z", `${before}..HEAD`, "--"])
    ).split("\0");
    // only a uv repo (a lockfile at the top) gets the note; a pnpm repo still reinstalls below
    const uvNote =
      (await succeeds(lstat(join(worktree.path, "uv.lock")))) &&
      changed.some((file) => UV_TOOL.inputs.has(basename(file)))
        ? UV_REUSED_NOTE
        : undefined;
    if (!changed.some((file) => PNPM_INPUTS.has(file.split("/").pop() ?? ""))) return uvNote;
    const g = (args: string[]) => crewGit(checkout, args, common, { gitDir: common });
    const subject = `branch ${worktree.branch}`;
    await refuseUnsafeTree(w, "HEAD", subject, PNPM_TOOL.installDir);
    await refuseInstallInputs(w, worktree.baseSha, "HEAD", subject, PNPM_TOOL.inputs);
    const inputs: string[] = [];
    const unsafe = await inspectDisk(worktree.path, PNPM_TOOL, inputs);
    if (unsafe !== null) throw refuse(subject, unsafe);
    const format = (await g(["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1") throw refuse(subject, `is in a ${format} repository`);
    const read = verifiedObjects((args, maxBuffer) =>
      crewGitBytes(checkout, args, common, { gitDir: common, maxBuffer }),
    );
    await refuseChangedInputs(worktree.path, PNPM_TOOL, inputs, read, worktree.baseSha, subject);
    await prepareCodexPnpmStore(worktree.path, worktree.branch);
    await addMcTmpExclude(common);
    await install(PNPM_TOOL, worktree.path, worktree.branch);
    return uvNote;
  } catch (e) {
    return `dependencies changed; install refused: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Gives a run its branch and worktree: reuses this ticket's worktree if it exists, else adds one
 * on the existing branch (local, or origin's tracked) or on a new branch from origin's default
 * branch, then installs dependencies when the worktree has a pnpm or uv lockfile (`installAll`).
 */
export async function prepareCheckout(
  i: CheckoutInput,
  runInstall: InstallRunner = execFileP,
): Promise<Checkout> {
  const { name, path: inSession, flat, common, inClone, baseSha } = await fetchBase(i);
  const branch = (await ticketBranch(inClone, i.issue)) ?? branchFor(i.issue, i.title);
  // a worktree made before sessions had folders is reused where it is
  const path =
    (await succeeds(lstat(inSession))) || !(await succeeds(lstat(flat))) ? inSession : flat;
  const rev = `refs/heads/${branch}`;
  const subject = `branch ${branch}`;

  const cannotAdd = (e: unknown) =>
    new CheckoutError("worktree", `could not create a worktree for ${branch}`, {
      cause: e,
      detail: gitReason(e),
    });
  if (i.pending?.isPending(path)) {
    await removePending(common, path, i.worktreesRoot, inClone).catch((e) => {
      if (e instanceof CheckoutError) throw e;
      throw cannotAdd(e);
    });
  }
  if (await succeeds(lstat(path))) {
    const gitDir = await adminDirOf(common, path);
    const head = gitDir
      ? await crewGit(path, ["symbolic-ref", "--quiet", "HEAD"], common, { gitDir }).catch(() => "")
      : "";
    if (gitDir === null || head.trim() !== `refs/heads/${branch}`) {
      throw new CheckoutError(
        "path",
        `the worktree path for ${name} exists and is not this ticket's checkout`,
        { detail: path },
      );
    }
    await checkSeatGitConfig(path);
    const status = await crewGit(
      path,
      [
        "--no-optional-locks",
        "-c",
        "core.quotePath=true",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      common,
      { gitDir },
    );
    const leftoverChanges = status.split("\n").filter((line) => line !== "");
    return { branch, path, created: false, baseSha, gitDir, leftoverChanges };
  }

  // A worktree whose directory was deleted is still registered and would block the add.
  await inClone(["worktree", "prune"]).catch((e) => {
    throw cannotAdd(e);
  });
  const refSha = (ref: string) =>
    inClone(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).then(
      (s) => s.trim(),
      () => null,
    );
  const local = await refSha(`refs/heads/${branch}`);
  const remote = local === null ? await refSha(`refs/remotes/origin/${branch}`) : null;
  const add =
    local !== null
      ? ["worktree", "add", "--quiet", "--", path, branch]
      : remote !== null
        ? [
            "worktree",
            "add",
            "--quiet",
            "--track",
            "-b",
            branch,
            "--",
            path,
            `refs/remotes/origin/${branch}`,
          ]
        : ["worktree", "add", "--quiet", "--no-track", "-b", branch, "--", path, baseSha];
  try {
    i.pending?.markPending(path);
    await inClone(add, CREW_GIT_SLOW_MS);
  } catch (e) {
    throw cannotAdd(e);
  }
  // The branch this call made, and where: removed again on failure if it has not moved.
  const madeAt = local === null ? (remote ?? baseSha) : null;

  try {
    const gitDir = await adminDirOf(common, path);
    if (gitDir === null) {
      throw new CheckoutError(
        "worktree",
        `could not create a worktree for ${branch}: not registered`,
      );
    }
    await checkSeatGitConfig(path);
    await installAll(
      {
        checkout: i.checkout,
        common,
        inClone,
        path,
        rev,
        base: baseSha,
        compare: local !== null || remote !== null,
        subject,
        name: branch,
      },
      runInstall,
    );
    i.pending?.clearPending(path);
    return { branch, path, created: true, baseSha, gitDir };
  } catch (e) {
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch(() => {});
    if (madeAt !== null) {
      await inClone(["update-ref", "-d", `refs/heads/${branch}`, madeAt]).catch(() => {});
    }
    throw e;
  }
}

/**
 * A run's worktree as it stands, for resuming it: still registered in the clone (read from the
 * clone's side), its git dirs still the clone's (`crewGit` refuses a redirected `.git`), and still
 * on `branch`. Anything else is `CheckoutError("path", …)`. Writes nothing.
 */
export async function existingCheckout(
  checkout: string,
  path: string,
  branch: string,
): Promise<Pick<Checkout, "branch" | "path" | "gitDir">> {
  const notIt = (cause?: unknown) =>
    new CheckoutError("path", `${path} is not this run's checkout`, { cause });
  const common = await realpath(join(checkout, ".git")).catch(() => null);
  const gitDir = common === null ? null : await adminDirOf(common, path);
  if (common === null || gitDir === null) throw notIt();
  let head: string;
  try {
    head = await crewGit(path, ["symbolic-ref", "--quiet", "HEAD"], common, { gitDir });
  } catch (e) {
    throw notIt(e);
  }
  if (head.trim() !== `refs/heads/${branch}`) throw notIt();
  return { branch, path, gitDir };
}

/**
 * Removes a run's worktree. Refuses one with uncommitted changes unless `force` (the run is over
 * and its work is on the branch); never deletes the branch, which holds the run's commits.
 */
export async function removeCheckout(
  checkout: string,
  path: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const common = await realpath(join(checkout, ".git")).catch(() => {
    throw new CheckoutError("checkout", CHECKOUT_TEXT);
  });
  const gitDir = await adminDirOf(common, path);
  if (gitDir === null) {
    throw new CheckoutError("path", `${path} is not a worktree of the crew checkout`);
  }
  if (opts.force !== true) {
    const status = await crewGit(path, ["status", "--porcelain"], common, { gitDir });
    if (status !== "") throw new CheckoutError("dirty", `${path} has uncommitted changes`);
  }
  const force = opts.force === true ? ["--force"] : [];
  await crewGit(checkout, ["worktree", "remove", ...force, "--", path], common, {
    gitDir: common,
    timeoutMs: CREW_GIT_SLOW_MS,
  });
}

export interface ScratchInput {
  checkout: string;
  worktreesRoot: string;
  sessionId: string;
  seatId: string;
  reviewId: number;
  sha: string;
  peers?: readonly RepoPeer[];
}

export interface Scratch {
  path: string;
  gitDir: string;
  /** origin's default tip */
  baseSha: string;
  mergeBase: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * A review run's checkout: a fresh detached worktree at the PR head `sha`, `{root}/{seat}-review-{id}`.
 * Install inputs are judged against the merge base of `sha` and origin's default tip, a commit the
 * crew's own commits descend from and never changed them in. A leftover worktree of the same review
 * (a start that crashed) is replaced; a start that fails leaves nothing behind.
 */
export async function prepareScratch(
  i: ScratchInput,
  runInstall: InstallRunner = execFileP,
): Promise<Scratch> {
  const name = scratchName(i.seatId, i.reviewId);
  if (
    !SEAT_ID.test(i.seatId) ||
    !Number.isSafeInteger(i.reviewId) ||
    i.reviewId < 1 ||
    !COMMIT_SHA.test(i.sha) ||
    !SEAT_ID.test(i.sessionId) ||
    !isAbsolute(i.worktreesRoot)
  ) {
    throw new CheckoutError("path", `${name} is not a review checkout name`);
  }
  const subject = `the PR head ${i.sha.slice(0, 7)}`;
  const path = join(i.worktreesRoot, i.sessionId, name);
  const common = await cloneGitDir(i.checkout, i.peers);
  const inClone = (args: string[], timeoutMs?: number) =>
    crewGit(i.checkout, args, common, { gitDir: common, timeoutMs });
  await checkSeatGitConfig(i.checkout);
  const baseSha = await fetchOriginBase(inClone);
  if (!(await succeeds(inClone(["cat-file", "-e", `${i.sha}^{commit}`])))) {
    throw new CheckoutError("base", "the PR's head commit is not in the clone");
  }
  const cannotAdd = (e: unknown) =>
    new CheckoutError("worktree", `could not create a worktree for ${name}`, {
      cause: e,
      detail: gitReason(e),
    });
  if (await succeeds(lstat(path))) {
    if ((await adminDirOf(common, path)) === null) {
      throw new CheckoutError(
        "path",
        `the path for ${name} exists and is not a worktree of the clone`,
        { detail: path },
      );
    }
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch((e) => {
      throw cannotAdd(e);
    });
  }
  try {
    await inClone(["worktree", "prune"]);
    await inClone(["worktree", "add", "--quiet", "--detach", "--", path, i.sha], CREW_GIT_SLOW_MS);
  } catch (e) {
    throw cannotAdd(e);
  }
  try {
    const gitDir = await adminDirOf(common, path);
    if (gitDir === null) {
      throw new CheckoutError(
        "worktree",
        `could not create a worktree for ${name}: not registered`,
      );
    }
    const mergeBase = (await inClone(["merge-base", baseSha, i.sha]).catch(() => "")).trim();
    if (!COMMIT_SHA.test(mergeBase)) {
      throw new CheckoutError("base", "the PR head has no merge base with origin's default branch");
    }
    await installAll(
      {
        checkout: i.checkout,
        common,
        inClone,
        path,
        rev: i.sha,
        base: mergeBase,
        compare: true,
        subject,
        name: subject,
      },
      runInstall,
    );
    return { path, gitDir, baseSha, mergeBase };
  } catch (e) {
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch(() => {});
    throw e;
  }
}

/**
 * A run's worktree as it stands: registered in the clone, detached, and with a valid HEAD. Writes nothing.
 */
export async function existingDetached(
  checkout: string,
  path: string,
): Promise<{ path: string; gitDir: string }> {
  const notIt = () => new CheckoutError("path", `${path} is not this run's checkout`);
  const common = await realpath(join(checkout, ".git")).catch(() => null);
  const gitDir = common === null ? null : await adminDirOf(common, path);
  if (common === null || gitDir === null) throw notIt();
  // A resumed read-only run must still use a detached copy.
  if (await succeeds(crewGit(path, ["symbolic-ref", "--quiet", "HEAD"], common, { gitDir }))) {
    throw notIt();
  }
  if (!(await succeeds(crewGit(path, ["rev-parse", "--verify", "HEAD"], common, { gitDir })))) {
    throw notIt();
  }
  return { path, gitDir };
}

/**
 * Upgrade a verified legacy run without touching its files or branch ref. A retry after the
 * HEAD write but before the store write also accepts the already detached checkout.
 */
export async function existingReadOnlyCheckout(
  checkout: string,
  path: string,
  branch: string | null,
): Promise<{ path: string; gitDir: string }> {
  try {
    return await existingDetached(checkout, path);
  } catch (e) {
    if (branch === null) throw e;
  }
  const { gitDir } = await existingCheckout(checkout, path, branch);
  const common = await realpath(join(checkout, ".git"));
  const head = (await crewGit(path, ["rev-parse", "--verify", "HEAD"], common, { gitDir })).trim();
  await crewGit(path, ["update-ref", "--no-deref", "HEAD", head, head], common, { gitDir });
  return existingDetached(checkout, path);
}

/**
 * A review run's worktree as it stands, for resuming it: registered in the clone, detached, and at
 * `sha`. Anything else is `CheckoutError("path", …)`. Writes nothing.
 */
export async function existingScratch(
  checkout: string,
  path: string,
  sha: string,
): Promise<{ path: string; gitDir: string }> {
  const notIt = (cause?: unknown) =>
    new CheckoutError("path", `${path} is not this review's checkout`, { cause });
  const common = await realpath(join(checkout, ".git")).catch(() => null);
  const gitDir = common === null ? null : await adminDirOf(common, path);
  if (common === null || gitDir === null) throw notIt();
  // a branch checked out here would not be a review's detached copy
  if (await succeeds(crewGit(path, ["symbolic-ref", "--quiet", "HEAD"], common, { gitDir }))) {
    throw notIt();
  }
  let head: string;
  try {
    head = await crewGit(path, ["rev-parse", "--verify", "HEAD"], common, { gitDir });
  } catch (e) {
    throw notIt(e);
  }
  if (head.trim() !== sha) throw notIt();
  return { path, gitDir };
}

const DIFF_TOO_BIG = "(the diff is larger than 64 MiB; read the changed files)";

/** `from..sha` as text, cut at REVIEW_DIFF_MAX bytes (not mid-character). */
async function diffText(
  checkout: string,
  common: string,
  from: string,
  sha: string,
): Promise<{ text: string; cut: boolean }> {
  let out: string;
  try {
    out = await crewGit(
      checkout,
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        from,
        sha,
        "--",
      ],
      common,
      { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS, maxBuffer: REVIEW_DIFF_MAX_BUFFER },
    );
  } catch (e) {
    if ((e as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { text: DIFF_TOO_BIG, cut: true };
    }
    throw e;
  }
  const bytes = Buffer.from(out, "utf8");
  if (bytes.length <= REVIEW_DIFF_MAX) return { text: out, cut: false };
  let end = REVIEW_DIFF_MAX;
  // a continuation byte at the cut means the character began before it: drop it whole
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + DIFF_CUT_LINE, cut: true };
}

/**
 * Writes the review's input files into the scratch worktree's `.mc-review/`: the PR's diff from
 * the merge base, and, when the previous reviewed sha is still in the clone, the diff since it.
 */
export async function writeReviewInputs(
  checkout: string,
  s: Scratch,
  sha: string,
  prevSha: string | null,
): Promise<{ diffCut: boolean; since: boolean }> {
  const common = await realpath(join(checkout, ".git")).catch((e) => {
    throw new CheckoutError("checkout", CHECKOUT_TEXT, { cause: e });
  });
  const pr = await diffText(checkout, common, s.mergeBase, sha);
  let since: { text: string; cut: boolean } | null = null;
  if (
    prevSha !== null &&
    (await succeeds(
      crewGit(checkout, ["cat-file", "-e", `${prevSha}^{commit}`], common, { gitDir: common }),
    ))
  ) {
    since = await diffText(checkout, common, prevSha, sha);
  }
  await mkdir(join(s.path, REVIEW_INPUT_DIR));
  await writeFile(join(s.path, REVIEW_DIFF_FILE), pr.text, { flag: "wx" });
  if (since !== null) await writeFile(join(s.path, REVIEW_SINCE_FILE), since.text, { flag: "wx" });
  return { diffCut: pr.cut, since: since !== null };
}

const SESSION_OWNER_FILE = "mission-control-session.json";
/** Read-only validation: sessions require a standalone clone and an existing local branch. */
export async function validateSessionCheckout(
  checkout: string,
  branch: string,
  github: string,
  shared: boolean,
  peers: readonly RepoPeer[],
): Promise<string> {
  if (!(await lstat(join(checkout, ".git"))).isDirectory()) {
    throw new CheckoutError("checkout", "sessions require a standalone clone");
  }
  const common = await cloneGitDir(checkout, peers);
  const git = (args: string[]) => crewGit(checkout, args, common, { gitDir: common });
  await git(["check-ref-format", `refs/heads/${branch}`]);
  await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (shared && (await git(["symbolic-ref", "--short", "HEAD"])).trim() !== branch) {
    throw new CheckoutError("checkout", "the checkout is on a different branch");
  }
  const origin = (await git(["remote", "get-url", "origin"])).trim();
  const githubOrigin = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;
  const repo = origin.replace(githubOrigin, "").replace(/\.git$/, "");
  if (repo.toLowerCase() !== github.toLowerCase() || !githubOrigin.test(origin)) {
    throw new CheckoutError("checkout", "the checkout origin does not match the repo profile");
  }
  return origin;
}

/** The destination was confined by config validation before this call. Never reuse a directory. */
export async function createSessionCheckout(
  source: string,
  path: string,
  branch: string,
  origin: string,
  sessionId: string,
): Promise<NonNullable<CrewSessionConfig["managedCheckout"]>> {
  const sourceGit = await realpath(join(source, ".git"));
  const upstream = await crewGit(
    source,
    ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin"],
    sourceGit,
    { gitDir: sourceGit },
  );
  const upstreamHead = await crewGit(
    source,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    sourceGit,
    { gitDir: sourceGit },
  ).then(
    (ref) => ref.trim(),
    () => "",
  );
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CheckoutError(
        "path",
        `the separate checkout destination already exists: ${path}; move or recover it before re-creating the session`,
      );
    }
    throw e;
  });
  const stat = await lstat(path);
  const proof = { token: randomUUID(), device: stat.dev, inode: stat.ino };
  try {
    await execFileP(
      "git",
      [
        ...SAFE_CONFIG,
        "clone",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        "--single-branch",
        "--branch",
        branch,
        "--no-tags",
        "--",
        source,
        path,
      ],
      {
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
        timeout: CREW_GIT_SLOW_MS,
      },
    );
    const common = await realpath(join(path, ".git"));
    const git = (args: string[]) => crewGit(path, args, common, { gitDir: common });
    await git(["checkout", "--no-track", "-B", branch, `refs/remotes/origin/${branch}`, "--"]);
    await git(["remote", "set-url", "origin", origin]);
    // --single-branch saved a one-branch refspec; widen it so fetches bring origin's default branch
    await git(["remote", "set-branches", "origin", "*"]);
    // Clone's tracking refs described the source's local branches, not what was pushed upstream.
    const refs = await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
    for (const ref of refs.trim().split("\n").filter(Boolean))
      await git(["update-ref", "-d", "--no-deref", ref]);
    const copied = new Set<string>();
    for (const line of upstream.trim().split("\n").filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      if (!ref || !sha || ref === "refs/remotes/origin/HEAD") continue;
      if (await succeeds(git(["cat-file", "-e", `${sha}^{commit}`]))) {
        await git(["update-ref", ref, sha]);
        copied.add(ref);
      }
    }
    if (upstreamHead.startsWith("refs/remotes/origin/") && copied.has(upstreamHead)) {
      await git(["symbolic-ref", "refs/remotes/origin/HEAD", upstreamHead]);
    }
    await writeFile(join(common, SESSION_OWNER_FILE), JSON.stringify({ sessionId, ...proof }), {
      flag: "wx",
      mode: 0o600,
    });
    return proof;
  } catch (e) {
    const current = await lstat(path).catch(() => null);
    if (current?.dev === proof.device && current.ino === proof.inode && !current.isSymbolicLink()) {
      await rm(path, { recursive: true });
    }
    throw e;
  }
}

/** Fail closed: only this exact owned clone, with no data Git would lose, may be removed. */
export async function removeSessionCheckout(
  session: CrewSessionConfig,
  worktrees: string,
  rollback = false,
): Promise<SessionCheckoutOutcome> {
  const proof = session.managedCheckout;
  if (!proof) return "unmanaged";
  try {
    const path = session.checkout;
    if (path !== managedSessionPath(worktrees, session.id) || (await realpath(path)) !== path) {
      return "retained-unproven";
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.dev !== proof.device || stat.ino !== proof.inode) {
      return "retained-unproven";
    }
    const common = join(path, ".git");
    if (!(await lstat(common)).isDirectory() || (await realpath(common)) !== common) {
      return "retained-unproven";
    }
    const owner = JSON.parse(await readFile(join(common, SESSION_OWNER_FILE), "utf8"));
    if (
      owner.sessionId !== session.id ||
      owner.token !== proof.token ||
      owner.device !== proof.device ||
      owner.inode !== proof.inode
    )
      return "retained-unproven";
    const git = (args: string[]) => crewGit(path, args, common, { gitDir: common });
    if ((await git(["worktree", "list", "--porcelain"])).split("worktree ").length !== 2) {
      return "retained-unproven";
    }
    if (
      await git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
        "--",
        ".",
        ":(exclude,glob)**/.DS_Store",
      ])
    ) {
      return "retained-dirty";
    }
    if (!rollback) {
      const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (
        refs.length === 0 ||
        (await git(["rev-list", "--max-count=1", "--all", "--reflog", "--not", ...refs])).trim()
      ) {
        return "retained-unpushed";
      }
    }
    try {
      await rm(path, { recursive: true });
    } catch {
      return existsSync(path) ? "removal-failed-partway" : "removed";
    }
    return existsSync(path) ? "removal-failed-partway" : "removed";
  } catch {
    return "retained-unproven";
  }
}
