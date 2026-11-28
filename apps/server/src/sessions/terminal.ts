/**
 * A crew seat's terminal pane: one pane in the seat's own cmux workspace, opened in its worktree,
 * where the hub types the commands the seat's sandbox cannot run (the stack, migrations, database
 * tests). It runs as the operator, outside the seat sandbox. Each command's output and exit code
 * go to files the hub reads; the pane stays open for the operator to watch.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CHECK_BASH_TIMEOUT_MS,
  guardDecision,
  LOCK_WAIT_MS,
  lockBusyText,
  seatCallSign,
  splitCommands,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { CallKey, CheckRecorder } from "../guard/check-runs.ts";
import { crewGuardDecision } from "../guard/decision.ts";
import type { TestLock } from "../guard/lock.ts";
import { type Cmux, shellQuote } from "../runtime/cmux.ts";
import { seatWorkspace } from "./apps.ts";

/** How long `terminal_run` waits by default before it answers with the output so far. */
export const TERMINAL_TIMEOUT_DEFAULT_MS = 10 * 60_000;
/** The most of a command's output one answer carries: its end. */
export const TERMINAL_OUTPUT_MAX = 64 * 1024;

export interface TerminalResult {
  output: string;
  /** Null while the command still runs (it passed its timeout). */
  exitCode: number | null;
  timedOut: boolean;
}

export interface TerminalRun {
  seatId: string;
  runId: string;
  worktree: string;
  command: string;
  timeoutMs: number;
}

export interface TerminalCommandInput {
  command: string;
  worktree: string;
  /** Extra operator folders which no terminal command may read. */
  denyRead: readonly string[];
  /** When present, each command must start with one of these plain prefixes. */
  commands?: readonly string[];
}

const TERMINAL_CREDENTIAL_FOLDERS = [
  ".local/share/mission-control",
  "Library/Application Support/eBull",
  ".ssh",
  ".config/gh",
  ".git-credentials",
  ".netrc",
  "Library/Keychains",
] as const;

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const sandboxPath = (path: string) => {
  if (
    [...path].some(
      (character) =>
        character === '"' ||
        character === "\\" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Terminal sandbox path contains an unsafe character.");
  return `"${path}"`;
};

/**
 * Seatbelt confines every process the terminal pane starts. Unlike command inspection, this
 * resolves shell expansions, symlinks and interpreter-controlled file access at execution time.
 */
export function terminalSandboxProfile(input: {
  worktree: string;
  scratch: string;
  denyRead: readonly string[];
  /** The hub's loopback port remains private while other local development services work. */
  denyLocalPorts?: readonly number[];
}): string {
  const denied = [
    ...TERMINAL_CREDENTIAL_FOLDERS.map((folder) => join(homedir(), folder)),
    ...input.denyRead,
  ];
  return [
    "(version 1)",
    "(allow default)",
    // A pane may use development services on the local machine, but not the hub or the internet.
    "(deny network-outbound)",
    '(allow network-outbound (remote ip "127.0.0.1:*"))',
    '(allow network-outbound (remote ip "::1:*"))',
    ...(input.denyLocalPorts ?? []).flatMap((port) => [
      `(deny network-outbound (remote ip "127.0.0.1:${port}"))`,
      `(deny network-outbound (remote ip "::1:${port}"))`,
    ]),
    // Process environments carry the operator's inherited credentials. Keychain APIs use
    // securityd rather than the keychain files, so deny that service as well.
    "(deny process-info*)",
    '(deny mach-lookup (global-name "com.apple.securityd"))',
    '(deny mach-lookup (global-name "com.apple.securityd.xpc"))',
    "(deny file-write*)",
    `(allow file-write* (subpath ${sandboxPath(resolve(input.worktree))}))`,
    `(allow file-write* (subpath ${sandboxPath(resolve(input.scratch))}))`,
    ...denied.map((path) => `(deny file-read* (subpath ${sandboxPath(resolve(path))}))`),
  ].join("\n");
}

const localHost = (value: string) => {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?:]|$)/.test(value);
  }
};

const outsideWorktree = (path: string, worktree: string) => {
  const absolute =
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : resolve(worktree, path);
  const root = resolve(worktree);
  return !(absolute === root || absolute.startsWith(`${root}/`));
};

