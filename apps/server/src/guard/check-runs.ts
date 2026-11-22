/**
 * The checks a repo configures (`mc.checks`), as a seat runs them. The hub never runs a check: they
 * execute the seat's code, which stays in the seat's sandbox. The seat runs each as an ordinary shell
 * call and the hub records how the call ended, on which commit, so `mc push` can ask for the record.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECK_BASH_TIMEOUT_DEFAULT_MS,
  CHECK_BASH_TIMEOUT_MS,
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
import { NOT_PLAIN, plainCall } from "./plain-call.ts";

export { plainCall };

/** The related-tests run, as a repo's `checks` list spells it. */
export const RELATED_CHECK = "pnpm -s test:related";

/**
 * The configured checks this shell command runs: split on `&&` only, and the call counts only when
 * EVERY trimmed segment is a configured check. When it is not configured, `pnpm -s test:related`
 * is allowed only at the end as a companion, not a recorded check. Anything else in the chain
 * (`cd x`, `exit 0`, a shell function, an edit) could change what the check sees or whether it
 * runs, so it counts for nothing. A command holding `|`, `||`, `;` or a line break counts for
 * nothing too.
 */
export function checksRun(command: string, checks: readonly string[]): string[] {
  if (checks.length === 0 || NOT_PLAIN.test(command)) return [];
  const segments = command.split("&&").map((s) => s.trim());
  const relatedAtEnd =
    !checks.includes(RELATED_CHECK) && segments.length > 1 && segments.at(-1) === RELATED_CHECK;
  const checkSegments = relatedAtEnd ? segments.slice(0, -1) : segments;
  if (checkSegments.some((s) => !checks.includes(s))) return [];
  return checks.filter((c) => checkSegments.includes(c));
}

function hasRelatedTestsCompanion(command: string): boolean {
  const segments = command.split("&&");
  return segments.length > 1 && segments.at(-1)?.trim() === RELATED_CHECK;
}

