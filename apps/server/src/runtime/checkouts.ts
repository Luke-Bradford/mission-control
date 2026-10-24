/**
 * A crew run's checkout: a branch and a git worktree in Mission Control's own clone of the repo
 * (spec §5). The clone is Mission Control's, so git here writes (fetch, worktree add/remove), but
 * every call goes through `crewGit`: a seat writes inside its worktree and its branch, so nothing
 * it could have changed is trusted. The base of a new branch is read from origin itself, and a
 * reused branch is never reset. A start that fails leaves nothing it created behind.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  branchFor,
  DIFF_CUT_LINE,
  PNPM_STORE_DIR_NAME,
  REVIEW_DIFF_FILE,
  REVIEW_DIFF_MAX,
  REVIEW_DIFF_MAX_BUFFER,
  REVIEW_INPUT_DIR,
  REVIEW_SINCE_FILE,
  scratchName,
} from "@mc/core";
import { SEAT_ID } from "../config.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "../files.ts";
import { crewGit, crewGitBytes, overflowed, SAFE_CONFIG, timedOut } from "./git.ts";

const execFileP = promisify(execFile);

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
const INSTALL_INPUTS = new Set([
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
 * What the commit tool's `add -A` stages: the whole worktree but any `.pnpm-store/`, at the top or
 * nested. A sandboxed pnpm that cannot write its global store makes one inside the worktree; the
 * seat's env points the store elsewhere (`crewPnpmStoreDir`), and this is the backstop.
 */
export const COMMIT_ADD_PATHSPEC = [
  "--",
  ":(top)",
  `:(top,exclude,glob)**/${PNPM_STORE_DIR_NAME}/**`,
] as const;

export type ReuseSync =
  | { kind: "up-to-date" }
  | { kind: "merged"; sha: string; before: string }
  | { kind: "conflict"; mainSha: string; files: string[] }
  | { kind: "skipped"; why: "dirty" | "merging" | "failed" };

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
  /** Checked at this start against the clone's git repository; none given, none checked. */
  peers?: readonly RepoPeer[];
}

