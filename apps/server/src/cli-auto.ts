/**
 * Keeps the `claude` and `codex` CLIs current by themselves, behind a live check, when
 * `updates.cli` is `between_runs`. Only a patch or minor step is taken (a risk tier of Auto, see
 * `AUDIT_KIND_TIERS`); a new major version is recorded as a Go-ahead Audit item and never
 * installed. The step: hold new runs, install the new version, start one idle seat on it through
 * the supervisor's own start path against a harmless recorded task, keep it if that passes, else
 * put the previous version back, hold the failed version until a newer one appears and raise one
 * item for FLIGHT. A check that could not run (every seat of the vendor is busy) proves nothing
 * and rolls nothing back: the update waits, held, for the next pass. Every step is logged.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CODEX_COMMAND, CODEX_MIN_VERSION } from "@mc/core";
import type { CliHold, ExecFn } from "./cli-update.ts";
import { CLAUDE_COMMAND, resolveOnPath } from "./cli-version.ts";
import type { CliCheckResult } from "./runtime/cli-check.ts";
import { codexVersionAllowed } from "./runtime/codex-floor.ts";
import type { Store } from "./store.ts";

export const AUTO_CLI_TOOLS = ["claude", "codex"] as const;
export type AutoCliTool = (typeof AUTO_CLI_TOOLS)[number];

/** The only shape of version that reaches a command: three numbers. */
const VERSION = /^\d+\.\d+\.\d+$/;
const FIRST_VERSION = /\d+\.\d+\.\d+/;
const NPM_COMMAND = "npm";
const NPM_PACKAGES: Record<AutoCliTool, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};
const COMMANDS: Record<AutoCliTool, string> = { claude: CLAUDE_COMMAND, codex: CODEX_COMMAND };
const REGISTRY_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
const MAX_LINE = 200;
/** How long an update may wait for its live check to be able to run before the previous version goes back. */
export const CLI_CHECK_WAIT_MAX_MS = 60 * 60_000;