/** A leading `cd <path>` joined to the rest by `&&` or `;`; the path is bare, or in single or double quotes. */
const LEADING_CD = /^\s*cd\s+(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`\\&;|<>()*?[\]{}~]+))\s*(?:&&|;)/;

/**
 * The command with a leading `cd` into the seat's own worktree taken off. The seat's shell starts in
 * its worktree, so that `cd` changes nothing the check sees (and with `;` the status is still the
 * check's own). A `cd` anywhere else, or into any other path, is left in place and so counts for nothing.
 */
export function withoutOwnCd(command: string, worktree: string | null): string {
  const m = worktree === null ? null : LEADING_CD.exec(command);
  if (m === null || worktree === null) return command;
  const path = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\/+$/, "");
  return path !== "" && path === worktree.replace(/\/+$/, "")
    ? command.slice(m[0].length)
    : command;
}

/**
 * The configured check a shell command runs, even inside a chain or a pipe. It serves the test
 * lock (the related-tests check) and the note that says why a chained check was not counted. The guard's shell parser reads the
 * call, so a chain, a pipe, a redirection or a wrapper (`command`, `env`) still counts (the check
 * still loads the Mac); a command that only mentions a check, or adds an argument to it, does not.
 */
export function lockedCheck(command: string, checks: readonly string[]): string | null {
  const ran = splitCommands(command).map(lockForm);
  for (const check of checks) {
    const want = splitCommands(check)[0];
    if (want === undefined) continue;
    const form = lockForm(want);
    if (ran.some((argv) => argv.length === form.length && argv.every((w, i) => w === form[i]))) {
      return check;
    }
  }
  return null;
}

/** A vitest or `pnpm test` command: it loads the Mac like a check, so it waits for one too. */
export function testCommand(command: string): boolean {
  return splitCommands(command).some((argv) => {
    const form = lockForm(argv);
    return (
      form[0] === "vitest" ||
      (form[0] === "pnpm" &&
        (form[1] === "vitest" || form[1] === "test" || form[1] === "test:related"))
    );
  });
}

/** The script the related-tests check runs: `pnpm test:related` is this node call. */
const RELATED_SCRIPT = ["node", "--experimental-strip-types", "scripts/check-related.ts"];

/**
 * A command's words with the spellings of one pnpm script folded together: `pnpm -s test:related`,
 * `pnpm test:related` and `pnpm run test:related` load the Mac alike, so they take the same lock.
 * The related-tests script run through node folds to `pnpm test:related`.
 */
function lockForm(argv: readonly string[]): readonly string[] {
  if (argv.length === RELATED_SCRIPT.length && argv.every((w, i) => w === RELATED_SCRIPT[i]))
    return ["pnpm", "test:related"];
  if (argv[0] !== "pnpm") return argv;
  const rest = argv.slice(1).filter((w, i) => !(i === 0 && w === "-s"));
  return ["pnpm", ...(rest[0] === "run" ? rest.slice(1) : rest)];
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
  /** RELATED_CHECK when this shell command runs it, which takes the test lock (it can run the whole suite); else null. */
  lockedBy(command: string): string | null;
  /**
   * Reserves this run's checkout for a check, vitest or pnpm test command, or names the one that
   * holds it (one at a time per checkout). Null when this command is none of those, or the
   * reservation is made. The reservation ends with the call's end, its refusal (`release`), the turn
   * ending, or its own Bash timeout.
   */
  admit?(key: CallKey, command: string): Promise<string | null>;
  /** The reserved call will not run (refused, or its lock wait failed): free the checkout. */
  release?(key: CallKey): void;
  /** The run has no call in flight (its turn ended): forget the ones that never reported an end. */
  dropRun(runId: string): void;
  /** Codex confirmed this command's exec cell or process is gone before it reported an exit code. */
  lost(runId: string, command: string): boolean;
  /** The check calls of this run the hub saw start and did not count, oldest first, each with its reason. */
  drops(runId: string): readonly CheckDrop[];
  /** Configured checks still executing or validating their completion, once per command. */
  pending(runId: string): readonly string[];
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
  /** The run's seat worktree, or null when unknown (a leading `cd` then counts for nothing). */
  worktree?: (runId: string) => Promise<string | null>;
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
  /** The related-tests companion is last, so its failure must not exhaust a check retry. */
  relatedTests: boolean;
}

const callId = (k: CallKey): string => `${k.runId}\0${k.toolUseId}`;

export function createCheckRecorder(d: CheckRecorderDeps): CheckRecorder {
  const now = d.now ?? Date.now;
  /** Calls that started on a clean tree and matched a check: what they matched, and the head. */
  const started = new Map<string, StartedCall>();
  const finishing = new Set<StartedCall>();
  /** The one check or test call each run may have in flight, whether or not it is a receipt check. */
  const reservations = new Map<string, { key: CallKey; command: string; at: number }>();
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
    lockedBy: (command) => lockedCheck(command, [RELATED_CHECK]),
    async admit(key, command) {
      try {
        const checks = await d.checks(key.runId);
        if (lockedCheck(command, [...checks, RELATED_CHECK]) === null && !testCommand(command))
          return null;
        // no await from here: the check and the reservation are one step
        const at = now();
        const held = reservations.get(key.runId);
        if (held !== undefined && at - held.at < CHECK_BASH_TIMEOUT_MS) {
          return callId(held.key) === callId(key) ? null : held.command;
        }
        reservations.set(key.runId, { key, command, at });
        return null;
      } catch (e) {
        d.log?.(`checks: could not admit a check for ${key.runId}: ${(e as Error).message}`);
        return null;
      }
    },
    release(key) {
      const held = reservations.get(key.runId);
      if (held !== undefined && callId(held.key) === callId(key)) reservations.delete(key.runId);
    },
    async begin(key, command, aliases = [], options = {}) {
      try {
        const checks = await d.checks(key.runId);
        const own = d.worktree === undefined ? null : await d.worktree(key.runId).catch(() => null);
        const matched = checksRun(withoutOwnCd(command, own), checks);
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
          // the CLI cuts a longer `timeout` down to its limit
          timeoutMs: Math.min(
            options.timeoutMs ?? CHECK_BASH_TIMEOUT_DEFAULT_MS,
            CHECK_BASH_TIMEOUT_MS,
          ),
          relatedTests: !matched.includes(RELATED_CHECK) && hasRelatedTestsCompanion(command),
        };
        // A new Codex call with the same command replaces an earlier one that never delivered a
        // completion. Its exec cell no longer exists, so keeping the old receipt pending would
        // block both this fresh call and the eventual push until the turn ends.
        const replaced = new Set<StartedCall>();
        for (const [id, startedCall] of started) {
          if (startedCall.runId !== key.runId || startedCall.command !== command) continue;
          started.delete(id);
          replaced.add(startedCall);
        }
        for (const prior of replaced)
          noteDrop(key.runId, "session-lost", prior.matched, prior.head, prior.command);
        started.set(callId(key), call);
        for (const alias of aliases) started.set(callId(alias), call);
      } catch (e) {
        d.log?.(`checks: could not start a record for ${key.runId}: ${(e as Error).message}`);
      }
    },
    async end(key, ok, exitCode = null) {
      const call = started.get(callId(key));
      const held = reservations.get(key.runId);
      if (
        held !== undefined &&
        (callId(held.key) === callId(key) || held.command === call?.command)
      )
        reservations.delete(key.runId);
      if (call === undefined) return;
      finishing.add(call);
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
            // The shell only returns one status. When related tests are last, a failure could be
            // theirs, so it cannot be evidence that a configured check failed or consume its retry.
            exitCode: !ok && call.relatedTests ? null : exitCode,
            at: now(),
          });
        }
        // a failure with no exit code after the Bash timeout is the CLI killing the call, not the check failing
        if (!ok && exitCode === null && now() - call.startedAt >= call.timeoutMs - 1_000) {
          noteDrop(key.runId, "timeout", call.matched, call.head, call.command);
        }
      } catch (e) {
        d.log?.(`checks: could not record for ${key.runId}: ${(e as Error).message}`);
      } finally {
        finishing.delete(call);
      }
    },
    dropRun(runId) {
      reservations.delete(runId);
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
    lost(runId, command) {
      if (reservations.get(runId)?.command === command) reservations.delete(runId);
      const calls = new Set<StartedCall>();
      for (const [id, call] of started) {
        if (call.runId !== runId || !call.matched.includes(command)) continue;
        started.delete(id);
        calls.add(call);
      }
      for (const call of calls)
        noteDrop(runId, "session-lost", call.matched, call.head, call.command);
      return calls.size > 0;
    },
    drops(runId) {
      return dropped.get(runId) ?? [];
    },
    pending(runId) {
      return [
        ...new Set(
          [...started.values(), ...finishing]
            .filter((call) => call.runId === runId)
            .flatMap((call) => call.matched),
        ),
      ];
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

/** A run's seat worktree, or null when it has none. */
export function seatWorktree(
  store: Pick<Store, "run" | "seatSession">,
): (runId: string) => Promise<string | null> {
  return async (runId) => {
    const run = store.run(runId);
    return run === null ? null : (store.seatSession(run.agentId)?.worktree ?? null);
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