export interface Checkout {
  branch: string;
  /** `{worktreesRoot}/{sessionId}/{seatId}-{issue}`; an older run's is the flat `{worktreesRoot}/{seatId}-{issue}`. */
  path: string;
  /** false: this ticket's worktree already existed and is reused. */
  created: boolean;
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
    const status = await crewGit(checkout, ["status", "--porcelain"], common, o);
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
 * Refuses a reused branch whose ref changes an install input, compared with origin's default
 * branch. The early message only: the ref can move, so `refuseChangedInputs` decides.
 */
async function refuseInstallInputs(
  inClone: (args: string[]) => Promise<string>,
  baseSha: string,
  rev: string,
  subject: string,
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
  const hit = changed.find((f) => INSTALL_INPUTS.has(f.split("/").pop() ?? ""));
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
 * Refuses a branch whose tree has a symlink or anything under a `node_modules` directory: the host
 * install follows a committed `node_modules -> <anywhere>` link and writes (or deletes) there. The
 * early, clearer refusal; `inspectDisk` is the check that counts.
 */
async function refuseUnsafeTree(
  inClone: (args: string[]) => Promise<string>,
  rev: string,
  subject: string,
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
    if (file.split("/").includes("node_modules")) throw refuse(subject, `has ${file}`);
  }
}

/**
 * What makes the worktree on disk unsafe to install in, or null: any symlink (the top-level `.git`
 * pointer file aside; symlinked dirs are never followed), or any directory where `node_modules`
 * resolves. Every install input found on the way is added to `inputs`. Lookups go through the
 * filesystem (`lstat(join(dir, name))`), so its case and Unicode folding apply (a tracked
 * `NODE_MODULES` is `node_modules` on APFS). This, not the tree listing, is authoritative: the
 * ref another seat can move is not necessarily what was checked out.
 */
async function inspectDisk(root: string, inputs: string[], rel = ""): Promise<string | null> {
  const dir = join(root, rel);
  const prefix = rel ? `${rel}/` : "";
  if (await succeeds(lstat(join(dir, "node_modules")))) return `has ${prefix}node_modules`;
  for (const name of INSTALL_INPUTS) {
    if (await succeeds(lstat(join(dir, name)))) inputs.push(`${prefix}${name}`);
  }
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (rel === "" && d.name === ".git" && d.isFile()) continue;
    if (d.isSymbolicLink()) return `has a symlink at ${prefix}${d.name}`;
    if (d.isDirectory()) {
      const found = await inspectDisk(root, inputs, `${prefix}${d.name}`);
      if (found !== null) return found;
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

/** The verified blob id of `file` in commit `baseSha`, or null when it is not a file there. */
async function baseBlob(read: ReadObject, baseSha: string, file: string): Promise<string | null> {
  const head = (await read("commit", baseSha, file)).toString("latin1").split("\n", 1)[0] ?? "";
  const tree = /^tree ([0-9a-f]{40})$/.exec(head)?.[1];
  if (tree === undefined) throw new CheckoutError("protected", NOT_ORIGIN);
  let id = tree;
  const parts = file.split("/");
  for (const [k, part] of parts.entries()) {
    const e = treeEntry(await read("tree", id, file), part);
    const last = k === parts.length - 1;
    if (e === null || (last ? e.mode !== "100644" && e.mode !== "100755" : e.mode !== "40000")) {
      return null;
    }
    id = e.id;
  }
  await read("blob", id, file);
  return id;
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
  const id = await baseBlob(read, baseSha, file);
  return id === null ? null : read("blob", id, file);
}

/**
 * Install trust comes from content: every install input on disk must be, byte for byte, the file
 * at that path in origin's default branch, read from hash-verified objects.
 */
async function refuseChangedInputs(
  path: string,
  inputs: string[],
  read: ReadObject,
  baseSha: string,
  subject: string,
): Promise<void> {
  // Without its root workspace file, pnpm walks up and installs an ancestor's workspace.
  if (
    !inputs.includes(WORKSPACE_FILE) &&
    (await baseBlob(read, baseSha, WORKSPACE_FILE)) !== null
  ) {
    throw refuse(subject, `changes ${WORKSPACE_FILE}`);
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
  return env;
}

/**
 * The sandbox has no network, so dependencies are installed here (`INSTALL_ARGS`): scripts and a
 * `.pnpmfile.cjs` would run the branch's code outside the sandbox.
 */
async function install(path: string, name: string): Promise<void> {
  try {
    await execFileP("pnpm", [...INSTALL_ARGS], {
      cwd: path,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
      encoding: "utf8",
      env: installEnv(path),
    });
  } catch (e) {
    const x = e as { killed?: boolean; code?: unknown; stdout?: unknown; stderr?: unknown };
    const out = `${String(x.stdout ?? "")}\n${String(x.stderr ?? "")}`;
    const why = x.killed
      ? "timed out"
      : (/ERR_PNPM_[A-Z_]+/.exec(out)?.[0] ?? `exit ${String(x.code)}`);
    throw new CheckoutError("install", `pnpm install failed for ${name} (${why})`, { cause: e });
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
    if (!changed.some((file) => INSTALL_INPUTS.has(file.split("/").pop() ?? ""))) return;
    const g = (args: string[]) => crewGit(checkout, args, common, { gitDir: common });
    const subject = `branch ${worktree.branch}`;
    await refuseUnsafeTree(w, "HEAD", subject);
    await refuseInstallInputs(w, worktree.baseSha, "HEAD", subject);
    const inputs: string[] = [];
    const unsafe = await inspectDisk(worktree.path, inputs);
    if (unsafe !== null) throw refuse(subject, unsafe);
    const format = (await g(["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1") throw refuse(subject, `is in a ${format} repository`);
    const read = verifiedObjects((args, maxBuffer) =>
      crewGitBytes(checkout, args, common, { gitDir: common, maxBuffer }),
    );
    await refuseChangedInputs(worktree.path, inputs, read, worktree.baseSha, subject);
    await install(worktree.path, worktree.branch);
  } catch (e) {
    return `dependencies changed; install refused: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Gives a run its branch and worktree: reuses this ticket's worktree if it exists, else adds one
 * on the existing branch (local, or origin's tracked) or on a new branch from origin's default
 * branch, then installs dependencies when the worktree has a pnpm lockfile.
 */
export async function prepareCheckout(i: CheckoutInput): Promise<Checkout> {
  const branch = branchFor(i.issue, i.title);
  const { name, path: inSession, flat, common, inClone, baseSha } = await fetchBase(i);
  // a worktree made before sessions had folders is reused where it is
  const path =
    (await succeeds(lstat(inSession))) || !(await succeeds(lstat(flat))) ? inSession : flat;
  const rev = `refs/heads/${branch}`;
  const subject = `branch ${branch}`;

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
    return { branch, path, created: false, baseSha, gitDir };
  }

  const cannotAdd = (e: unknown) =>
    new CheckoutError("worktree", `could not create a worktree for ${branch}`, {
      cause: e,
      detail: gitReason(e),
    });
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
    if (await succeeds(lstat(join(path, "pnpm-lock.yaml")))) {
      await refuseUnsafeTree(inClone, rev, subject);
      if (local !== null || remote !== null) {
        await refuseInstallInputs(inClone, baseSha, rev, subject);
      }
      const inputs: string[] = [];
      const unsafe = await inspectDisk(path, inputs);
      if (unsafe !== null) throw refuse(subject, unsafe);
      const format = (await inClone(["rev-parse", "--show-object-format"])).trim();
      if (format !== "sha1") {
        throw refuse(subject, `is in a ${format} repository`);
      }
      const read = verifiedObjects((args, maxBuffer) =>
        crewGitBytes(i.checkout, args, common, { gitDir: common, maxBuffer }),
      );
      await refuseChangedInputs(path, inputs, read, baseSha, subject);
      await install(path, branch);
    }
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
export async function prepareScratch(i: ScratchInput): Promise<Scratch> {
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
    if (await succeeds(lstat(join(path, "pnpm-lock.yaml")))) {
      await refuseUnsafeTree(inClone, i.sha, subject);
      await refuseInstallInputs(inClone, mergeBase, i.sha, subject);
      const inputs: string[] = [];
      const unsafe = await inspectDisk(path, inputs);
      if (unsafe !== null) throw refuse(subject, unsafe);
      const format = (await inClone(["rev-parse", "--show-object-format"])).trim();
      if (format !== "sha1") throw refuse(subject, `is in a ${format} repository`);
      const read = verifiedObjects((args, maxBuffer) =>
        crewGitBytes(i.checkout, args, common, { gitDir: common, maxBuffer }),
      );
      await refuseChangedInputs(path, inputs, read, mergeBase, subject);
      await install(path, subject);
    }
    return { path, gitDir, baseSha, mergeBase };
  } catch (e) {
    await inClone(["worktree", "remove", "--force", "--", path], CREW_GIT_SLOW_MS).catch(() => {});
    throw e;
  }
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
