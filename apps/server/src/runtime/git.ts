/**
 * The one way Mission Control runs git in a crew checkout. A seat can write inside its worktree, so
 * what it leaves there is untrusted: this runs git with hooks and fsmonitor off, replace refs
 * ignored, no `GIT_*` from the server's environment, a timeout, and only after confirming the
 * checkout's git directory is still the clone's own (a rewritten `.git` pointer or `commondir`
 * would otherwise send git, and its hooks, to a directory the seat made).
 *
 * Callers pass fixed subcommands only, and put `--end-of-options` or `--` before any value derived
 * from a ticket or a seat (a branch, a path, a ref) wherever git accepts one, so no such value is
 * ever read as an option.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";
import { realPathOrParent } from "./codex-floor.ts";

const execFileP = promisify(execFile);

export class CrewGitError extends Error {
  readonly code: "redirected";
  constructor(code: "redirected", message: string) {
    super(message);
    this.name = "CrewGitError";
    this.code = code;
  }
}

/** Node's error for a child whose output passed maxBuffer (it is `killed` too: check this first). */
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
export const overflowed = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === MAX_BUFFER_CODE;
/** The error execFile gives a child it killed at its timeout. */
export const timedOut = (e: unknown): boolean =>
  (e as { killed?: unknown } | null)?.killed === true;

/** Applied before every subcommand: no hooks, no fsmonitor daemon. */
export const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

export interface CrewGitOptions {
  /** Input for fixed batch commands such as cat-file. */
  input?: string;
  /** Default `GIT_TIMEOUT_MS`; fetch, ls-remote and worktree add and remove need longer. */
  timeoutMs?: number;
  /** Default `GIT_MAX_BUFFER`. */
  maxBuffer?: number;
  /**
   * The git dir `cwd` must have: a worktree's `<common>/worktrees/<name>`, or the clone's `.git`
   * for the clone itself. Catches a `.git` pointer moved to another worktree of the same clone.
   */
  gitDir?: string;
  /**
   * Added to the child's environment after the server's `GIT_*`-free one (the commit tool's author
   * names); never over the two variables that keep a call safe, which are set last.
   */
  env?: NodeJS.ProcessEnv;
}

function execOptions(cwd: string, o: CrewGitOptions) {
  return {
    cwd,
    timeout: o.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: o.maxBuffer ?? GIT_MAX_BUFFER,
    // No credential prompt: a remote that wants one fails instead of hanging until the timeout.
    // No replace refs: a seat can write `refs/replace/*` and swap any object git reads.
    env: {
      ...gitEnv(process.env),
      ...o.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  };
}

/** A batch command can exit before consuming stdin; handle that pipe error with its result. */
async function withInput<T>(
  result: Promise<T> & { child: ChildProcess },
  input?: string,
): Promise<T> {
  const written = new Promise<void>((resolve, reject) => {
    const stdin = result.child.stdin;
    if (!stdin) return resolve();
    stdin.once("error", reject);
    stdin.end(input, resolve);
  });
  const [output] = await Promise.all([result, written]);
  return output;
}

function run(cwd: string, args: string[], o: CrewGitOptions = {}): Promise<string> {
  const result = execFileP("git", [...SAFE_CONFIG, ...args], {
    ...execOptions(cwd, o),
    encoding: "utf8",
  });
  return withInput(result, o.input).then((r) => r.stdout);
}

const abs = (cwd: string, p: string) => realpath(isAbsolute(p) ? p : resolve(cwd, p));

/** Throws `CrewGitError("redirected", …)` unless `cwd`'s git dirs are the expected ones. */
async function assertOwnGitDirs(
  cwd: string,
  expectedCommonDir: string,
  o: CrewGitOptions,
): Promise<void> {
  const [common = "", own = ""] = (
    await run(cwd, ["rev-parse", "--git-common-dir", "--absolute-git-dir"])
  ).split("\n");
  const redirected =
    (await abs(cwd, common)) !== (await realpath(expectedCommonDir)) ||
    (o.gitDir !== undefined && (await abs(cwd, own)) !== (await realpath(o.gitDir)));
  if (redirected) {
    throw new CrewGitError("redirected", "the checkout's git directory is not the clone's");
  }
}

/**
 * Runs `git <args>` in `cwd` and returns stdout (rejects on failure). `expectedCommonDir` is the
 * clone's `.git`; if `cwd`'s git common directory (or, given `o.gitDir`, its own git directory)
 * resolves anywhere else, nothing runs and this throws `CrewGitError("redirected", …)`.
 */
export async function crewGit(
  cwd: string,
  args: string[],
  expectedCommonDir: string,
  o: CrewGitOptions = {},
): Promise<string> {
  await assertOwnGitDirs(cwd, expectedCommonDir, o);
  return run(cwd, args, o);
}

/** `crewGit` returning stdout's raw bytes (for binary objects such as trees). */
export async function crewGitBytes(
  cwd: string,
  args: string[],
  expectedCommonDir: string,
  o: CrewGitOptions = {},
): Promise<Buffer> {
  await assertOwnGitDirs(cwd, expectedCommonDir, o);
  const result = execFileP("git", [...SAFE_CONFIG, ...args], {
    ...execOptions(cwd, o),
    encoding: "buffer",
  });
  return (await withInput(result, o.input)).stdout;
}

export class SeatGitError extends Error {}

/** Only modern git honours the config isolation variables used by seats. */
export async function assertSeatGitVersion(command = "git"): Promise<void> {
  const { stdout } = await execFileP(command, ["--version"], {
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(process.env),
  });
  const match = /^git version (\d+)\.(\d+)(?:\.|$)/.exec(stdout.trim());
  if (match === null || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 32)) {
    throw new SeatGitError("git ≥ 2.32 required for seat isolation");
  }
}