/**
 * The pane runs with the operator's authority. Apply the normal writer guard to every parsed
 * command, then reject paths and network calls which the sandbox would otherwise contain.
 */
export function terminalCommandDecision(input: TerminalCommandInput): string | null {
  const denied = [
    ...TERMINAL_CREDENTIAL_FOLDERS.map((folder) => join(homedir(), folder)),
    ...input.denyRead,
  ].map((path) => resolve(path));
  const pathDecision = (arg: string) => {
    if (!/^(?:\/|~(?:\/|$)|\.\.\/)/.test(arg)) return null;
    const path =
      arg === "~" || arg.startsWith("~/")
        ? join(homedir(), arg.slice(2))
        : resolve(input.worktree, arg);
    if (denied.some((folder) => path === folder || path.startsWith(`${folder}/`)))
      return "Terminal command refused: it reads an operator credential folder.";
    if (outsideWorktree(arg, input.worktree))
      return "Terminal command refused: paths outside the seat worktree are not available in the terminal.";
    return null;
  };
  for (const redirect of input.command.matchAll(/(?:^|[^\\])(?:>>?|<)\s*([^\s;&|]+)/g)) {
    const refused = pathDecision(redirect[1] ?? "");
    if (refused !== null) return refused;
  }
  const commands = splitCommands(input.command);
  for (const argv of commands) {
    const command = argv.join(" ");
    const verdict = guardDecision(
      { tool: "Bash", input: { command } },
      { mode: "writer", repo: "dev", flightPowers: "standard", fullSuite: [] },
    );
    if (verdict.kind === "deny") return `Terminal command refused: ${verdict.text}`;
    if (
      input.commands &&
      !input.commands.some((prefix) => command === prefix || command.startsWith(`${prefix} `))
    )
      return "Terminal command refused: it is outside this repository's terminal_commands allowlist.";
    const [program, ...args] = argv;
    const executable = basename(program ?? "");
    if (["ps", "pgrep", "top", "lsof", "vmmap", "sample", "leaks"].includes(executable))
      return "Terminal command refused: process inspection can expose operator credentials.";
    if (executable === "security")
      return "Terminal command refused: credential-service access is not available in the terminal.";
    if (["curl", "wget"].includes(program ?? "")) {
      const targets = args.filter((arg) =>
        /^(?:https?:\/\/|localhost(?::\d+)?(?:[/?:]|$)|127\.0\.0\.1(?::\d+)?(?:[/?:]|$)|\[::1\])/.test(
          arg,
        ),
      );
      if (targets.length === 0 || targets.some((target) => !localHost(target)))
        return "Terminal command refused: curl and wget may only reach a local host.";
    }
    for (const arg of args) {
      const refused = pathDecision(arg);
      if (refused !== null) return refused;
    }
  }
  return null;
}

/** Resolve terminal policy from the live repository configuration at the command boundary. */
export function terminalCommandPolicy(
  config: CcConfig,
  repoId: string,
  worktree: string,
  command: string,
): string | null {
  return terminalCommandDecision({
    command,
    worktree,
    denyRead: config.crew?.denyRead ?? [],
    commands: config.repos.find((repo) => repo.id === repoId)?.terminalCommands,
  });
}

interface SeatTerminalDeps {
  cmux: Pick<Cmux, "workspaces" | "newPane" | "sendPane" | "closePane">;
  /** Where the hub keeps each command's script, output and exit code. */
  dir: string;
  /** The push gate's recorder: a configured check that passes here counts at push. */
  checks?: Pick<CheckRecorder, "admit" | "release" | "begin" | "end">;
  /** The shared test lock: a full suite typed here waits its turn like one run in the sandbox. */
  lock?: Pick<TestLock, "acquire" | "release" | "state">;
  /** The full suite `command` runs, by the guard's classification, or null when it runs none. */
  suiteOf?: (run: TerminalRun) => string | null;
  lockWaitMs?: number;
  pollMs?: number;
  /** Refuses a command before it is typed into the operator's pane. */
  commandGuard?: (input: TerminalRun) => string | null;
  /** Seatbelt profile for the pane; absent only in isolated unit fixtures. */
  sandboxProfile?: (worktree: string) => string;
  log?(message: string): void;
}

