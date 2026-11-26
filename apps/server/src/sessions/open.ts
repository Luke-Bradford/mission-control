/**
 * Opens a new cmux session for the operator: a plain Claude session (no seat environment, no
 * sandbox) in a folder or a fresh worktree, with a role's prompt and a first message. The session is
 * his from the start: its name never has a seat's ` · `, so the Sessions page lists it as his.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  type OpenSessionInput,
  SESSION_FOLDER_TEXT,
  SESSION_ROLE_TEXT,
  SESSION_TEXT_MAX,
} from "@mc/core";
import { z } from "zod";
import { cleanText } from "../repo/clean.ts";
import type { Cmux } from "../runtime/cmux.ts";
import { answerTrustPrompt } from "../runtime/cmux-session.ts";
import { pidAlive } from "../runtime/keeper.ts";
import type { Store } from "../store.ts";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

/** A new session's input as the page and FLIGHT's cmux_open send it; open checks the folder and role. */
export const OpenSessionArgs = z.strictObject({
  folder: z.string().min(1).max(4096),
  worktree: z.boolean().default(false),
  role: z.string().min(1).max(100),
  message: z.string().min(1).max(SESSION_TEXT_MAX),
  name: z.string().max(200).optional(),
});

/** A refusal with the HTTP status the API gives it: 400 for the input, 503 when cmux fails. */
export class SessionOpenError extends Error {
  readonly status: 400 | 503;
  constructor(status: 400 | 503, message: string) {
    super(message);
    this.name = "SessionOpenError";
    this.status = status;
  }
}

/**
 * What opening needs of cmux: the workspaces open before it, a new workspace running `command` in
 * `cwd`, its screen and keys to answer Claude's folder-trust prompt, and a close for a start that
 * failed.
 */
export type SessionCmux = Pick<
  Cmux,
  "workspaces" | "newWorkspace" | "readScreen" | "sendKey" | "close"
>;

/** The roles a session may take: the `roles/*.md` files but the README, sorted, without `.md`. */
export function sessionRoles(rolesDir: string): string[] {
  try {
    return readdirSync(rolesDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The script the workspace runs: cmux's shim stays first on PATH, so it wraps `claude` with its
 * hooks; the script's pid, which the exec makes Claude's, goes to `pidFile`. Every argument is
 * quoted, so the role and message reach Claude as they are; `--` ends the options, so a message
 * that starts with `-` is still the prompt.
 */
export function sessionScript(i: {
  rolePrompt: string;
  message: string;
  pidFile: string;
  nodeDir?: string;
}): string {
  const nodeDir = i.nodeDir ?? dirname(process.execPath);
  return [
    "#!/bin/zsh",
    `export PATH="\${CMUX_CLAUDE_WRAPPER_SHIM_ROOT:+$CMUX_CLAUDE_WRAPPER_SHIM_ROOT:}"${quote(nodeDir)}":$PATH"`,
    `echo $$ > ${quote(i.pidFile)}`,
    `exec ${["claude", "--append-system-prompt", i.rolePrompt, "--", i.message].map(quote).join(" ")}`,
    "",
  ].join("\n");
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** `20261125-195500` in UTC: a worktree's slug, unique to the second. */
const stamp = (at: number): string =>
  new Date(at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** A fresh worktree of the folder's repo on `session/<slug>`, from origin's default branch. No fetch. */
async function freshWorktree(folder: string, role: string, at: number): Promise<string> {
  try {
    const top = (
      await run("git", ["-C", folder, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT_MS })
    ).stdout.trim();
    const slug = `${role.toLowerCase()}-${stamp(at)}`;
    const path = join(dirname(top), `${basename(top)}-sessions`, slug);
    await run(
      "git",
      ["-C", top, "worktree", "add", "-b", `session/${slug}`, "--", path, "origin/HEAD"],
      { timeout: GIT_TIMEOUT_MS },
    );
    return path;
  } catch (e) {
    const said = e instanceof Error ? ((e as { stderr?: string }).stderr ?? e.message) : String(e);
    throw new SessionOpenError(400, `git could not make the worktree: ${cleanText(said.trim())}`);
  }
}

/** The pid the launch script wrote, or null while it has not. */
const pidOf = (pidFile: string): number | null => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/**
 * Checks the input, makes the worktree when asked, writes the launch script and opens the
 * workspace, then waits for Claude to be up, answering its folder-trust prompt (a fresh worktree
 * always shows it). A start that fails closes its workspace and is a 503. Logs a hub event naming
 * who asked; the message itself is never logged.
 */
export async function openSession(
  deps: {
    cmux: SessionCmux;
    store: Store;
    rolesDir: string;
    now?: () => number;
    /** How long Claude has to be up, and how often its screen is read: the trust step's defaults when unset. */
    startWaitMs?: number;
    pollMs?: number;
  },
  input: OpenSessionInput,
  askedBy: string,
): Promise<{ id: string; name: string; folder: string; pidFile: string }> {
  const now = deps.now ?? Date.now;
  if (!isAbsolute(input.folder) || !isFolder(input.folder))
    throw new SessionOpenError(400, SESSION_FOLDER_TEXT);
  if (!sessionRoles(deps.rolesDir).includes(input.role))
    throw new SessionOpenError(400, SESSION_ROLE_TEXT);
  if (input.message.trim().length === 0 || input.message.length > SESSION_TEXT_MAX)
    throw new SessionOpenError(400, `message must be 1 to ${SESSION_TEXT_MAX} characters.`);
  const at = now();
  const cwd = input.worktree ? await freshWorktree(input.folder, input.role, at) : input.folder;
  // a seat's workspace is `<seat> · <ref>`: an operator's session never reads as one
  const name = (input.name?.trim() || `${basename(input.folder)} (${input.role})`).replaceAll(
    " · ",
    " - ",
  );
  const rolePrompt = readFileSync(join(deps.rolesDir, `${input.role}.md`), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "mc-session-"));
  const script = join(dir, "launch.zsh");
  const pidFile = join(dir, "pid");
  writeFileSync(script, sessionScript({ rolePrompt, message: input.message, pidFile }), {
    mode: 0o700,
  });
  let id: string;
  try {
    // every workspace open before this one is excluded: a same-named one is never taken for it,
    // so a failed start closes only the workspace this open made
    const before = new Set((await deps.cmux.workspaces()).map((w) => w.id));
    id = await deps.cmux.newWorkspace({ name, cwd, command: quote(script), exclude: before });
  } catch (e) {
    throw new SessionOpenError(503, e instanceof Error ? e.message : String(e));
  }
  try {
    await answerTrustPrompt(deps.cmux, id, {
      alive: () => {
        const pid = pidOf(pidFile);
        return pid === null ? null : pidAlive(pid);
      },
      waitMs: deps.startWaitMs,
      pollMs: deps.pollMs,
    });
  } catch (e) {
    await deps.cmux.close(id).catch(() => {});
    throw new SessionOpenError(503, e instanceof Error ? e.message : String(e));
  }
  deps.store.addHubEvent(
    `Opened cmux session "${name}" in ${cwd} as ${input.role}, asked by ${askedBy}`,
    at,
  );
  return { id, name, folder: cwd, pidFile };
}
