/**
 * The driver for one Claude run as a cmux workspace: an interactive `claude` the operator can see,
 * type into and clear. The hub starts the workspace (a launcher script, so the seat's own settings and
 * MCP config are kept), sends messages, and reads the seat's state from `cmux sessions` and its
 * results from Claude's own transcript, which is copied into the run's transcript as the keeper did.
 * It speaks the same `CrewSession` the keeper-backed drivers do.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isObj, type SessionEvent } from "@mc/core";
import { parseJson, rethrowJson } from "../json.ts";
import { CMUX_CLEAR_MARK } from "../run/streamjson.ts";
import { toolResultBytes } from "../telemetry/prompt-cost.ts";
import { sleep, str } from "../util.ts";
import type { Cmux, CmuxAgent } from "./cmux.ts";
import { pidAlive } from "./keeper.ts";
import { type CrewSession, SessionControlError } from "./session.ts";

/** The hub's record of a run's workspace: `{"workspace": uuid, "pid": n | null}`. */
export const CMUX_WORKSPACE_PREFIX = "cmux.workspace:";
export const cmuxWorkspaceKey = (runId: string) => `${CMUX_WORKSPACE_PREFIX}${runId}`;
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
/** One option of the trust menu, the cursor's marked: `❯ No, exit` (older Claude numbered them: `❯ 1. No, exit`). */
const MENU_OPTION = /^\s*([❯›>])?\s*(?:\d+\.\s+)?((?:Yes|No)\b.*?)\s*$/;
/** The line under the trust menu. */
const MENU_FOOTER = /Enter to confirm|Esc to cancel/;
/** What Claude prints when it quits at the trust prompt: the start has failed, and no key may follow. */
const TRUST_REFUSED = /folder isn't trusted/i;
export const CMUX_TRUST_QUIT = "Claude quit at its folder-trust prompt";
export const CMUX_QUIT_EARLY = "Claude quit before it started";
export const CMUX_TRUST_STUCK =
  "Claude waited at its folder-trust prompt and the hub could not answer it";
/** The file in the run's folder the launcher writes Claude's pid to. */
export const CMUX_PID_FILE = "claude.pid";
/** The launcher script, and FLIGHT's secret environment it sources and removes, in the run's folder. */
export const CMUX_LAUNCHER_FILE = "launch.zsh";
export const CMUX_ENV_FILE = "env";
/** How much of a new transcript is read to learn whose it is. */
const HEAD_BYTES = 64 * 1024;
/** Keys to the trust prompt go one a poll at most: each after a fresh read of the screen. */
const TRUST_KEY_GAP_MS = 500;
/** Claude's input prompt, up and taking text: its shortcuts hint, or a `❯` line that is no menu option. */
const CLAUDE_PROMPT = /\? for shortcuts|^\s*[│|]?\s*❯(?!\s*(?:\d+\.\s+)?(?:Yes|No)\b)/m;
/** What Claude shows while a turn runs (its spinner line), tools included. */
const CLAUDE_BUSY = /esc to interrupt/i;
/** With no cmux record, a turn the transcript says is open counts as running this long after its last line. */
const PENDING_QUIET_MS = 10_000;
/** How long a failed start waits for its Claude to stop after SIGTERM, then after SIGKILL. */
const STOP_WAIT_MS = 3000;

/**
 * Claude's own transcript for a session: `<config>/projects/<folder>/<id>.jsonl`. The folder name is
 * Claude's to choose, so every one is looked in; the session id is unique. Null until Claude writes it.
 */
