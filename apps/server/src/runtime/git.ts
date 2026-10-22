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
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";

const execFileP = promisify(execFile);

export class CrewGitError extends Error {
  readonly code: "redirected";
  constructor(code: "redirected", message: string) {
    super(message);
    this.name = "CrewGitError";
    this.code = code;
  }
}

/** Applied before every subcommand: no hooks, no fsmonitor daemon. */
export const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

export interface CrewGitOptions {
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

function run(cwd: string, args: string[], o: CrewGitOptions = {}): Promise<string> {
  return execFileP("git", [...SAFE_CONFIG, ...args], {
    ...execOptions(cwd, o),
    encoding: "utf8",
  }).then((r) => r.stdout);
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
  const r = await execFileP("git", [...SAFE_CONFIG, ...args], {
    ...execOptions(cwd, o),
    encoding: "buffer",
  });
  return r.stdout;
}
