/**
 * Keeps the `claude` and `codex` CLIs current by themselves, behind a live check, when
 * `updates.cli` is `between_runs`. Only a patch or minor step is taken (a risk tier of Auto, see
 * `AUDIT_KIND_TIERS`); a new major version is recorded as a Go-ahead Audit item and never
 * installed. The step: hold new runs, install the new version, run one seat's tool on it against
 * a harmless recorded task, keep it if that passes, else put the previous version back, hold the
 * failed version until a newer one appears and raise one item for FLIGHT. Every step is logged.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COMMAND } from "@mc/core";
import { CASK_PATH, type CliHold, type ExecFn } from "./cli-update.ts";
import { CLAUDE_COMMAND, resolveOnPath } from "./cli-version.ts";
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

/** What the update needs from a tool: its version source, its installer and its live check. */
export interface CliToolOps {
  /** The newest published version, or null when the source does not answer. */
  latest(): Promise<string | null>;
  /** The version a seat would start now, or null when the tool is not there. */
  installed(): Promise<string | null>;
  install(version: string): Promise<{ ok: boolean; error?: string }>;
  /** The live check of `version`: the tool runs a recorded harmless task. */
  check(version: string): Promise<{ ok: boolean; detail: string }>;
}

export type AutoCliOutcome =
  | "current"
  | "held"
  | "busy"
  | "major"
  | "applied"
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

/**
 * One update pass for one tool. Never throws on a failed step: the outcome says what happened.
 * Holds new runs only for the length of the install and check, and only if nobody else holds them.
 */
export async function autoUpdateCli(
  tool: AutoCliTool,
  ops: CliToolOps,
  deps: AutoCliDeps,
): Promise<AutoCliOutcome> {
  const { store, hold, now } = deps;
  const log = (line: string) => deps.log(`cli update ${tool}: ${line}`);
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
  if (hold.reason !== null) return "busy";

  const reason = `${tool} CLI is updating to ${latest}; no new runs start until it passes its live check`;
  hold.hold(reason);
  log(`${previous} -> ${latest}: new runs held, installing`);
  let keepHeld = false;
  try {
    const installed = await ops.install(latest);
    let failure: string | null = null;
    if (!installed.ok) {
      failure = `install failed: ${installed.error ?? "no reason given"}`;
    } else if ((await ops.installed()) !== latest) {
      failure = `install left a different version than ${latest}`;
    } else {
      log(`${latest} installed, running the live check`);
      const checked = await ops.check(latest);
      if (checked.ok) {
        store.recordAuditItem({
          kind: "cli-update",
          subject: `${tool}@${latest}`,
          state: "done",
          detail: `${tool} updated ${previous} -> ${latest}; live check passed`,
          at: now(),
        });
        if (held !== null) store.clearNote(noteKey(tool, held), now());
        log(`live check passed, keeping ${latest}`);
        return "applied";
      }
      failure = `live check failed: ${checked.detail}`;
    }

    log(`${latest} failed (${failure}); putting ${previous} back`);
    store.setSetting(heldKey(tool), latest);
    const back = await ops.install(previous);
    const restored = back.ok && (await ops.installed()) === previous;
    const text = restored
      ? `${tool} CLI ${latest} failed (${failure}); rolled back to ${previous}. ${latest} is not retried until a newer version appears`
      : `${tool} CLI ${latest} failed (${failure}) and putting ${previous} back failed too (${back.error ?? "wrong version after install"}); no new runs start until it is fixed by hand`;
    store.recordAuditItem({
      kind: "cli-update-failed",
      subject: `${tool}@${latest}`,
      state: "open",
      detail: text,
      at: now(),
    });
    store.raiseNote({
      key: noteKey(tool, latest),
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: null,
      text,
      at: now(),
    });
    log(restored ? `rolled back to ${previous}` : `rollback to ${previous} failed`);
    keepHeld = !restored;
    return restored ? "rolled-back" : "rollback-failed";
  } finally {
    if (!keepHeld) hold.release();
    else
      hold.hold(
        `${tool} CLI is broken and could not be rolled back; no new runs start until it is fixed`,
      );
  }
}

/** The npm-backed ops for `tool`; `exec` runs the commands (no shell). */
export function realCliOps(tool: AutoCliTool, exec: ExecFn, env?: NodeJS.ProcessEnv): CliToolOps {
  const command = COMMANDS[tool];
  const pkg = NPM_PACKAGES[tool];
  const installed = async (): Promise<string | null> => {
    const r = await exec(command, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
    return r.code === 0 ? (FIRST_VERSION.exec(r.stdout)?.[0] ?? null) : null;
  };
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
      const r = await exec(NPM_COMMAND, ["install", "-g", `${pkg}@${version}`], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env,
      });
      return r.code === 0
        ? { ok: true }
        : { ok: false, error: firstLine(r.stderr) || `exit ${r.code}` };
    },
    async check(version) {
      const said = await installed();
      if (said !== version) return { ok: false, detail: `--version said ${said ?? "nothing"}` };
      // The task: read a file the harness just wrote and say what is in it. Only a tool call
      // can know the nonce, so a model that merely answers does not pass.
      const dir = mkdtempSync(join(tmpdir(), "mc-cli-check-"));
      try {
        const nonce = randomBytes(8).toString("hex");
        const file = `check-${randomBytes(4).toString("hex")}.txt`;
        writeFileSync(join(dir, file), nonce);
        const prompt = `Read the file ${file} in the current directory and reply with its exact contents and nothing else.`;
        const args =
          tool === "claude"
            ? ["-p", "--model", "haiku", "--allowedTools", "Read", prompt]
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

/** Whether Homebrew's cask check (`checkCli`) already keeps `tool` current, so this update leaves it alone. */
export function brewKeepsCurrent(tool: AutoCliTool, path = process.env.PATH ?? ""): boolean {
  if (tool !== "claude") return false;
  try {
    const found = resolveOnPath(CLAUDE_COMMAND, path);
    return found !== null && CASK_PATH.test(realpathSync(found));
  } catch {
    return false;
  }
}
