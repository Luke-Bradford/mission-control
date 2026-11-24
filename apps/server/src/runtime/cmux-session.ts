/**
 * The driver for one Claude run as a cmux workspace: an interactive `claude` the operator can see,
 * type into and clear. The hub starts the workspace (a launcher script, so the seat's own settings and
 * MCP config are kept), sends messages, and reads the seat's state from `cmux sessions` and its
 * results from Claude's own transcript, which is copied into the run's transcript as the keeper did.
 * It speaks the same `CrewSession` the keeper-backed drivers do.
 */
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isObj, type SessionEvent } from "@mc/core";
import { parseJson, rethrowJson } from "../json.ts";
import { toolResultBytes } from "../telemetry/prompt-cost.ts";
import { sleep, str } from "../util.ts";
import type { Cmux, CmuxAgent } from "./cmux.ts";
import { pidAlive } from "./keeper.ts";
import { type CrewSession, SessionControlError } from "./session.ts";

/** The hub's record of a run's workspace: `{"workspace": uuid, "pid": n | null}`. */
export const cmuxWorkspaceKey = (runId: string) => `cmux.workspace:${runId}`;
/** How far the hub has read Claude's transcript for a run, kept after its workspace closes (a resume needs it). */
export const cmuxSourceKey = (runId: string) => `cmux.source:${runId}`;
/** Set while a Claude run is on the keeper because cmux was down or refused the hub at its start. */
export const cmuxKeeperKey = (runId: string) => `cmux.keeper:${runId}`;

export const CMUX_START_FAILED = "cmux did not start Claude";
export const CMUX_ENDED = "the Claude process in cmux ended";
/** What the seat is told when a message is too long to type: it reads the file. */
export const cmuxMessageText = (path: string) =>
  `Mission Control sent you a message. Read ${path} and act on it.`;

const POLL_MS = 1000;
const START_WAIT_MS = 60_000;
/** How often a message that met an open dialog is tried again. */
const BUSY_RETRY_MS = 2000;
/** A result is made for a turn the poll never saw running once the transcript has been quiet this long. */
const QUIET_POLLS = 2;
/** The words of Claude's folder-trust prompt. */
const TRUST_PROMPT =
  /trust (this|the files in this) (folder|directory)|do you trust|Quick safety check|Accessing workspace:/i;
/** One option of a dialog's menu, the cursor's marked: `❯ 1. No, exit`. */
const MENU_OPTION = /^\s*([❯›>])?\s*(?:\d+\.\s+)?((?:Yes|No)\b.*?)\s*$/i;
/** What Claude prints when it quits at the trust prompt: the start has failed, and no key may follow. */
const TRUST_REFUSED = /folder isn't trusted/i;
export const CMUX_TRUST_QUIT = "Claude quit at its folder-trust prompt";
export const CMUX_QUIT_EARLY = "Claude quit before it started";
/** The file in the run's folder the launcher writes Claude's pid to. */
export const CMUX_PID_FILE = "claude.pid";
/** Keys to the trust prompt go one a poll at most: each after a fresh read of the screen. */
const TRUST_KEY_GAP_MS = 500;

/**
 * The trust prompt's menu, read from the screen below the prompt's last words: whether the cursor is
 * on the "Yes" option. Null when no live menu with a cursor and a "Yes" option shows.
 */
export function trustMenu(screen: string): { onYes: boolean } | null {
  const rows = screen.split("\n");
  let from = -1;
  rows.forEach((r, n) => {
    // the "Yes, I trust this folder" option has the prompt's words too: the menu follows the prompt
    if (TRUST_PROMPT.test(r) && !MENU_OPTION.test(r)) from = n;
  });
  if (from < 0) return null;
  let cursor: string | null = null;
  let yes = false;
  for (const r of rows.slice(from)) {
    const m = MENU_OPTION.exec(r);
    if (m === null) continue;
    const text = m[2] as string;
    if (/^Yes\b/i.test(text)) yes = true;
    if (m[1] !== undefined) cursor = text;
  }
  if (cursor === null || !yes) return null;
  return { onYes: /^Yes\b/i.test(cursor) };
}
/** Claude's tool permission dialog: the hub refuses it, so no seat waits on a person. */
/**
 * Claude's tool permission dialog, and only it: its question, its fixed first option and its fixed
 * refusal option, together. A question of the seat's own that merely starts "Do you want to proceed"
 * has none of the fixed options, so it stays the operator's.
 */