/** What the update needs from a tool: its version source, its installer and its live check. */
export interface CliToolOps {
  /** The newest published version, or null when the source does not answer. */
  latest(): Promise<string | null>;
  /** The version a seat would start now, or null when the tool is not there. */
  installed(): Promise<string | null>;
  install(version: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * The live check of `version`: a seat runs a recorded harmless task on it. `retry`: the check
   * could not run (no seat was free), so the version is neither proven nor failed.
   */
  check(version: string): Promise<{ ok: boolean; detail: string; retry?: boolean }>;
}

/** Runs the live check through a seat of `tool`'s vendor (the supervisor's `checkCli`). */
export type SeatCheck = (tool: AutoCliTool) => Promise<CliCheckResult>;

export type AutoCliOutcome =
  | "current"
  | "held"
  | "busy"
  | "major"
  | "applied"
  | "waiting"
  | "gave-up"
  | "rolled-back"
  | "rollback-failed";

export interface AutoCliDeps {
  store: Store;
  /** The hold that keeps new runs from starting while the new version is unproven. */
  hold: CliHold;
  log: (line: string) => void;
  now: () => number;
}

const heldKey = (tool: AutoCliTool) => `cli-auto-held:${tool}`;
const noteKey = (tool: AutoCliTool, version: string) => `cli-auto:${tool}:${version}`;

/** The version of `tool` that failed its live check and is not retried, else null. */
export function heldCliVersion(store: Store, tool: AutoCliTool): string | null {
  return store.getSetting(heldKey(tool));
}

const parts = (v: string): number[] => v.split(".").map(Number);

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The kind of item an update from `from` to `to` is: a new major version is Go-ahead, the rest Auto. */
export function cliUpdateKind(from: string, to: string): "cli-update" | "cli-update-major" {
  return parts(to)[0] > parts(from)[0] ? "cli-update-major" : "cli-update";
}

const firstLine = (text: string): string =>
  (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, MAX_LINE);

/** Returns the string when it is a plain x.y.z version, else null. */
const asVersion = (v: string | null): string | null => (v !== null && VERSION.test(v) ? v : null);

const pendingKey = (tool: AutoCliTool) => `cli-auto-pending:${tool}`;
/** The hold owner of `tool`'s update, so no other path's release can end it. */
export const cliAutoHoldOwner = (tool: AutoCliTool) => `cli-auto:${tool}`;

/** An install that has begun and not yet passed its live check or been rolled back. */
export interface PendingCliUpdate {
  from: string;
  to: string;
  /** When the live check first could not run (no free seat); absent while it has not had to wait. */
  waitingSince?: number;
}

/** The update of `tool` the hub began and did not finish (it restarted, or the rollback failed), else null. */
export function pendingCliUpdate(store: Store, tool: AutoCliTool): PendingCliUpdate | null {
  const raw = store.getSetting(pendingKey(tool));
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingCliUpdate>;
    return asVersion(v.from ?? null) !== null && asVersion(v.to ?? null) !== null
      ? {
          from: v.from as string,
          to: v.to as string,
          ...(typeof v.waitingSince === "number" ? { waitingSince: v.waitingSince } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** The text of the hold while an unproven version is in use. */
export const cliAutoHoldText = (tool: AutoCliTool, to: string): string =>
  `${tool} CLI ${to} has not passed its live check; no new runs start until it does or is rolled back`;

/**
 * Ends the hold of an update that a tool this job no longer manages left pending (the operator
 * reinstalled it another way, so it is no longer an npm install). Only while the tool is on PATH:
 * a tool that is missing keeps its hold. Returns whether it settled anything.
 */
export function settlePending(
  store: Store,
  hold: CliHold,
  tool: AutoCliTool,
  log: (line: string) => void,
  path = process.env.PATH ?? "",
): boolean {
  const pending = pendingCliUpdate(store, tool);
  if (pending === null || resolveOnPath(COMMANDS[tool], path) === null) return false;
  store.deleteSetting(pendingKey(tool));
  store.clearNote(noteKey(tool, pending.to), Date.now());
  hold.release(cliAutoHoldOwner(tool));
  log(`cli update ${tool}: no longer an npm install; leaving it to whatever installed it`);
  return true;
}

/** Tools with a pass in flight in this process: a second tick for one waits for the next interval. */
const running = new Set<AutoCliTool>();

/**
 * One update pass for one tool. Never throws on a failed step: the outcome says what happened.
 * New runs are held (under this tool's own owner) from before the install until the version has
 * passed its live check or the previous one is back. The begun update is stored, so a restart in
 * the middle, or a rollback that failed, is picked up by the next pass.
 */
export async function autoUpdateCli(
  tool: AutoCliTool,
  ops: CliToolOps,
  deps: AutoCliDeps,
): Promise<AutoCliOutcome> {
  if (running.has(tool)) return "busy";
  running.add(tool);
  try {
    return await pass(tool, ops, deps);
  } finally {
    running.delete(tool);
  }
}

async function pass(
  tool: AutoCliTool,
  ops: CliToolOps,
  deps: AutoCliDeps,
): Promise<AutoCliOutcome> {
  const { store, hold, now } = deps;
  const owner = cliAutoHoldOwner(tool);
  const log = (line: string) => deps.log(`cli update ${tool}: ${line}`);
  const done = (outcome: AutoCliOutcome): AutoCliOutcome => {
    store.deleteSetting(pendingKey(tool));
    hold.release(owner);
    return outcome;
  };

  /** Puts `from` back after `to` failed for `failure`; the hold stays when the tool is not back on `from`. */
  const rollBack = async (from: string, to: string, failure: string): Promise<AutoCliOutcome> => {
    log(`${to} failed (${failure}); putting ${from} back`);
    store.setSetting(heldKey(tool), to);
    let error: string | null = null;
    // a failed install that changed nothing leaves the working version where it was
    if ((await ops.installed()) !== from) {
      const back = await ops.install(from);
      if (!back.ok) error = back.error ?? "no reason given";
    }
    const restored = (await ops.installed()) === from;
    const text = restored
      ? `${tool} CLI ${to} failed (${failure}); rolled back to ${from}. ${to} is not retried until a newer version appears`
      : `${tool} CLI ${to} failed (${failure}) and ${from} is not back (${error ?? "wrong version after install"}); no new runs start until it is fixed by hand`;
    store.recordAuditItem({
      kind: "cli-update-failed",
      subject: `${tool}@${to}`,
      state: "open",
      detail: text,
      at: now(),
    });
    store.raiseNote({
      key: noteKey(tool, to),
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: null,
      text,
      at: now(),
    });
    log(restored ? `rolled back to ${from}` : `rollback to ${from} failed`);
    if (restored) return done("rolled-back");
    hold.hold(cliAutoHoldText(tool, to), owner);
    return "rollback-failed";
  };

  /**
   * The live check never got to run for `CLI_CHECK_WAIT_MAX_MS`: `to` is unproven, not bad. The
   * previous version goes back, `to` is not held (a later pass tries it again) and runs are freed.
   */
  const giveUp = async (from: string, to: string, why: string): Promise<AutoCliOutcome> => {
    log(
      `live check could not run for too long (${why}); putting ${from} back and trying again later`,
    );
    let error: string | null = null;
    if ((await ops.installed()) !== from) {
      const back = await ops.install(from);
      if (!back.ok) error = back.error ?? "no reason given";
    }
    if ((await ops.installed()) === from) return done("gave-up");
    log(`rollback to ${from} failed (${error ?? "wrong version after install"})`);
    hold.hold(cliAutoHoldText(tool, to), owner);
    return "rollback-failed";
  };

  /** The live check of the installed `to`; keeps it on a pass, else rolls back to `from`. */
  const verify = async (from: string, to: string): Promise<AutoCliOutcome> => {
    log(`${to} installed, running the live check`);
    const checked = await ops.check(to);
    if (checked.retry === true) {
      // nothing was proven: the hold and the pending record stay, and the next pass checks again;
      // but not for ever, since the hold keeps every seat's next run from starting
      const since = pendingCliUpdate(store, tool)?.waitingSince ?? now();
      if (now() - since >= CLI_CHECK_WAIT_MAX_MS) return giveUp(from, to, checked.detail);
      store.setSetting(pendingKey(tool), JSON.stringify({ from, to, waitingSince: since }));
      log(`live check could not run (${checked.detail}); ${to} stays held until it can`);
      hold.hold(cliAutoHoldText(tool, to), owner);
      return "waiting";
    }
    if (!checked.ok) return rollBack(from, to, `live check failed: ${checked.detail}`);
    store.recordAuditItem({
      kind: "cli-update",
      subject: `${tool}@${to}`,
      state: "done",
      detail: `${tool} updated ${from} -> ${to}; live check passed`,
      at: now(),
    });
    const held = heldCliVersion(store, tool);
    if (held !== null) store.clearNote(noteKey(tool, held), now());
    log(`live check passed, keeping ${to}`);
    return done("applied");
  };

  const pending = pendingCliUpdate(store, tool);
  if (pending !== null) {
    hold.hold(cliAutoHoldText(tool, pending.to), owner);
    const current = await ops.installed();
    log(`resuming ${pending.from} -> ${pending.to}; ${current ?? "nothing"} is installed`);
    if (current === pending.to) return verify(pending.from, pending.to);
    // no version answers: the tool is broken, so put the previous one back (and keep the hold if that fails)
    if (current === null) return rollBack(pending.from, pending.to, "no working version installed");
    // some other version is installed (the previous one, or one put there by hand): nothing is left to prove
    return done("current");
  }

  const latest = asVersion(await ops.latest());
  const previous = asVersion(await ops.installed());
  if (latest === null || previous === null || compare(latest, previous) <= 0) return "current";

  if (cliUpdateKind(previous, latest) === "cli-update-major") {
    store.recordAuditItem({
      kind: "cli-update-major",
      subject: `${tool}@${latest}`,
      state: "open",
      detail: `${tool} ${latest} is a new major version; ${previous} stays until the operator says go`,
      at: now(),
    });
    log(`${previous} -> ${latest} is a major version; not installed`);
    return "major";
  }
  const held = heldCliVersion(store, tool);
  if (held !== null && compare(latest, held) <= 0) return "held";

  store.setSetting(pendingKey(tool), JSON.stringify({ from: previous, to: latest }));
  hold.hold(cliAutoHoldText(tool, latest), owner);
  log(`${previous} -> ${latest}: new runs held, installing`);
  const installed = await ops.install(latest);
  if (!installed.ok)
    return rollBack(previous, latest, `install failed: ${installed.error ?? "no reason given"}`);
  if ((await ops.installed()) !== latest) {
    return rollBack(previous, latest, `install left a different version than ${latest}`);
  }
  return verify(previous, latest);
}

/**
 * The npm global prefix that owns `tool`'s binary on `path`: the one whose
 * `lib/node_modules/<package>/` holds the file the command resolves to. Null when the tool is
 * not there or came from somewhere else (a Homebrew cask or formula, the native installer): npm
 * would put a second copy elsewhere, so such a tool is left to whatever installed it.
 */
export function npmPrefix(tool: AutoCliTool, path = process.env.PATH ?? ""): string | null {
  try {
    const found = resolveOnPath(COMMANDS[tool], path);
    if (found === null) return null;
    const real = realpathSync(found);
    const marker = `${sep}lib${sep}node_modules${sep}${NPM_PACKAGES[tool]}${sep}`;
    const at = real.indexOf(marker);
    return at > 0 ? real.slice(0, at) : null;
  } catch {
    return null;
  }
}

/** The npm-backed ops for `tool`, installing into `prefix`; `exec` runs the commands (no shell). */
export function realCliOps(
  tool: AutoCliTool,
  exec: ExecFn,
  prefix: string,
  env?: NodeJS.ProcessEnv,
  seatCheck?: SeatCheck,
): CliToolOps {
  const command = COMMANDS[tool];
  const pkg = NPM_PACKAGES[tool];
  const rawVersion = async (): Promise<string | null> => {
    const r = await exec(command, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
    return r.code === 0 ? r.stdout : null;
  };
  const installed = async (): Promise<string | null> =>
    FIRST_VERSION.exec((await rawVersion()) ?? "")?.[0] ?? null;
  return {
    async latest() {
      const r = await exec(NPM_COMMAND, ["view", pkg, "version"], {
        timeoutMs: REGISTRY_TIMEOUT_MS,
        env,
      });
      return r.code === 0 ? asVersion(r.stdout.trim()) : null;
    },
    installed,
    async install(version) {
      if (!VERSION.test(version)) return { ok: false, error: "not a plain x.y.z version" };
      const r = await exec(
        NPM_COMMAND,
        ["--prefix", prefix, "install", "-g", `${pkg}@${version}`],
        {
          timeoutMs: INSTALL_TIMEOUT_MS,
          env,
        },
      );
      return r.code === 0
        ? { ok: true }
        : { ok: false, error: firstLine(r.stderr) || `exit ${r.code}` };
    },
    async check(version) {
      const raw = await rawVersion();
      const said = FIRST_VERSION.exec(raw ?? "")?.[0] ?? null;
      if (said !== version) return { ok: false, detail: `--version said ${said ?? "nothing"}` };
      // the floor a seat start applies to codex
      if (tool === "codex" && !codexVersionAllowed(raw ?? "")) {
        return {
          ok: false,
          detail: `codex ${version} is under the seat floor ${CODEX_MIN_VERSION}`,
        };
      }
      // The check a seat's own start path runs, in a throwaway worktree. It is not repeated here.
      if (seatCheck !== undefined) {
        const seat = await seatCheck(tool);
        if (seat.kind === "ran") return { ok: seat.ok, detail: seat.detail };
        if (seat.kind === "busy") {
          return { ok: false, retry: true, detail: `every ${tool} seat is busy` };
        }
        if (seat.kind === "unproven") {
          return { ok: false, retry: true, detail: `the check could not start: ${seat.detail}` };
        }
        // no seat of this vendor is configured: no run can break on this tool, so the bare check stands
      }
      // The task: read a file the harness just wrote and say what is in it. Only a tool call
      // can know the nonce, so a model that merely answers does not pass. No permission bypass,
      // and only the one read-only tool, in an empty temp dir.
      const dir = mkdtempSync(join(tmpdir(), "mc-cli-check-"));
      try {
        const nonce = randomBytes(8).toString("hex");
        const file = `check-${randomBytes(4).toString("hex")}.txt`;
        writeFileSync(join(dir, file), nonce);
        const prompt = `Read the file ${file} in the current directory and reply with its exact contents and nothing else.`;
        // `--allowedTools` takes many values: the `=` form keeps the prompt out of its list
        const args =
          tool === "claude"
            ? ["-p", "--model", "haiku", "--allowedTools=Read", prompt]
            : ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", dir, prompt];
        const r = await exec(command, args, { timeoutMs: CHECK_TIMEOUT_MS, env, cwd: dir });
        if (r.code === 0 && r.stdout.includes(nonce)) {
          return { ok: true, detail: "version and one tool call answered" };
        }
        const text = r.code === 0 ? r.stdout : r.stderr || r.stdout;
        return { ok: false, detail: firstLine(text) || "the tool call returned nothing" };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