export function claudeTranscript(configDir: string, sessionId: string): string | null {
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const path = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Whether two paths name one folder, links resolved. */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Claude's config folder for an environment: its CLAUDE_CONFIG_DIR, or `.claude` in its home. */
export const claudeConfigDir = (env: Record<string, string | undefined>) =>
  env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");

/** A dialog waits on an answer: numbered options under the last rule, with the footer to cancel it. */
export function dialogOpen(screen: string): boolean {
  if (isPermissionPrompt(screen)) return true;
  const rows = screen.split("\n");
  let from = 0;
  rows.forEach((r, n) => {
    if (RULE.test(r)) from = n + 1;
  });
  const block = rows.slice(from);
  return (
    block.filter((r) => /^\s*[❯›>]?\s*\d+\.\s+\S/.test(r)).length >= 2 &&
    block.some((r) => /Esc to cancel/i.test(r))
  );
}

/** What an open dialog asks: its question (the lines above its first option) and its numbered options. */
export interface CmuxDialog {
  question: string;
  options: string[];
}

/** How long a dialog stays open before FLIGHT is called about it: with the watch's debounce, inside a minute. */
export const CMUX_DIALOG_REPORT_MS = 20_000;
/** The most of a dialog's text a call to FLIGHT carries. */
const DIALOG_REASON_MAX = 1500;
/** The most of one option a call carries: every option keeps its number and a label. */
const DIALOG_OPTION_MAX = 160;
/** The least of one option a call keeps: its number and the start of its label ("20. Ke…"). */
const DIALOG_OPTION_MIN = 8;
/** The question keeps this much of the budget before the options share the rest. */
const DIALOG_QUESTION_MIN = 200;

const cut = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;

/**
 * A dialog's identity: a hash of its whole question and every whole option, as read from the screen.
 * FLIGHT's call carries it (the text it sees may be cut short) and `answer_dialog` names it, so an
 * answer goes only to the very dialog FLIGHT was told about.
 */
export function cmuxDialogId(d: CmuxDialog): string {
  return createHash("sha256")
    .update(JSON.stringify([d.question, d.options]))
    .digest("hex")
    .slice(0, 16);
}
/** What a `cmuxDialogId` looks like. */
export const CMUX_DIALOG_ID = /^[0-9a-f]{16}$/;

/**
 * The call to FLIGHT about a dialog nobody has answered: its id, what it asks and every option,
 * numbered. The budget is shared out first: each option gets an equal part (with its number always
 * kept), and the question has what is left, so a long question or many long options never drop an
 * option. The id comes first, so no cut ever drops it.
 */
export function cmuxDialogReason(d: CmuxDialog): string {
  const head = `A Claude dialog (id ${cmuxDialogId(d)}) is open in this seat's cmux workspace and nobody has answered it. It asks: "`;
  const n = Math.max(1, d.options.length);
  const fixed = head.length + `" Options: .`.length + " / ".length * (n - 1);
  const share = Math.floor(
    (DIALOG_REASON_MAX - fixed - Math.min(d.question.length, DIALOG_QUESTION_MIN)) / n,
  );
  const each = Math.min(DIALOG_OPTION_MAX, Math.max(DIALOG_OPTION_MIN, share));
  const options = d.options.map((o) => cut(o, each)).join(" / ");
  const room = Math.max(0, DIALOG_REASON_MAX - fixed - (options.length - " / ".length * (n - 1)));
  const text = `${head}${cut(d.question, room)}" Options: ${options}.`;
  // only a dialog of very many options could still run over: cut it at the end
  return cut(text, DIALOG_REASON_MAX);
}

export const CMUX_DIALOG_NOT_WAITING =
  "That seat is not waiting on a dialog in cmux: its run is not at needs-input.";
export const CMUX_DIALOG_GONE = "No dialog is open in that seat's cmux workspace.";
export const CMUX_DIALOG_NO_OPTION = "The open dialog has no such option.";
export const CMUX_DIALOG_CHANGED =
  "The open dialog is not the one you were told about: its question or options read differently now. Read the seat's call again.";
export const CMUX_DIALOG_PERMISSION =
  "That is Claude's tool permission dialog: the hub refuses it, and FLIGHT never grants one.";
export const CMUX_DIALOG_STUCK = "The dialog's cursor did not reach that option.";

/** The option the cursor is on in the open dialog (its index), or null when none shows a cursor. */
function dialogCursor(screen: string): number | null {
  const rows = screen.split("\n");
  let from = 0;
  rows.forEach((r, n) => {
    if (RULE.test(r)) from = n + 1;
  });
  const options = rows.slice(from).filter((r) => /^\s*[❯›>]?\s*\d+\.\s+\S/.test(r));
  const at = options.findIndex((r) => /^\s*[❯›>]/.test(r));
  return at < 0 ? null : at;
}

/**
 * FLIGHT's answer to a dialog the hub called it about: the cursor is moved to option `option` a key
 * at a time, each after a fresh read of the screen, and Enter goes only once the screen shows it
 * there. `dialog` is the id FLIGHT's call gave (`cmuxDialogId`); every read must still show that
 * dialog, its whole question and every whole option, so a dialog that changed is never answered. A
 * tool permission dialog is refused. The keys are forced: cmux will not type into a workspace while
 * a dialog is open. Returns the option picked, as the screen showed it; throws with the reason.
 */
export async function answerCmuxDialog(
  cmux: Pick<Cmux, "readScreen" | "sendKey">,
  workspace: string,
  answer: { option: number; dialog: string },
  o: { pollMs?: number } = {},
): Promise<string> {
  for (let step = 0; step < 32; step++) {
    const screen = await cmux.readScreen(workspace);
    const d = dialogOf(screen);
    if (d === null) throw new Error(CMUX_DIALOG_GONE);
    if (isPermissionPrompt(screen)) throw new Error(CMUX_DIALOG_PERMISSION);
    const at = d.options.findIndex((x) => new RegExp(`^${answer.option}\\.\\s`).test(x));
    if (at < 0 && step === 0 && cmuxDialogId(d) === answer.dialog)
      throw new Error(CMUX_DIALOG_NO_OPTION);
    if (at < 0 || cmuxDialogId(d) !== answer.dialog) throw new Error(CMUX_DIALOG_CHANGED);
    const cursor = dialogCursor(screen);
    if (cursor === null) throw new Error(CMUX_DIALOG_STUCK);
    if (cursor === at) {
      await cmux.sendKey(workspace, "enter", true);
      return d.options[at] as string;
    }
    await cmux.sendKey(workspace, cursor < at ? "down" : "up", true);
    await sleep(o.pollMs ?? TRUST_KEY_GAP_MS);
  }
  throw new Error(CMUX_DIALOG_STUCK);
}

/** The open dialog's question and options, read from the block under the last rule; null when none is open. */
export function dialogOf(screen: string): CmuxDialog | null {
  if (!dialogOpen(screen)) return null;
  const rows = screen.split("\n");
  let from = 0;
  rows.forEach((r, n) => {
    if (RULE.test(r)) from = n + 1;
  });
  const question: string[] = [];
  const options: string[] = [];
  for (const r of rows.slice(from)) {
    const option = /^\W*?(\d+\.\s+\S.*?)\s*$/.exec(r);
    if (option !== null && /^\s*[❯›>]?\s*\d+\./.test(r)) options.push(option[1] as string);
    else if (options.length === 0 && r.trim() !== "") question.push(r.trim());
    // a long option wraps: its next line belongs to it, until the footer
    else if (
      options.length > 0 &&
      r.trim() !== "" &&
      !MENU_FOOTER.test(r) &&
      !/^\s*Enter to/i.test(r)
    )
      options[options.length - 1] += ` ${r.trim()}`;
  }
  return { question: question.join(" "), options };
}

/**
 * The trust prompt's live menu: whether the cursor is on its "Yes" option, and which way "Yes" lies.
 * It is the menu only when it closes the screen: under the prompt's words, option lines next to
 * each other with one cursor, then nothing but blank lines and the footer. Words about trust in a
 * redrawn conversation, with a "Yes" or "No" line somewhere after them, are not it. Null otherwise.
 */
export function trustMenu(screen: string): { onYes: boolean; toYes: "up" | "down" } | null {
  const rows = screen.split("\n");
  let from = -1;
  rows.forEach((r, n) => {
    // the "Yes, I trust this folder" option has the prompt's words too: the menu follows the prompt
    if (TRUST_PROMPT.test(r) && !MENU_OPTION.test(r)) from = n;
  });
  if (from < 0) return null;
  const options: { n: number; text: string; cursor: boolean }[] = [];
  for (let n = from + 1; n < rows.length; n++) {
    const m = MENU_OPTION.exec(rows[n] as string);
    if (m !== null) options.push({ n, text: m[2] as string, cursor: m[1] !== undefined });
  }
  const first = options[0];
  const last = options.at(-1);
  if (first === undefined || last === undefined || options.length < 2) return null;
  // next to each other, and nothing after them but blank lines and the footer
  if (last.n - first.n !== options.length - 1) return null;
  if (rows.slice(last.n + 1).some((r) => r.trim() !== "" && !MENU_FOOTER.test(r))) return null;
  const at = options.findIndex((o) => o.cursor);
  const yes = options.findIndex((o) => /^Yes\b/.test(o.text));
  if (at < 0 || yes < 0 || options.filter((o) => o.cursor).length !== 1) return null;
  return { onYes: at === yes, toYes: yes < at ? "up" : "down" };
}

/**
 * Waits for a Claude just started in a cmux workspace to be up, answering its folder-trust prompt
 * on the way: the cursor opens on "No, exit", so it is moved to "Yes" a key a poll, each after a
 * fresh read, and Enter goes only once the screen shows it on "Yes". Up is Claude's input prompt or
 * its spinner with no trust menu showing. Throws `CMUX_TRUST_QUIT` when Claude quits at the prompt,
 * `CMUX_QUIT_EARLY` when its process is gone, and `CMUX_TRUST_STUCK` or `CMUX_START_FAILED` when
 * it is not up in `waitMs`. The seat driver keeps its own poll; an operator's session uses this.
 */
export async function answerTrustPrompt(
  cmux: Pick<Cmux, "readScreen" | "sendKey">,
  workspace: string,
  o: { alive?: () => boolean | null; waitMs?: number; pollMs?: number } = {},
): Promise<void> {
  const waitMs = o.waitMs ?? START_WAIT_MS;
  const pollMs = o.pollMs ?? TRUST_KEY_GAP_MS;
  const t0 = Date.now();
  let seen = false;
  let last = "";
  for (;;) {
    let screen = "";
    try {
      screen = await cmux.readScreen(workspace);
      last = screen;
    } catch {
      // not shown yet
    }
    if (TRUST_REFUSED.test(screen)) throw new Error(CMUX_TRUST_QUIT);
    if (o.alive?.() === false) throw new Error(seen ? CMUX_TRUST_QUIT : CMUX_QUIT_EARLY);
    const menu = trustMenu(screen);
    if (menu === null && (CLAUDE_PROMPT.test(screen) || CLAUDE_BUSY.test(screen))) return;
    if (menu !== null) {
      seen = true;
      await cmux.sendKey(workspace, menu.onYes ? "enter" : menu.toYes);
    }
    if (Date.now() - t0 >= waitMs)
      throw new Error(TRUST_PROMPT.test(last) ? CMUX_TRUST_STUCK : CMUX_START_FAILED);
    await sleep(pollMs);
  }
}
/** The title Claude gives a tool's permission dialog (2.1.331): one per kind of tool. */
const PERMISSION_TITLE =
  /^\W*(Bash command|Edit file|Overwrite file|Create file|Write file|Read file|Fetch|Tool use)\b/m;
/** The second option only Claude's tool dialog offers (2.1.332: "Yes, and switch to accept edits"). */
const PERMISSION_OPTION =
  /\d+\.\s+Yes, (and switch to accept edits|allow all edits|and don't ask again)\b/i;
/** A horizontal rule: Claude draws one above the dialog it has open. */
const RULE = /^\s*[─━]{20,}\s*$/;

/**
 * Claude's tool permission dialog, and only it. The hub refuses it, so no seat waits on a person.
 * Only the open dialog is read (the lines under the last rule on the screen), so a tool's name in
 * the conversation above cannot make a question of the seat's own look like one. In that block it
 * needs the question, a "Yes" and a "No" option, and one mark of a tool dialog: its title, the
 * "Tab to amend" footer (2.1.331, where the refusal is a bare "No"), a "Yes, and switch to accept
 * edits" kind of option, or the older refusal "No, and tell Claude what to do differently". A bare
 * Yes/No with no such mark stays the operator's.
 */
export function isPermissionPrompt(screen: string): boolean {
  const rows = screen.split("\n");
  let from = 0;
  rows.forEach((r, n) => {
    if (RULE.test(r)) from = n + 1;
  });
  const block = rows.slice(from).join("\n");
  // the terminal wraps a long path or command: the question and the refusal may cross lines
  const flat = block.replace(/\s+/g, " ");
  return (
    /Do you want to [^?]{1,2000}\?/i.test(flat) &&
    /^\W*\d+\.\s+Yes\b/m.test(block) &&
    /^\W*\d+\.\s+No\b/m.test(block) &&
    (PERMISSION_TITLE.test(block) ||
      /\bTab to amend\b/.test(block) ||
      PERMISSION_OPTION.test(flat) ||
      /\bNo, and tell Claude what to do differently\b/.test(flat))
  );
}
/** What the seat is told after the hub refuses a permission prompt, so it does not wait for a person. */
export const CMUX_TOOL_REFUSED_TEXT =
  "Mission Control refused that tool call: it is outside this seat's allowed tools. Carry on without it, or report that you are blocked.";
/** How long after a refusal cmux may still say needsInput before that is taken as the operator's. */
const REFUSED_SETTLE_MS = 6000;
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
    // a start the hub has given up on removes the file first: this launcher then runs no Claude
    lines.push(`. ${quote(i.envFile)} || exit 1`, `rm -f ${quote(i.envFile)}`);
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
  /** Claude's config folder, where it writes its own transcript; default from `env` (see claudeConfigDir). */
  claudeConfigDir?: string;
  /** The node that runs the hub's own tools: its folder goes first on PATH. */
  nodeDir?: string;
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
  /** The dialog the screen last showed open, for the `needs-input` event. */
  let dialog: CmuxDialog | null = null;
  /** The dialog last sent to the hub: cmux can hold `needsInput` while this changes or closes. */
  let reportedDialog: CmuxDialog | null = null;
  /** The screen this poll has read, if it read one: the refusal reads no second copy. */
  let polledScreen: string | null = null;
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
  /** The screen as last read while starting, for the reason a start that ran out of time gives. */
  let lastScreen = "";
  let readyYet = mode.kind === "attach";
  // an attach has its own record to wait for: the first poll says `attached`
  const queue: string[] = [];
  let pumping = false;
  const startedAt = Date.now();
  const configDir = i.claudeConfigDir ?? claudeConfigDir(i.env);
  /** Whether Claude's last top-level line leaves it a turn to finish (a prompt, a tool call or a result). */
  let turn: "pending" | "done" | null = null;
  /** The transcripts in Claude's project folder that are not this run's. */
  const notOurs = new Set<string>();
  let grewAt = 0;

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

  function end(info: {
    reason?: string;
    retake?: true;
    code?: number | null;
    startFailed?: true;
  }): void {
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
      ...(info.startFailed ? { startFailed: true as const } : {}),
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

  /**
   * Closes the workspace and forgets it. One cmux will not close stays saved, so the run's end or
   * restart closes it: a seat never leaves a bare shell behind under its name.
   */
  async function closeWorkspace(): Promise<void> {
    if (workspace !== "") {
      try {
        await i.cmux.close(workspace);
      } catch (e) {
        log(`${i.name}: close failed: ${e}`);
        return;
      }
    }
    i.save?.(null);
  }

  /** The Claude process is gone: its workspace is closed (if cmux still has it) and forgotten, then the exit. */
  async function gone(reason: string): Promise<void> {
    await closeWorkspace();
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

  /** Where Claude's turn stands by its own last top-level line. */
  function noteTurn(ev: unknown): void {
    if (!isObj(ev) || ev.isSidechain === true || ev.isMeta === true) return;
    const content = isObj(ev.message) ? ev.message.content : undefined;
    if (ev.type === "user") turn = "pending";
    else if (ev.type === "assistant")
      turn =
        Array.isArray(content) && content.some((c) => isObj(c) && c.type === "tool_use")
          ? "pending"
          : "done";
  }

  /**
   * The state with no cmux record: an open dialog waits on someone, Claude's spinner is a turn
   * running, and so is a fresh message or a turn the transcript left open moments ago.
   */
  async function guessLifecycle(): Promise<CmuxAgent["lifecycle"]> {
    let screen = "";
    try {
      screen = await i.cmux.readScreen(workspace);
      polledScreen = screen;
    } catch {
      // unread: the transcript decides
    }
    dialog = dialogOf(screen);
    if (dialog !== null) return "needsInput";
    if (CLAUDE_BUSY.test(screen)) return "running";
    const now = Date.now();
    if (turn === "pending" && now - grewAt < PENDING_QUIET_MS) return "running";
    if (sentAt !== null && now - sentAt < PENDING_QUIET_MS) return "running";
    return "idle";
  }

  /**
   * cmux's state checked against the screen: a turn (running or waiting) with a dialog open is
   * `needsInput`, and the dialog is kept for the event. An idle Claude has no dialog: not read.
   */
  async function screenLifecycle(said: CmuxAgent["lifecycle"]): Promise<CmuxAgent["lifecycle"]> {
    if (said === "idle") return said;
    let screen = "";
    try {
      screen = await i.cmux.readScreen(workspace);
    } catch {
      return said;
    }
    polledScreen = screen;
    dialog = dialogOf(screen);
    return dialog === null ? said : "needsInput";
  }

  /**
   * A transcript Claude began after /clear, found with no cmux record: in the same project folder as
   * the session being read (Claude's folder for this worktree), begun after this start, and whose own
   * lines name this worktree as their folder and the file's name as their session. Files that are not
   * it are not read again; files from before the start are ruled out by their creation time alone.
   * Null when there is none yet.
   */
  function clearedTo(current: string): { id: string; path: string } | null {
    const dir = dirname(current);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return null;
    }
    for (const n of names) {
      if (n === `${sessionId}.jsonl` || notOurs.has(n)) continue;
      const path = join(dir, n);
      const id = n.slice(0, -".jsonl".length);
      const whose = transcriptOwner(path, id);
      if (whose === "ours") {
        notOurs.add(`${sessionId}.jsonl`);
        return { id, path };
      }
      if (whose === "other") notOurs.add(n);
    }
    return null;
  }

  /** Whether a transcript is this run's Claude's: begun since the start, in this worktree, under its own name. */
  function transcriptOwner(path: string, id: string): "ours" | "other" | "unknown" {
    try {
      const st = statSync(path);
      if ((st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) < startedAt) return "other";
      const fd = openSync(path, "r");
      let head = "";
      try {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
        head = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
      } finally {
        closeSync(fd);
      }
      for (const line of head.split("\n")) {
        if (!line.startsWith("{")) continue;
        let ev: unknown;
        try {
          ev = parseJson<unknown>(line, undefined, rethrowJson);
        } catch {
          continue;
        }
        if (!isObj(ev) || typeof ev.cwd !== "string") continue;
        // Claude's transcripts say `sessionId`; its stream-json output says `session_id`
        const own = ev.sessionId ?? ev.session_id;
        return samePath(ev.cwd, i.cwd) && own === id ? "ours" : "other";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Whether cmux still has the workspace open; true when it cannot say. */
  async function workspaceOpen(): Promise<boolean> {
    try {
      return (await i.cmux.workspaces()).some((w) => w.id === workspace);
    } catch {
      return true;
    }
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
    noteTurn(ev);
    if (skip > 0) {
      skip--;
      lines++;
      return;
    }
    appendTranscript(line);
    lines++;
    grew = true;
    grewAt = Date.now();
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

  /**
   * An operator's /clear: the same Claude on a new session. Its context is unknown until its first
   * reply, here and in the run's digest, so a cleared FLIGHT is not handed over on the old reading.
   */
  function cleared(id: string): void {
    sessionId = id;
    contextTokens = null;
    appendTranscript(
      JSON.stringify({ type: "system", subtype: "init", session_id: id, [CMUX_CLEAR_MARK]: true }),
    );
    lines++;
    emit({ kind: "init", sessionId, model: null });
  }

  const sameDialog = (a: CmuxDialog | null, b: CmuxDialog | null) =>
    a === b ||
    (a !== null &&
      b !== null &&
      a.question === b.question &&
      a.options.length === b.options.length &&
      a.options.every((option, index) => option === b.options[index]));

  function change(next: CmuxAgent["lifecycle"]): void {
    const prev = lifecycle;
    lifecycle = next;
    if (prev === next) {
      // cmux's lifecycle is stale while a dialog closes or is replaced: report the screen change
      // so the supervisor can cancel or restart its delayed call to FLIGHT.
      if (next === "needsInput" && !sameDialog(dialog, reportedDialog)) {
        reportedDialog = dialog;
        emit(dialog === null ? { kind: "needs-input" } : { kind: "needs-input", dialog });
      }
      return;
    }
    if (next === "running") {
      reportedDialog = null;
      emit({ kind: "turn-start" });
      sentAt = null;
      quiet = 0;
    } else if (next === "needsInput") {
      reportedDialog = dialog;
      emit(dialog === null ? { kind: "needs-input" } : { kind: "needs-input", dialog });
    } else if (prev === "running" || prev === "needsInput") {
      reportedDialog = null;
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
          cleared(fresh.sessionId);
        } else seen = here.at(-1);
      }
      if (seen !== undefined && seen.pid !== null && pid !== null && seen.pid !== pid) {
        // cmux restored the agent without the hub's settings: closed, and resumed with the hub's command
        log(`${i.name}: cmux restored Claude under a new process; closing it`);
        await closeWorkspace();
        return end({ retake: true, reason: "cmux restored the agent without the hub's settings" });
      }
      if (pid !== null && !pidAlive(pid)) return await gone(CMUX_ENDED);
      // cmux keeps no record of some sessions: Claude's pid and its open workspace stand for it
      if (seen === undefined && (pid === null || !(await workspaceOpen())))
        return await gone(CMUX_ENDED);
      if (finished || detached) return;
      grew = false;
      let path = seen?.transcriptPath ?? claudeTranscript(configDir, sessionId);
      if (path !== null) copyTranscript(path);
      if (seen === undefined && path !== null) {
        // /clear with no record: the same process starts a new transcript beside the old one
        const next = clearedTo(path);
        if (next !== null) {
          cleared(next.id);
          path = next.path;
          copyTranscript(path);
        }
      }
      persist();
      if (grew) growth++;
      polledScreen = null;
      let now = seen?.lifecycle ?? (await guessLifecycle());
      // cmux's record can stay `running` under an open dialog (#2304): the screen is read too
      if (seen !== undefined) now = await screenLifecycle(now);
      if (finished || detached) return;
      if (!attachedSaid) {
        attachedSaid = true;
        lifecycle = now;
        emit({ kind: "attached", awaiting: now !== "idle" });
        return;
      }
      // A permission prompt waits on no one: the hub refuses it, as print mode refused the tool.
      // Every poll that finds it waiting looks again: a dialog not recognised at first is not left.
      if (now === "needsInput" && (await refusedPrompt())) return;
      // Real cmux stays on needsInput for a moment after the hub's Escape, until the seat takes the
      // hub's word about the refusal: that wait is the hub's own, not one for the operator.
      if (
        now === "needsInput" &&
        (queue.includes(CMUX_TOOL_REFUSED_TEXT) || Date.now() - deniedAt < REFUSED_SETTLE_MS)
      )
        return;
      change(now);
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
    // the screen this poll read already, else a fresh read
    let screen = polledScreen ?? "";
    if (polledScreen === null) {
      try {
        screen = await i.cmux.readScreen(workspace);
      } catch {
        return false;
      }
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
      // a trust prompt the hub could not read is named, with what it showed, not passed off as no start
      const stuck = TRUST_PROMPT.test(lastScreen);
      const reason = stuck ? CMUX_TRUST_STUCK : CMUX_START_FAILED;
      log(
        `${i.name}: ${reason}${stuck ? `: ${lastScreen.trim().split("\n").slice(-6).join(" | ")}` : ""}`,
      );
      return await failStart(reason);
    }
    // Claude has quit before its record: no key goes to the shell left behind
    const launched = launcherPid();
    let screen = "";
    try {
      screen = await i.cmux.readScreen(workspace);
      lastScreen = screen;
    } catch {
      // not shown yet
    }
    if ((launched !== null && !pidAlive(launched)) || TRUST_REFUSED.test(screen)) {
      const reason = trustSeen || TRUST_REFUSED.test(screen) ? CMUX_TRUST_QUIT : CMUX_QUIT_EARLY;
      log(`${i.name}: ${reason}`);
      return await failStart(reason);
    }
    if (launched === null) return;
    const menu = trustMenu(screen);
    // No record yet, and maybe none to come: Claude at its prompt, or writing its transcript, is up.
    if (menu === null && (CLAUDE_PROMPT.test(screen) || transcriptStarted())) {
      pid = launched;
      readyYet = true;
      log(`${i.name}: Claude is up (pid ${launched}); cmux has no record of it yet`);
      i.save?.({ workspace, pid });
      resolveReady();
      void pump();
      return;
    }
    if (menu === null || Date.now() - trustAt < TRUST_KEY_GAP_MS) return;
    trustSeen = true;
    trustAt = Date.now();
    // the cursor opens on "No, exit": it is moved, and Enter waits for a screen that shows it on "Yes"
    const key = menu.onYes ? "enter" : menu.toYes;
    await i.cmux.sendKey(workspace, key).catch((e) => log(`${i.name}: trust key: ${e}`));
  }

  /** Claude has written its transcript since this start: an earlier session's file (a resume's) does not count. */
  function transcriptStarted(): boolean {
    const path = claudeTranscript(configDir, sessionId);
    if (path === null) return false;
    try {
      return statSync(path).mtimeMs >= startedAt;
    } catch {
      return false;
    }
  }

  /**
   * A start that failed: the workspace is closed and the Claude the launcher ran is stopped, so a
   * keeper may take the run with no second Claude on it. Marked `startFailed` only once that Claude
   * is known gone; one that will not stop ends the run instead.
   */
  async function failStart(reason: string): Promise<void> {
    if (workspace !== "") {
      await i.cmux.close(workspace).catch((e) => log(`${i.name}: close failed: ${e}`));
    }
    const stopped = await stopLaunched();
    removeLaunchFiles();
    if (finished) return;
    i.save?.(null);
    if (stopped) return end({ reason, startFailed: true });
    log(`${i.name}: the Claude cmux started would not stop`);
    end({ reason: `${reason}; the Claude it started would not stop` });
  }

  /**
   * The launcher and FLIGHT's secret file go once the start is over without a Claude: a launcher cmux
   * runs late finds neither, so it starts nothing, and no secret stays on disk.
   */
  function removeLaunchFiles(): void {
    for (const f of [CMUX_ENV_FILE, CMUX_LAUNCHER_FILE]) rmSync(join(i.dir, f), { force: true });
  }

  /** Stops the launcher's Claude if it runs: SIGTERM, then SIGKILL. True once none runs. */
  async function stopLaunched(): Promise<boolean> {
    const p = launcherPid();
    if (p === null || !pidAlive(p)) return true;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(p, signal);
      } catch {
        // gone already, or not ours
      }
      for (const t0 = Date.now(); Date.now() - t0 < STOP_WAIT_MS; await sleep(50)) {
        if (!pidAlive(p)) return true;
      }
    }
    return !pidAlive(p);
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
        await closeWorkspace();
        // closed before Claude was up: its launcher may be mid-start, so it is stopped, then its files go
        if (!readyYet) {
          await stopLaunched();
          removeLaunchFiles();
        }
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
      // the workspace may be open though cmux did not say which: its Claude is stopped by its pid
      void failStart(reason);
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
      const script = join(i.dir, CMUX_LAUNCHER_FILE);
      let envFile: string | null = null;
      if (i.privateEnv !== undefined && Object.keys(i.privateEnv).length > 0) {
        envFile = join(i.dir, CMUX_ENV_FILE);
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

/**
 * A cmux session that hands its run to a keeper when its start fails (`exit` with `startFailed`):
 * cmux refused, was down, showed no Claude in time, or its Claude quit first. The run carries on
 * instead of ending. Messages sent before cmux's Claude was up never reached it, so the keeper gets
 * them in order. The failed start's own exit is not passed on; every later event is the keeper's.
 * `fallback` throwing ends the run with the start's reason.
 */
export function withKeeperFallback(
  first: CrewSession,
  fallback: (reason: string) => CrewSession,
): CrewSession {
  const listeners = new Set<(e: SessionEvent) => void>();
  let current = first;
  let up = false;
  let closing = false;
  const early: string[] = [];
  const emit = (e: SessionEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // one broken listener must not stop the others
      }
    }
  };
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  void first.ready.then(() => {
    if (current !== first) return;
    up = first.alive;
    resolveReady();
  });
  first.on((e) => {
    if (current !== first) return;
    if (e.kind === "exit" && e.startFailed && !up && !closing) {
      let next: CrewSession;
      try {
        next = fallback(e.reason ?? CMUX_START_FAILED);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const { startFailed: _, ...rest } = e;
        resolveReady();
        emit({
          ...rest,
          reason: `${e.reason ?? CMUX_START_FAILED}; the keeper did not start: ${why}`,
        });
        return;
      }
      current = next;
      next.on(emit);
      for (const text of early.splice(0)) {
        try {
          next.send(text);
        } catch {
          // the keeper ended already: its exit says so
        }
      }
      void next.ready.then(resolveReady);
      return;
    }
    emit(e);
  });
  return {
    send(text) {
      current.send(text);
      if (current === first && !up) early.push(text);
    },
    control: (subtype, opts) => current.control(subtype, opts),
    close() {
      closing = true;
      return current.close();
    },
    detach() {
      listeners.clear();
      current.detach();
      resolveReady();
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pid() {
      return current.pid;
    },
    get alive() {
      return current.alive;
    },
    ready,
    get lines() {
      return current.lines;
    },
    get closeSent() {
      return current.closeSent;
    },
  };
}