export interface SeatTerminal {
  run(input: TerminalRun): Promise<TerminalResult>;
  /** Closes the panes of seats whose run has ended, and ends any command they left running. */
  tick(liveSeatIds: readonly string[]): Promise<void>;
}

/** The pane keeps the operator's toolchain, but never the hub or provider credentials. */
export function terminalPaneShell(profile?: string, command?: string): string {
  const login = `unset GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY; for name in \${(k)parameters}; do [[ $name == MC_* ]] && unset "$name"; done; exec "\${SHELL:-/bin/zsh}" -l${command === undefined ? "" : ` -c ${shellQuote(command)}`}`;
  const shell = `exec /bin/zsh -fc ${shellQuote(login)}`;
  if (profile === undefined) return shell;
  if (!existsSync(SANDBOX_EXEC)) throw new Error("Seat terminal requires macOS sandbox-exec.");
  return `exec ${shellQuote(SANDBOX_EXEC)} -p ${shellQuote(profile)} ${shell}`;
}

const tail = (text: string) =>
  text.length <= TERMINAL_OUTPUT_MAX ? text : text.slice(-TERMINAL_OUTPUT_MAX);

/**
 * The full suite a terminal command runs, by the same classification as a guarded shell call (the
 * guard's verdict, then the related-tests check), or null. A line the writer guard would refuse
 * still runs here, outside the sandbox, so each of its commands is classified on its own.
 */
export function terminalSuite(
  config: CcConfig,
  repoId: string,
  worktree: string,
  command: string,
  lockedBy: (command: string) => string | null,
): string | null {
  const suite = (line: string) => {
    const event = { tool: "Bash", input: { command: line } };
    const verdict = crewGuardDecision(config, repoId, "writer", event, undefined, [], worktree);
    return verdict.kind === "lock" ? verdict.command : lockedBy(line);
  };
  const whole = suite(command);
  if (whole !== null) return whole;
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const found = part.trim() === "" ? null : suite(part.trim());
    if (found !== null) return found;
  }
  return null;
}