export function isPermissionPrompt(screen: string): boolean {
  // the terminal wraps a long path or command: the question and the refusal may cross lines
  const flat = screen.replace(/\s+/g, " ");
  return (
    /Do you want to (proceed|make this edit|create|allow|run)\b[^?]{0,2000}\?/i.test(flat) &&
    /^\W*1\.\s+Yes\s*$/m.test(screen) &&
    // the refusal reads "No, and tell Claude what to do differently" on older Claude; from 2.1.331
    // it is a bare "No" under a tool's header, with "Tab to amend" in the footer. A bare Yes/No with
    // neither is some other question, and that one is the operator's.
    (/\bNo, and tell Claude what to do differently\b/.test(flat) ||
      (/^\W*\d+\.\s+No\s*$/m.test(screen) &&
        /\bTab to amend\b|^\W*(Bash command|Edit file|Create file|Write file|Read file|Fetch)\b/m.test(
          screen,
        )))
  );
}
/** What the seat is told after the hub refuses a permission prompt, so it does not wait for a person. */
export const CMUX_TOOL_REFUSED_TEXT =
  "Mission Control refused that tool call: it is outside this seat's allowed tools. Carry on without it, or report that you are blocked.";
/** A refused prompt still showing at the next poll is not refused again until this has passed. */
const DENY_RETRY_MS = 2000;
/** The last of a run's records whose lines the poll reads at once. */
const READ_CHUNK = 4 * 1024 * 1024;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The script a workspace runs: the seat's environment (not PATH, which keeps cmux's shim first), then
 * `claude` by name so cmux's shim wraps it with its hooks. A secret environment file is sourced and
 * deleted before the exec.
 */
export function launcherScript(i: {
  command: string;
  args: string[];
  env: Record<string, string>;
  nodeDir: string;
  envFile: string | null;
  /** Where the launcher writes its own pid, which the exec makes Claude's: the hub sees Claude quit before its record. */
  pidFile?: string | null;
}): string {
  const lines = ["#!/bin/zsh"];
  for (const [k, v] of Object.entries(i.env)) {
    if (k === "PATH" || !ENV_NAME.test(k)) continue;
    lines.push(`export ${k}=${quote(v)}`);
  }
  // cmux's shim folder stays ahead of the node folder, which may hold its own `claude`: the shim
  // takes itself off PATH before it runs the claude it finds next
  lines.push(
    `export PATH="\${CMUX_CLAUDE_WRAPPER_SHIM_ROOT:+$CMUX_CLAUDE_WRAPPER_SHIM_ROOT:}"${quote(i.nodeDir)}":$PATH"`,
  );
  if (i.envFile !== null) {
    lines.push(`. ${quote(i.envFile)}`, `rm -f ${quote(i.envFile)}`);
  }
  if (i.pidFile != null) lines.push(`echo $$ > ${quote(i.pidFile)}`);
  lines.push(`exec ${[i.command, ...i.args].map(quote).join(" ")}`, "");
  return lines.join("\n");
}

/** The file a secret environment is written to: sourced by the launcher, then gone. */
export function envFileText(env: Record<string, string>): string {
  return `${Object.entries(env)
    .filter(([k]) => ENV_NAME.test(k))
    .map(([k, v]) => `export ${k}=${quote(v)}`)
    .join("\n")}\n`;
}

/**
 * What the hub keeps of a run's workspace. `source` is how many lines of Claude's own transcript (this
 * file only) the hub has taken in: a restart's hub skips exactly those. Lines the hub adds itself (the
 * result it makes for a turn) are never counted in it.
 */
export interface CmuxSaved {
  workspace: string;
  pid: number | null;
  source?: { path: string; lines: number };
}

export interface CmuxSessionInput {
  cmux: Cmux;
  /** The workspace's title: `<seatId> · <ref>`. */
  name: string;
  cwd: string;
  /** `claude`, by name; tests give another command. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** FLIGHT's secrets: a 0600 file the launcher sources and removes. */
  privateEnv?: Record<string, string>;
  /** The run's folder (made 0700): the launcher and the env file go here. */
  dir: string;
  /** The run's transcript the hub reads: Claude's own lines are copied here. */
  transcriptPath: string;
  cliSessionId: string;
  /** Where long messages are written, for the seat to read. */
  messageDir: string;
  /** The node that runs the hub's own tools: its folder goes first on PATH. */
  nodeDir?: string;
  /** Workspace ids other runs hold: not this run's. */
  taken?: () => ReadonlySet<string>;
  /** Called once the workspace exists and again once Claude's pid is known; and when it is closed (null). */
  save?: (state: CmuxSaved | null) => void;
  log?: (m: string) => void;
  /** A resume: how far Claude's transcript (the same file, `--resume`) was read, so it is not copied again. */
  source?: { path: string; lines: number } | null;
  /** Default 1000. */
  pollMs?: number;
  /** Default 60000. */
  startWaitMs?: number;
}

