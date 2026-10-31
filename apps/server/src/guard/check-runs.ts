/**
 * The checks a repo configures (`mc.checks`), as a seat runs them. The hub never runs a check: they
 * execute the seat's code, which stays in the seat's sandbox. The seat runs each as an ordinary shell
 * call and the hub records how the call ended, on which commit, so `mc push` can ask for the record.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECK_BASH_TIMEOUT_DEFAULT_MS,
  type CheckDrop,
  type CheckDropReason,
  type RepoRules,
  splitCommands,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { seatPlace } from "../mcp/tools.ts";
import { adminDirOf, COMMIT_ADD_PATHSPEC } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import type { Store } from "../store.ts";

/** A command that chains, pipes, or runs on after a failure can pass without the check passing. */
const NOT_PLAIN = /[|;\n\r]/;

/**
 * The configured checks this shell command runs: split on `&&` only, and the call counts only when
 * EVERY trimmed segment is a configured check. Anything else in the chain (`cd x`, `exit 0`, a
 * shell function, an edit) could change what the check sees or whether it runs, so it counts for
 * nothing. A command holding `|`, `||`, `;` or a line break counts for nothing too.
 */
export function checksRun(command: string, checks: readonly string[]): string[] {
  if (checks.length === 0 || NOT_PLAIN.test(command)) return [];
  const segments = command.split("&&").map((s) => s.trim());
  if (segments.some((s) => !checks.includes(s))) return [];
  return checks.filter((c) => segments.includes(c));
}

/**
 * The configured check a shell command runs, for the test lock. The guard's shell parser reads the
 * call, so a chain, a pipe, a redirection or a wrapper (`command`, `env`) still counts (the check
 * still loads the Mac); a command that only mentions a check, or adds an argument to it, does not.
 */
export function lockedCheck(command: string, checks: readonly string[]): string | null {
  const ran = splitCommands(command);
  for (const check of checks) {
    const want = splitCommands(check)[0];
    if (want === undefined) continue;
    if (ran.some((argv) => argv.length === want.length && argv.every((w, i) => w === want[i]))) {
      return check;
    }
  }
  return null;
}

/** The seat clone's state at one moment: its checked-out commit, and whether the worktree has no change, untracked files included. */
export interface CloneState {
  head: string;
  clean: boolean;
}

/** One shell call, as the hooks and the Codex driver know it. */
export interface CallKey {
  runId: string;
  toolUseId: string;
}

/** What the hook knows of a shell call's setup, which the recorder needs to say why a call was dropped. */
export interface CallOptions {
  /** The call asked to run in the background. */
  background?: boolean;
  /** The call's own Bash `timeout` (ms); Claude's default applies when it names none. */
  timeoutMs?: number;
}

export interface CheckRecorder {
  /** A shell call is about to start: keep the head and cleanliness it starts on. */
  begin(
    key: CallKey,
    command: string,
    aliases?: readonly CallKey[],
    options?: CallOptions,
  ): Promise<void>;
  /** The call ended; `ok` is its exit success. Records one row per matched check. */
  end(key: CallKey, ok: boolean, exitCode?: number | null): Promise<void>;
  /** The configured check this shell command runs, which takes the test lock; null when none (or the rules cannot be read). */
  lockedBy(runId: string, command: string): Promise<string | null>;
  /** The run has no call in flight (its turn ended): forget the ones that never reported an end. */
  dropRun(runId: string): void;
  /** The check calls of this run the hub saw start and did not count, oldest first, each with its reason. */
  drops(runId: string): readonly CheckDrop[];
}

/** How many dropped calls the recorder keeps for one run, and for how many runs. */
const DROPS_PER_RUN = 30;
const DROPPED_RUNS = 200;

export interface CheckRecorderDeps {
  store: Pick<Store, "addCheckRun">;
  /** The run's repo's configured checks; empty when it has none (throws when its rules cannot be read). */
  checks: (runId: string) => Promise<readonly string[]>;
  /** The run's clone now, or null when it cannot be read. */
  state: (runId: string) => Promise<CloneState | null>;
  now?: () => number;
  log?: (line: string) => void;
}

interface StartedCall {
  runId: string;
  matched: string[];
  command: string;
  head: string;
  startedAt: number;
  timeoutMs: number;
}

const callId = (k: CallKey): string => `${k.runId}\0${k.toolUseId}`;

