/**
 * Keeps the `claude` CLI current when `updates.cli` is `between_runs`. The hub (never a seat) asks
 * Homebrew whether the `claude-code` cask is outdated, upgrades it, then smoke-tests the CLI a seat
 * would start. A seat starts `claude` through PATH for every run and resume, so once the cask's
 * symlink points at the new version the next spawn uses it, and a running process keeps the binary
 * it loaded. A CLI that fails its smoke test holds new starts (`CliHold`) until a later check passes.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { CLAUDE_COMMAND, parseCliVersion, resolveOnPath } from "./cli-version.ts";

export const CLI_UPDATES = ["off", "between_runs"] as const;
export type CliUpdates = (typeof CLI_UPDATES)[number];

/** The health row of the CLI's update check. */
export const CLI_COLLECTOR = "cli:claude";
/** Needs-you note key while the CLI fails its smoke test. */
export const CLI_NOTE_KEY = "cli:claude";
/** Needs-you note key while the upgrade fails but the installed CLI still passes. */
/** The start of `CliCheck.brewProblem` when `brew upgrade` failed. */
export const CLI_UPGRADE_FAILED = "brew upgrade failed";
export const CLI_UPGRADE_NOTE_KEY = "cli:claude:upgrade";
/** While new runs are held, the check is repeated this often (a limit or a network blip passes). */
export const CLI_RETRY_MS = 15 * 60_000;
export const CLI_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
export const BREW_COMMAND = "brew";
export const BREW_CASK = "claude-code";
export const NOT_A_CASK = "not a Homebrew cask; update the CLI by hand";
const OUTDATED_TIMEOUT_MS = 2 * 60_000;
const UPGRADE_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const SMOKE_TIMEOUT_MS = 2 * 60_000;
const SMOKE_PROMPT = "Reply with OK";
const SMOKE_ANSWER = "OK";
const SMOKE_PASS = /^\W*ok\W*$/i;
const MAX_LINE = 200;
/** `.../Caskroom/claude-code/<version>/claude`: where Homebrew keeps the cask's files. */
const CASK_PATH = /[\\/]Caskroom[\\/]claude-code[\\/]/;

export interface ExecResult {
  /** Null when the command could not start or was killed (its timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `file` with `args` (no shell); never rejects. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export const realExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: stdout ?? "",
          stderr: stderr || err.message,
        });
      },
    );
    child.stdin?.end();
  });

/** What one check found. */
export type CliCheck =
  /** `claude` is not on PATH, or not the Homebrew cask: nothing was changed. */
  | { cask: false; found: boolean }
  | {
      cask: true;
      /** What `claude --version` says now; null when it did not answer. */
      version: string | null;
      upgraded: boolean;
      /** Why Homebrew could not tell or upgrade (first line), else null. */
      brewProblem: string | null;
      /** First line of what the smoke test said when it failed, else null: the CLI is fit to start runs. */
      smokeFailure: string | null;
    };

const firstLine = (text: string): string => {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, MAX_LINE);
};

/** Whether the JSON of `brew outdated --cask --greedy --json=v2 claude-code` lists the cask. */
function listsCask(json: string): boolean {
  const parsed = JSON.parse(json) as { casks?: { name?: unknown }[] };
  return (parsed.casks ?? []).some((c) => c.name === BREW_CASK);
}

/** The smoke test: `claude --version` answers, and `claude -p` prints OK. */
async function smoke(
  exec: ExecFn,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ version: string | null; failure: string | null }> {
  const v = await exec(CLAUDE_COMMAND, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
  const version = v.code === 0 ? parseCliVersion(v.stdout) : null;
  if (version === null) {
    return { version, failure: firstLine(v.stderr) || firstLine(v.stdout) || "no version" };
  }
  const ask = await exec(CLAUDE_COMMAND, ["-p", "--model", "haiku", SMOKE_PROMPT], {
    timeoutMs: SMOKE_TIMEOUT_MS,
    env,
  });
  // "OK", "ok." and "OK!" all pass: the model's punctuation is not the CLI's fault
  if (ask.code === 0 && SMOKE_PASS.test(ask.stdout.trim())) return { version, failure: null };
  const said = ask.code === 0 ? ask.stdout : ask.stderr || ask.stdout;
  return { version, failure: firstLine(said) || `no ${SMOKE_ANSWER} in its answer` };
}

/**
 * One check: outdated → upgrade → smoke test. Changes nothing when `claude` is not the Homebrew
 * cask. Never throws. `env` is the one `brew` and `claude` run with (default: the hub's).
 */
export async function checkCli(deps: {
  exec: ExecFn;
  env?: NodeJS.ProcessEnv;
  /** Called just before `brew upgrade`: the symlink may move to the new version from then on. */
  beforeUpgrade?: () => void;
}): Promise<CliCheck> {
  const { exec, env } = deps;
  let target: string | null = null;
  try {
    const path = resolveOnPath(CLAUDE_COMMAND, (env ?? process.env).PATH ?? "");
    target = path === null ? null : realpathSync(path);
  } catch {
    // dangling link: not found
  }
  if (target === null) return { cask: false, found: false };
  if (!CASK_PATH.test(target)) return { cask: false, found: true };

  let brewProblem: string | null = null;
  let upgraded = false;
  const outdated = await exec(
    BREW_COMMAND,
    ["outdated", "--cask", "--greedy", "--json=v2", BREW_CASK],
    { timeoutMs: OUTDATED_TIMEOUT_MS, env },
  );
  let isOutdated = false;
  if (outdated.code !== 0) {
    brewProblem = `brew outdated failed: ${firstLine(outdated.stderr) || `exit ${outdated.code}`}`;
  } else {
    try {
      isOutdated = listsCask(outdated.stdout);
    } catch {
      brewProblem = "brew outdated answered something other than JSON";
    }
  }
  if (isOutdated) {
    deps.beforeUpgrade?.();
    const up = await exec(BREW_COMMAND, ["upgrade", "--cask", BREW_CASK], {
      timeoutMs: UPGRADE_TIMEOUT_MS,
      env,
    });
    if (up.code === 0) upgraded = true;
    else brewProblem = `${CLI_UPGRADE_FAILED}: ${firstLine(up.stderr) || `exit ${up.code}`}`;
  }
  const s = await smoke(exec, env);
  return { cask: true, version: s.version, upgraded, brewProblem, smokeFailure: s.failure };
}

/**
 * Whether new runs may start. The update check holds them while the CLI fails its smoke test and
 * lets them go when a later check passes; a run already going is never touched.
 */
export class CliHold {
  private why: string | null = null;
  private readonly released = new Set<() => void>();

  /** Why starts are held, else null. */
  get reason(): string | null {
    return this.why;
  }

  hold(reason: string): void {
    this.why = reason;
  }

  release(): void {
    if (this.why === null) return;
    this.why = null;
    for (const fn of [...this.released]) fn();
  }

  /** Calls `fn` each time a hold is released; returns the unsubscribe. */
  onRelease(fn: () => void): () => void {
    this.released.add(fn);
    return () => this.released.delete(fn);
  }
}

/** The note's text while the CLI fails its smoke test. */
export const cliFailedText = (version: string | null, line: string): string =>
  `claude CLI ${version ?? "(version unknown)"} failed its smoke test: ${line}; no new runs start until it passes`;