/** Read common and worktree config, including includes; never echo helper values. */
export async function assertSeatGitConfig(
  cwd: string,
  writeRoots: readonly string[] = [cwd],
  denyWrite: readonly string[] = [],
): Promise<void> {
  let output: string;
  try {
    ({ stdout: output } = await execFileP(
      "git",
      [
        "config",
        "--includes",
        "--path",
        "--show-origin",
        "--null",
        "--get-regexp",
        "^(diff\\.external|core\\.fsmonitor|(diff|filter|merge)\\..+\\.(textconv|command|clean|smudge|process|driver)|include\\.path|includeif\\..*\\.path)$",
      ],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...gitEnv(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ));
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return;
    throw e;
  }
  const { stdout: directories } = await execFileP(
    "git",
    ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...gitEnv(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
  const physical = (path: string) => realPathOrParent(isAbsolute(path) ? path : `${cwd}/${path}`);
  const grants = writeRoots.map(physical).filter((path) => path !== null);
  const exclusions = [".git", ...directories.trim().split("\n"), ...denyWrite]
    .map(physical)
    .filter((path) => path !== null);
  const inside = (path: string, root: string) => {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
  };
  const writable = (path: string): boolean => {
    for (;;) {
      if (exclusions.some((root) => inside(path, root))) return false;
      if (grants.some((root) => inside(path, root))) return true;
      const parent = dirname(path);
      if (parent === path) return false;
      path = parent;
    }
  };
  const replaceableSymlink = async (path: string): Promise<boolean> => {
    const pending = path.split("/");
    let current = "/";
    let links = 0;
    while (pending.length > 0) {
      const part = pending.shift();
      if (!part || part === ".") continue;
      if (part === "..") {
        current = dirname(current);
        continue;
      }
      const next = resolve(current, part);
      try {
        if ((await lstat(next)).isSymbolicLink()) {
          // The link can be replaced independently of its protected destination.
          if (writable(next) || writable(current) || ++links > 40) return true;
          const target = await readlink(next);
          if (isAbsolute(target)) current = "/";
          pending.unshift(...target.split("/"));
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
      current = next;
    }
    return false;
  };
  const fields = output.split("\0");
  const keys: string[] = [];
  let writableInclude = false;
  for (let i = 1; i < fields.length; i += 2) {
    const entry = fields[i];
    const split = entry.indexOf("\n");
    const key = split === -1 ? entry : entry.slice(0, split);
    const value = split === -1 ? "" : entry.slice(split + 1);
    if (key === "include.path" || /^includeif\..*\.path$/.test(key)) {
      const origin = fields[i - 1].replace(/^file:/, "");
      const included = isAbsolute(value)
        ? value
        : `${dirname(isAbsolute(origin) ? origin : resolve(cwd, origin))}/${value}`;
      const target = physical(included);
      if (target === null || writable(target) || (await replaceableSymlink(included)))
        writableInclude = true;
      continue;
    }
    if (key !== "core.fsmonitor" || (value !== "" && value.toLowerCase() !== "false"))
      keys.push(key);
  }
  if (keys.length > 0)
    throw new SeatGitError(
      `the clone's git config defines helpers: ${[...new Set(keys)].join(", ")}`,
    );
  if (writableInclude) throw new SeatGitError("the clone's git config has a writable include");
}