export function createSeatTerminal(deps: SeatTerminalDeps): SeatTerminal {
  const pollMs = deps.pollMs ?? 500;
  const panes = new Map<string, { surface: string; worktree: string }>();
  /** The command each seat has running, until it ends or its run is torn down. */
  const busy = new Map<string, { command: string; cancel: () => Promise<void> }>();

  const paneOf = async (seatId: string, worktree: string, fresh: boolean) => {
    const kept = panes.get(seatId);
    if (kept !== undefined && !fresh && kept.worktree === worktree) return kept.surface;
    if (kept !== undefined) await deps.cmux.closePane(kept.surface).catch(() => {});
    const workspace = await seatWorkspace(deps.cmux, seatId);
    if (workspace === null) throw new Error("No live cmux workspace for this seat.");
    const surface = await deps.cmux.newPane(
      workspace,
      worktree,
      terminalPaneShell(deps.sandboxProfile?.(worktree)),
    );
    panes.set(seatId, { surface, worktree });
    return surface;
  };

  const type = async (seatId: string, worktree: string, text: string) => {
    try {
      await deps.cmux.sendPane(await paneOf(seatId, worktree, false), text);
    } catch (error) {
      if (error instanceof Error && /No live cmux workspace/.test(error.message)) throw error;
      // the operator closed the pane: open a fresh one and type once more
      await deps.cmux.sendPane(await paneOf(seatId, worktree, true), text);
    }
  };

  return {
    async run({ seatId, runId, worktree, command, timeoutMs }) {
      const refused = deps.commandGuard?.({ seatId, runId, worktree, command, timeoutMs });
      if (refused !== null && refused !== undefined) throw new Error(refused);
      const held = busy.get(seatId);
      if (held !== undefined)
        throw new Error(`A command is still running in this seat's terminal: ${held.command}`);
      const key: CallKey = { runId, toolUseId: `terminal-${randomUUID()}` };
      const holder = await deps.checks?.admit?.(key, command);
      if (holder) throw new Error(`${holder} is still running in this seat's checkout.`);
      const suite = deps.lock
        ? (deps.suiteOf?.({ seatId, runId, worktree, command, timeoutMs }) ?? null)
        : null;
      if (suite !== null && deps.lock) {
        let granted = false;
        try {
          granted = await deps.lock.acquire(
            key,
            seatId,
            suite,
            deps.lockWaitMs ?? LOCK_WAIT_MS,
            new AbortController().signal,
          );
        } catch (error) {
          deps.checks?.release?.(key);
          throw error;
        }
        if (!granted) {
          deps.checks?.release?.(key);
          const h = deps.lock.state().holder;
          throw new Error(
            lockBusyText(h === null ? "another seat" : seatCallSign(h.seatId), h?.command ?? suite),
          );
        }
      }
      const unlock = () => {
        if (suite !== null) deps.lock?.release(key);
      };

      const base = join(deps.dir, key.toolUseId);
      const files = {
        command: `${base}.command.sh`,
        runner: `${base}.sh`,
        out: `${base}.out`,
        exit: `${base}.exit`,
      };
      const remove = () =>
        Promise.all(
          [...Object.values(files), `${files.exit}.tmp`].map((f) => rm(f, { force: true })),
        ).catch(() => {});
      let answered = false;
      let cancelled = false;
      let watched: Promise<unknown> = Promise.resolve();
      busy.set(seatId, {
        command,
        // the run ended: stop watching, free the seat, close the check record and the lock now
        cancel: async () => {
          cancelled = true;
          await watched;
        },
      });
      let started = false;
      try {
        await mkdir(deps.dir, { recursive: true });
        await writeFile(files.command, `cd ${shellQuote(worktree)} || exit 1\n${command}\n`);
        // bash, whatever the pane's shell: PIPESTATUS keeps the command's own exit code past tee
        await writeFile(
          files.runner,
          [
            `bash ${shellQuote(files.command)} 2>&1 | tee ${shellQuote(files.out)}`,
            `echo "\${PIPESTATUS[0]}" > ${shellQuote(`${files.exit}.tmp`)}`,
            `mv ${shellQuote(`${files.exit}.tmp`)} ${shellQuote(files.exit)}`,
            "",
          ].join("\n"),
        );
        await deps.checks?.begin(key, command, [], { timeoutMs: CHECK_BASH_TIMEOUT_MS });
        await type(seatId, worktree, `bash ${shellQuote(files.runner)}`);
        started = true;
      } catch (error) {
        busy.delete(seatId);
        await remove();
        deps.checks?.release?.(key);
        unlock();
        if (!started) await deps.checks?.end(key, false, null);
        throw error;
      }

      const output = async () => tail(await readFile(files.out, "utf8").catch(() => ""));
      const exitCode = async () => {
        const said = await readFile(files.exit, "utf8").catch(() => null);
        return said === null ? null : Number.parseInt(said.trim(), 10);
      };
      // watches the command to its end, up to the check limit, even after the answer went back
      const watch = (async () => {
        const startedAt = Date.now();
        let code: number | null = null;
        while (!cancelled && Date.now() - startedAt < CHECK_BASH_TIMEOUT_MS) {
          code = await exitCode();
          if (code !== null) break;
          await new Promise((r) => setTimeout(r, pollMs));
        }
        const ended = !cancelled && code !== null && !Number.isNaN(code) ? code : null;
        await deps.checks?.end(key, ended === 0, ended);
        unlock();
        busy.delete(seatId);
        if (cancelled) deps.log?.(`${seatId}'s run ended while its terminal command ran.`);
        else if (ended === null) deps.log?.(`${seatId}'s terminal command passed the check limit.`);
        // its answer went back at the timeout: nobody reads these files now
        if (answered || cancelled) await remove();
        return ended;
      })();
      watched = watch;
      const timedOut = Symbol("timedOut");
      let timer: NodeJS.Timeout | undefined;
      const ended = await Promise.race([
        watch,
        new Promise<typeof timedOut>((r) => {
          timer = setTimeout(() => r(timedOut), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (ended === timedOut) {
        answered = true;
        return { output: await output(), exitCode: null, timedOut: true };
      }
      const result = { output: await output(), exitCode: ended, timedOut: false };
      await remove();
      return result;
    },
    async tick(liveSeatIds) {
      const live = new Set(liveSeatIds);
      for (const [seatId, running] of busy) if (!live.has(seatId)) await running.cancel();
      for (const [seatId, pane] of panes) {
        if (live.has(seatId)) continue;
        panes.delete(seatId);
        await deps.cmux.closePane(pane.surface).catch((error) => deps.log?.(String(error)));
      }
    },
  };
}
