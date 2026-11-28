/**
 * A crew seat's terminal pane: one pane in the seat's own cmux workspace, opened in its worktree,
 * where the hub types the commands the seat's sandbox cannot run (the stack, migrations, database
 * tests). It runs as the operator, outside the seat sandbox. Each command's output and exit code
 * go to files the hub reads; the pane stays open for the operator to watch.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECK_BASH_TIMEOUT_MS, LOCK_WAIT_MS, lockBusyText, seatCallSign } from "@mc/core";
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
  log?(message: string): void;
}

export interface SeatTerminal {
  run(input: TerminalRun): Promise<TerminalResult>;
  /** Closes the panes of seats whose run has ended, and ends any command they left running. */
  tick(liveSeatIds: readonly string[]): Promise<void>;
}

/** The pane's own shell: the operator's login shell, so PATH and tools match their terminal. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter, expanded by the pane's shell
const PANE_SHELL = 'exec "${SHELL:-/bin/zsh}" -l';

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
  const panes = new Map<string, string>();
  /** The command each seat has running, until it ends or its run is torn down. */
  const busy = new Map<string, { command: string; cancel: () => Promise<void> }>();

  const paneOf = async (seatId: string, worktree: string, fresh: boolean) => {
    const kept = panes.get(seatId);
    if (kept !== undefined && !fresh) return kept;
    if (kept !== undefined) await deps.cmux.closePane(kept).catch(() => {});
    const workspace = await seatWorkspace(deps.cmux, seatId);
    if (workspace === null) throw new Error("No live cmux workspace for this seat.");
    const surface = await deps.cmux.newPane(workspace, worktree, PANE_SHELL);
    panes.set(seatId, surface);
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
      for (const [seatId, surface] of panes) {
        if (live.has(seatId)) continue;
        panes.delete(seatId);
        await deps.cmux.closePane(surface).catch((error) => deps.log?.(String(error)));
      }
    },
  };
}