interface Core {
  session: CrewSession;
  /** The workspace exists: polling begins. */
  begin(workspace: string): void;
  /** It could not be made: the session ends with this reason. */
  fail(reason: string): void;
  /** An attach: polling begins at once. */
  attach(): void;
}

/** One driver over a workspace: `start` is false for an attach to one already running. */
function createCmuxDriver(
  i: CmuxSessionInput,
  mode:
    | { kind: "start"; source: { path: string; lines: number } | null }
    | {
        kind: "attach";
        workspace: string;
        pid: number;
        source: { path: string; lines: number } | null;
      },
): Core {
  const pollMs = i.pollMs ?? POLL_MS;
  const listeners = new Set<(e: SessionEvent) => void>();
  let alive = true;
  let finished = false;
  let detached = false;
  let closing = false;
  let workspace = mode.kind === "attach" ? mode.workspace : "";
  let pid: number | null = mode.kind === "attach" ? mode.pid : null;
  let sessionId = i.cliSessionId;
  let lifecycle: CmuxAgent["lifecycle"] | null = null;
  /** The transcript being read, how far, and how many of its lines the hub has taken in all. */
  let source: string | null = null;
  let offset = 0;
  let pending = "";
  let lines = 0;
  /** The source transcript a restart's hub had read, and how far: skipped when that file is met again. */
  let resumeSource = mode.source;
  /** Lines to skip in the source being read: the hub has them already. */
  let skip = 0;
  /** Lines of the source being read that the hub has taken in (copied or skipped), never its own. */
  let sourceLines = 0;
  let savedLines = -1;
  /** Tokens in Claude's context at its last reply; null until one is read. */
  let contextTokens: number | null = null;
  /** When the hub last refused a permission prompt: once per prompt, not once per poll. */
  let deniedAt = 0;
  let savedPath: string | null = null;
  let attachedSaid = mode.kind !== "attach";
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let sentAt: number | null = null;
  let grew = false;
  /** How many polls since the last message sent saw the transcript grow, and how many in a row did not. */
  let growth = 0;
  let quiet = 0;
  let msgN = 0;
  let trustAt = 0;
  let trustSeen = false;
  let readyYet = mode.kind === "attach";
  // an attach has its own record to wait for: the first poll says `attached`
  const queue: string[] = [];
  let pumping = false;
  const startedAt = Date.now();

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const closeSent = exited.then(() => {});

  const emit = (e: SessionEvent) => {
    if (detached) return;
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // one broken listener must not stop the others, or the poll
      }
    }
  };

  const log = (m: string) => i.log?.(m);

  function end(info: { reason?: string; retake?: true; code?: number | null }): void {
    if (finished) return;
    finished = true;
    alive = false;
    if (timer !== undefined) clearTimeout(timer);
    resolveReady();
    emit({
      kind: "exit",
      code: info.code ?? null,
      signal: null,
      ...(info.reason === undefined ? {} : { reason: info.reason }),
      ...(info.retake ? { retake: true as const } : {}),
    });
    resolveExit(info.code ?? null);
  }

  function appendTranscript(line: string): void {
    appendFileSync(i.transcriptPath, `${line}\n`, { mode: 0o600 });
  }

  /** Saves the workspace with how far the source transcript has been read. */
  function persist(): void {
    if (source === null || (source === savedPath && sourceLines === savedLines)) return;
    savedPath = source;
    savedLines = sourceLines;
    i.save?.({ workspace, pid, source: { path: source, lines: sourceLines } });
  }

  /** The Claude process is gone: its workspace is closed (if cmux still has it) and forgotten, then the exit. */
  async function gone(reason: string): Promise<void> {
    if (workspace !== "") {
      await i.cmux.close(workspace).catch((e) => log(`${i.name}: close failed: ${e}`));
    }
    i.save?.(null);
    end({ reason });
  }

  /** Takes in the complete lines of the source transcript past where it was read. */
  function copyTranscript(path: string): void {
    if (source !== path) {
      source = path;
      offset = 0;
      pending = "";
      sourceLines = 0;
      skip = resumeSource?.path === path ? resumeSource.lines : 0;
      resumeSource = null;
    }
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) {
        // the file was cut short: read it again from its start
        offset = 0;
        pending = "";
      }
      while (offset < size) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - offset));
        const n = readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        offset += n;
        pending += buf.toString("utf8", 0, n);
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          take(line);
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  /** The context Claude's last top-level reply used: input, cache read and cache written. */
  function noteUsage(ev: unknown): void {
    if (!isObj(ev) || ev.type !== "assistant" || ev.isSidechain === true) return;
    if (ev.parent_tool_use_id !== undefined && ev.parent_tool_use_id !== null) return;
    const u = isObj(ev.message) && isObj(ev.message.usage) ? ev.message.usage : null;
    if (u === null) return;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    contextTokens =
      n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  }

  function take(line: string): void {
    if (line === "") return;
    sourceLines++;
    let ev: unknown = null;
    if (line.startsWith("{")) {
      try {
        ev = parseJson<unknown>(line, undefined, rethrowJson);
      } catch {
        ev = null;
      }
    }
    // a line the hub already has still says how full the context is
    noteUsage(ev);
    if (skip > 0) {
      skip--;
      lines++;
      return;
    }
    appendTranscript(line);
    lines++;
    grew = true;
    emit({ kind: "output", at: Date.now() });
    if (isObj(ev) && ev.type === "user" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        const id = isObj(c) && c.type === "tool_result" ? str(c.tool_use_id) : null;
        if (id !== null && isObj(c)) {
          emit({ kind: "tool-result", toolUseId: id, bytes: toolResultBytes(c.content) });
        }
      }
    }
  }

  function finishTurn(): void {
    appendTranscript(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        mc_cmux: true,
      }),
    );
    lines++;
    sentAt = null;
    quiet = 0;
    emit({ kind: "result", isError: false, stopReason: "end_turn" });
  }

  function change(next: CmuxAgent["lifecycle"]): void {
    const prev = lifecycle;
    lifecycle = next;
    if (prev === next) return;
    if (next === "running") {
      emit({ kind: "turn-start" });
      sentAt = null;
      quiet = 0;
    } else if (next === "needsInput") {
      emit({ kind: "needs-input" });
    } else if (prev === "running" || prev === "needsInput") {
      finishTurn();
    }
  }

  async function poll(): Promise<void> {
    if (finished || detached || polling || workspace === "") return;
    polling = true;
    try {
      let agents: CmuxAgent[];
      try {
        agents = await i.cmux.agents();
      } catch (e) {
        log(`${i.name}: cmux sessions failed: ${e instanceof Error ? e.message : e}`);
        // the process needs no cmux to be found gone
        if (readyYet && pid !== null && !pidAlive(pid)) await gone(CMUX_ENDED);
        return;
      }
      if (finished || detached) return;
      if (!readyYet) return await starting(agents);
      const here = agents.filter((a) => a.workspaceId === workspace);
      let seen = here.find((a) => a.sessionId === sessionId);
      if (seen === undefined) {
        // /clear: the same process, a new session
        const fresh = here.filter((a) => pid !== null && a.pid === pid).at(-1);
        if (fresh !== undefined) {
          seen = fresh;
          sessionId = fresh.sessionId;
          emit({ kind: "init", sessionId, model: null });
        } else seen = here.at(-1);
      }
      if (seen !== undefined && seen.pid !== null && pid !== null && seen.pid !== pid) {
        // cmux restored the agent without the hub's settings: closed, and resumed with the hub's command
        log(`${i.name}: cmux restored Claude under a new process; closing it`);
        await i.cmux.close(workspace).catch((e) => log(`${i.name}: close failed: ${e}`));
        i.save?.(null);
        return end({ retake: true, reason: "cmux restored the agent without the hub's settings" });
      }
      if (seen === undefined || (pid !== null && !pidAlive(pid))) return await gone(CMUX_ENDED);
      grew = false;
      if (seen.transcriptPath !== null) copyTranscript(seen.transcriptPath);
      persist();
      if (grew) growth++;
      if (!attachedSaid) {
        attachedSaid = true;
        lifecycle = seen.lifecycle;
        emit({ kind: "attached", awaiting: seen.lifecycle !== "idle" });
        return;
      }
      // A permission prompt waits on no one: the hub refuses it, as print mode refused the tool.
      // Every poll that finds it waiting looks again: a dialog not recognised at first is not left.
      if (seen.lifecycle === "needsInput" && (await refusedPrompt())) return;
      change(seen.lifecycle);
      // A turn that began and ended between two polls shows only in the transcript.
      if (sentAt !== null && lifecycle === "idle") {
        quiet = grew ? 0 : quiet + 1;
        if (quiet >= QUIET_POLLS && growth > 0) {
          emit({ kind: "turn-start" });
          finishTurn();
        }
      }
    } catch (e) {
      log(`${i.name}: cmux poll failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      polling = false;
      schedule();
    }
  }

  function schedule(): void {
    if (finished || detached) return;
    timer = setTimeout(() => void poll(), pollMs);
  }

  /**
   * True when the open dialog is a tool permission prompt and the hub has refused it. Escape makes
   * Claude stop and wait for the user, so the hub then sends the seat a message (once cmux takes
   * input) telling it to carry on without the tool. Any other dialog is the operator's.
   */
  async function refusedPrompt(): Promise<boolean> {
    let screen = "";
    try {
      screen = await i.cmux.readScreen(workspace);
    } catch {
      return false;
    }
    if (!isPermissionPrompt(screen)) return false;
    if (Date.now() - deniedAt < DENY_RETRY_MS) return true;
    deniedAt = Date.now();
    try {
      await i.cmux.sendKey(workspace, "escape", true);
      log(`${i.name}: refused a permission prompt the seat's allowlist does not cover`);
    } catch (e) {
      log(`${i.name}: could not refuse a permission prompt: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    // one word per refusal: a dialog still showing at the next look adds none while one waits
    if (!queue.includes(CMUX_TOOL_REFUSED_TEXT)) {
      queue.push(CMUX_TOOL_REFUSED_TEXT);
      void pump();
    }
    return true;
  }

  /** Before ready: answer the trust prompt, and wait for Claude's record. */
  async function starting(agents: CmuxAgent[]): Promise<void> {
    // this workspace's record only: a resume has its session id's earlier record, in a workspace now closed
    const rec = agents.find((a) => a.sessionId === sessionId && a.workspaceId === workspace);
    if (rec !== undefined) {
      pid = rec.pid;
      readyYet = true;
      lifecycle = rec.lifecycle;
      i.save?.({ workspace, pid });
      resolveReady();
      void pump();
      return;
    }
    if (Date.now() - startedAt >= (i.startWaitMs ?? START_WAIT_MS)) {
      log(`${i.name}: ${CMUX_START_FAILED}`);
      await i.cmux.close(workspace).catch(() => {});
      i.save?.(null);
      return end({ reason: CMUX_START_FAILED });
    }
    // Claude has quit before its record: no key goes to the shell left behind
    const launched = launcherPid();
    let screen = "";
    try {
      screen = await i.cmux.readScreen(workspace);
    } catch {
      // not shown yet
    }
    if ((launched !== null && !pidAlive(launched)) || TRUST_REFUSED.test(screen)) {
      const reason = trustSeen || TRUST_REFUSED.test(screen) ? CMUX_TRUST_QUIT : CMUX_QUIT_EARLY;
      log(`${i.name}: ${reason}`);
      await i.cmux.close(workspace).catch(() => {});
      i.save?.(null);
      return end({ reason });
    }
    if (launched === null || Date.now() - trustAt < TRUST_KEY_GAP_MS) return;
    const menu = trustMenu(screen);
    if (menu === null) return;
    trustSeen = true;
    trustAt = Date.now();
    // the cursor opens on "No, exit": it is moved, and Enter waits for a screen that shows it on "Yes"
    const key = menu.onYes ? "enter" : "down";
    await i.cmux.sendKey(workspace, key).catch((e) => log(`${i.name}: trust key: ${e}`));
  }

  /** The pid the launcher wrote (Claude's, after its exec); null before it has run. */
  function launcherPid(): number | null {
    try {
      const n = Number.parseInt(readFileSync(join(i.dir, CMUX_PID_FILE), "utf8"), 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      await ready;
      while (queue.length > 0 && alive && !closing) {
        const text = queue[0] as string;
        let outcome: "sent" | "busy" = "busy";
        try {
          outcome = await i.cmux.send(workspace, text);
        } catch (e) {
          log(`${i.name}: send failed: ${e instanceof Error ? e.message : e}`);
        }
        if (outcome === "sent") {
          queue.shift();
          sentAt = Date.now();
          growth = 0;
          quiet = 0;
        } else await sleep(BUSY_RETRY_MS);
      }
    } finally {
      pumping = false;
    }
  }

  const session: CrewSession = {
    send(text) {
      if (!alive || closing) throw new SessionControlError("ended", "session ended");
      let typed = text;
      if (text.includes("\n")) {
        mkdirSync(i.messageDir, { recursive: true, mode: 0o700 });
        if (msgN === 0) msgN = readdirSync(i.messageDir).length;
        msgN++;
        const path = join(i.messageDir, `${msgN}.md`);
        writeFileSync(path, text, { mode: 0o600 });
        typed = cmuxMessageText(path);
      }
      queue.push(typed);
      void pump();
    },
    control(subtype, opts) {
      if (!alive || closing)
        return Promise.reject(new SessionControlError("ended", "session ended"));
      if (subtype === "interrupt") {
        return i.cmux.sendKey(workspace, "escape", true).then(
          () => {
            opts?.onSuccess?.();
            return undefined;
          },
          (e) =>
            Promise.reject(
              new SessionControlError("refused", e instanceof Error ? e.message : String(e)),
            ),
        );
      }
      if (subtype === "get_context_usage") {
        // the shape the CLI's own answer has: the hub reads only the total
        return contextTokens === null
          ? Promise.reject(new SessionControlError("refused", "no reply read yet"))
          : Promise.resolve({ categories: [], totalTokens: contextTokens, maxTokens: null });
      }
      return Promise.reject(new SessionControlError("refused", "not available in cmux"));
    },
    async close() {
      if (!finished && !closing) {
        closing = true;
        if (workspace !== "") {
          await i.cmux.close(workspace).catch((e) => log(`${i.name}: close failed: ${e}`));
        }
        i.save?.(null);
        end({});
      }
      return exited;
    },
    detach() {
      if (detached) return;
      detached = true;
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      listeners.clear();
      resolveReady();
      resolveExit(null);
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pid() {
      return pid ?? undefined;
    },
    get alive() {
      return alive;
    },
    ready,
    get lines() {
      return lines;
    },
    closeSent,
  };

  return {
    session,
    begin(ws) {
      workspace = ws;
      void poll();
    },
    fail(reason) {
      end({ reason });
    },
    attach() {
      resolveReady();
      void poll();
    },
  };
}

/** Makes the launcher (and the secret file), opens the workspace, and drives it. Never throws. */
export function startCmuxSession(i: CmuxSessionInput): CrewSession {
  const core = createCmuxDriver(i, { kind: "start", source: i.source ?? null });
  void (async () => {
    try {
      mkdirSync(i.dir, { recursive: true, mode: 0o700 });
      const script = join(i.dir, "launch.zsh");
      let envFile: string | null = null;
      if (i.privateEnv !== undefined && Object.keys(i.privateEnv).length > 0) {
        envFile = join(i.dir, "env");
        writeFileSync(envFile, envFileText(i.privateEnv), { mode: 0o600 });
      }
      const pidFile = join(i.dir, CMUX_PID_FILE);
      rmSync(pidFile, { force: true });
      writeFileSync(
        script,
        launcherScript({
          command: i.command,
          args: i.args,
          env: i.env,
          nodeDir: i.nodeDir ?? dirname(process.execPath),
          envFile,
          pidFile,
        }),
        { mode: 0o700 },
      );
      const workspace = await i.cmux.newWorkspace({
        name: i.name,
        cwd: i.cwd,
        command: quote(script),
        ...(i.taken === undefined ? {} : { exclude: i.taken() }),
      });
      i.save?.({ workspace, pid: null });
      core.begin(workspace);
    } catch (e) {
      i.log?.(`${i.name}: could not open a cmux workspace: ${e instanceof Error ? e.message : e}`);
      core.fail(e instanceof Error ? e.message : String(e));
    }
  })();
  return core.session;
}

/** Takes over a workspace an earlier hub started; `source` is how far it had read Claude's transcript. */
export function attachCmuxSession(
  i: CmuxSessionInput & {
    workspace: string;
    pid: number;
    source: { path: string; lines: number } | null;
  },
): CrewSession {
  const core = createCmuxDriver(i, {
    kind: "attach",
    workspace: i.workspace,
    pid: i.pid,
    source: i.source,
  });
  setImmediate(() => core.attach());
  return core.session;
}