export function createCheckRecorder(d: CheckRecorderDeps): CheckRecorder {
  const now = d.now ?? Date.now;
  /** Calls that started on a clean tree and matched a check: what they matched, and the head. */
  const started = new Map<string, StartedCall>();
  /** Calls the recorder saw start and did not count, by run; in memory, so a restart forgets them. */
  const dropped = new Map<string, CheckDrop[]>();
  const noteDrop = (
    runId: string,
    reason: CheckDropReason,
    commands: readonly string[],
    head: string | null,
    invoked: string,
  ): void => {
    const list = dropped.get(runId) ?? [];
    for (const command of commands) list.push({ reason, command, head, invoked, at: now() });
    dropped.delete(runId);
    dropped.set(runId, list.slice(-DROPS_PER_RUN));
    for (const old of dropped.keys()) {
      if (dropped.size <= DROPPED_RUNS) break;
      dropped.delete(old);
    }
  };
  /** A check was counted: what was said earlier about why it was not no longer applies. */
  const settle = (runId: string, command: string): void => {
    const list = dropped.get(runId);
    if (list === undefined) return;
    const rest = list.filter((x) => x.command !== command);
    if (rest.length === 0) dropped.delete(runId);
    else dropped.set(runId, rest);
  };
  return {
    async lockedBy(runId, command) {
      try {
        return lockedCheck(command, await d.checks(runId));
      } catch (e) {
        d.log?.(`checks: could not read the checks for ${runId}: ${(e as Error).message}`);
        return null;
      }
    },
    async begin(key, command, aliases = [], options = {}) {
      try {
        const checks = await d.checks(key.runId);
        const matched = checksRun(command, checks);
        if (matched.length === 0) {
          // a configured check inside a chain, a pipe or a list is not counted: say so
          const inside = lockedCheck(command, checks);
          if (inside === null) return;
          const at = await d.state(key.runId).catch(() => null);
          noteDrop(key.runId, "not-plain", [inside], at?.head ?? null, command);
          return;
        }
        const at = await d.state(key.runId);
        if (at === null) {
          noteDrop(key.runId, "unreadable", matched, null, command);
          return;
        }
        // a dirty tree: the check ran on something no commit holds
        if (!at.clean) {
          noteDrop(key.runId, "dirty-start", matched, at.head, command);
          return;
        }
        // a background call reports its end at once, long before the check has run
        if (options.background) {
          noteDrop(key.runId, "background", matched, at.head, command);
          return;
        }
        const call = {
          runId: key.runId,
          matched,
          command,
          head: at.head,
          startedAt: now(),
          timeoutMs: options.timeoutMs ?? CHECK_BASH_TIMEOUT_DEFAULT_MS,
        };
        started.set(callId(key), call);
        for (const alias of aliases) started.set(callId(alias), call);
      } catch (e) {
        d.log?.(`checks: could not start a record for ${key.runId}: ${(e as Error).message}`);
      }
    },
    async end(key, ok, exitCode = null) {
      const call = started.get(callId(key));
      if (call === undefined) return;
      for (const [id, startedCall] of started) if (startedCall === call) started.delete(id);
      try {
        const at = await d.state(key.runId);
        // the head moved, or the call left the tree dirty: it did not check the commit it started on
        if (at === null) {
          noteDrop(key.runId, "unreadable", call.matched, call.head, call.command);
          return;
        }
        if (at.head !== call.head) {
          noteDrop(key.runId, "head-moved", call.matched, call.head, call.command);
          return;
        }
        if (!at.clean) {
          noteDrop(key.runId, "dirty-end", call.matched, call.head, call.command);
          return;
        }
        for (const command of call.matched) {
          settle(key.runId, command);
          d.store.addCheckRun({
            runId: key.runId,
            command,
            invokedCommand: call.command,
            headSha: call.head,
            ok,
            exitCode,
            at: now(),
          });
        }
        // a failure with no exit code after the Bash timeout is the CLI killing the call, not the check failing
        if (!ok && exitCode === null && now() - call.startedAt >= call.timeoutMs - 1_000) {
          noteDrop(key.runId, "timeout", call.matched, call.head, call.command);
        }
      } catch (e) {
        d.log?.(`checks: could not record for ${key.runId}: ${(e as Error).message}`);
      }
    },
    dropRun(runId) {
      // a call can sit under two ids (Codex): it is one call
      const calls = new Set<StartedCall>();
      for (const [id, call] of started) {
        if (call.runId !== runId) continue;
        started.delete(id);
        calls.add(call);
      }
      for (const call of calls)
        noteDrop(runId, "turn-ended", call.matched, call.head, call.command);
    },
    drops(runId) {
      return dropped.get(runId) ?? [];
    },
  };
}

/**
 * A run's clone as the hub reads it: HEAD and `git status` in the seat's worktree, through `crewGit`
 * (which refuses a checkout whose git dirs are not the clone's), with the worktree's admin dir named
 * from the clone's side.
 */
export function cloneState(
  config: CcConfig,
  store: Pick<Store, "run" | "seatSession">,
): (runId: string) => Promise<CloneState | null> {
  return async (runId) => {
    const run = store.run(runId);
    const place = run === null ? null : seatPlace(config, run.agentId);
    const worktree = run === null ? null : (store.seatSession(run.agentId)?.worktree ?? null);
    if (place === null || worktree === null) return null;
    const common = await realpath(join(place.session.checkout, ".git"));
    const gitDir = await adminDirOf(common, worktree);
    if (gitDir === null) return null;
    const g = (args: string[]) => crewGit(worktree, args, common, { gitDir });
    const head = (await g(["rev-parse", "--verify", "HEAD"])).trim();
    // the hub's own test of a clean tree (the commit tool's): untracked files count
    const dirty = await g([
      "--no-optional-locks",
      "status",
      "--porcelain",
      "--untracked-files=all",
      ...COMMIT_ADD_PATHSPEC,
    ]);
    return { head, clean: dirty.trim() === "" };
  };
}

/** A run's configured checks from the engine's rules reader; throws when the rules cannot be read. */
export function configuredChecks(
  store: Pick<Store, "run">,
  rules: (repoId: string) => Promise<RepoRules | Error | null>,
): (runId: string) => Promise<readonly string[]> {
  return async (runId) => {
    const run = store.run(runId);
    if (run === null) return [];
    const r = await rules(run.repoId);
    // unreadable rules fail closed: the push fails (and is retried), it is never ungated
    if (r instanceof Error) throw r;
    return r === null ? [] : r.checks;
  };
}
