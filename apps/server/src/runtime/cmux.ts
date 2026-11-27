/**
 * The `cmux` command-line wrapper. Every Claude seat's run is a cmux workspace the operator can see,
 * type into and clear; the hub starts it, sends it messages, reads its state from `cmux sessions` and
 * its results from Claude's own transcript. The Sessions page reads every workspace on this Mac,
 * the operator's own included, through it too. The cmux JSON is read defensively (names in either
 * case): it is the one place that knows its shape.
 */
import { execFile, spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { isObj } from "@mc/core";
import { parseJson, rethrowJson } from "../json.ts";
import { sleep } from "../util.ts";

export const CMUX_COMMAND = "cmux";

export const CMUX_REFUSED_TEXT =
  'cmux refuses Mission Control: set "automation": { "socketControlMode": "automation" } in ~/.config/cmux/cmux.json';
export const CMUX_DOWN_TEXT = "cmux is not running and could not be started";

/** How long `ensure` retries after it has asked macOS to start cmux. */
const START_WAIT_MS = 10_000;
const START_RETRY_MS = 500;
/** One `cmux` call may take this long. */
const CALL_TIMEOUT_MS = 20_000;
/** `agents()` shares one call for this long. */
const AGENTS_CACHE_MS = 1000;
/** The pause between a pasted message and its Enter key. */
const PASTE_SETTLE_MS = 150;
/** How long `newWorkspace` looks for the workspace it made, and how often. */
const FIND_WAIT_MS = 5000;
const FIND_RETRY_MS = 500;
/** How long `close` waits for cmux to stop listing a workspace it closed, and how often it looks. */
const CLOSE_WAIT_MS = 15_000;
const CLOSE_RETRY_MS = 250;

export interface CmuxAgent {
  sessionId: string;
  lifecycle: "idle" | "running" | "needsInput";
  pid: number | null;
  workspaceId: string;
  transcriptPath: string | null;
  /** The folder the agent runs in, when cmux records one. */
  cwd: string | null;
}

export interface CmuxWorkspace {
  id: string;
  name: string;
  cwd: string | null;
}

/** One `cmux agent inbox` message, for the workspace it was sent to. */
export interface CmuxInboxMessage {
  workspaceId: string;
  text: string;
  read: boolean;
}

export interface CmuxWorkspaceInput {
  name: string;
  cwd: string;
  command: string;
}

export type CmuxEvent = { kind: "created" | "closed"; workspaceId: string | null };

/** A cmux events JSON line, limited to workspace lifecycle changes. */
export function parseCmuxEvent(line: string): CmuxEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(value)) return null;
  const name = pick(value, "name", "event", "type");
  const kind =
    name === "workspace.created" ? "created" : name === "workspace.closed" ? "closed" : null;
  if (kind === null) return null;
  const id = pick(value, "workspace_id", "workspaceId");
  return { kind, workspaceId: typeof id === "string" ? id : null };
}

export interface Cmux {
  /** Throws a CmuxError when cmux refuses the hub or cannot be started. */
  ensure(): Promise<void>;
  /** Whether cmux answers, without starting it. */
  ping(): Promise<"up" | "denied" | "down">;
  /** Every workspace cmux has open, with its folder when cmux names one. */
  workspaces(): Promise<CmuxWorkspace[]>;
  /** Brings the workspace to the front: selects it, then brings cmux forward. */
  focus(ws: string): Promise<void>;
  /** The workspace's sidebar status entries (`list-status`), key to text. */
  statuses(ws: string): Promise<Record<string, string>>;
  /** Every message `cmux agent inbox` holds, newest first. */
  inbox(): Promise<CmuxInboxMessage[]>;
  /** `cmux agent message`: delivered through the agent's hooks, never typed into the terminal. */
  agentMessage(ws: string, text: string, from: string): Promise<void>;
  /** Opens `url` in a browser pane of the workspace. */
  openBrowser(ws: string, url: string): Promise<void>;
  newWorkspace(i: CmuxWorkspaceInput): Promise<string>;
  /** Opens another terminal pane in a workspace. */
  /** Opens a terminal pane and returns its surface identifier. */
  newPane(ws: string, cwd: string, command: string): Promise<string>;
  /** Closes one terminal pane. A pane already gone is not an error. */
  closePane(pane: string): Promise<void>;
  /** The Claude records cmux holds (`cmux sessions`), from one shared call per second. */
  agents(): Promise<CmuxAgent[]>;
  /** "busy": a dialog is open or a draft is typed; nothing was sent. */
  send(ws: string, text: string): Promise<"sent" | "busy">;
  sendKey(ws: string, key: string, force?: boolean): Promise<void>;
  /** The screen's text; with `lines`, at most that many of its last lines. */
  readScreen(ws: string, lines?: number): Promise<string>;
  /** Closes the workspace, forced. A workspace already gone is not an error. */
  close(ws: string): Promise<void>;
  setStatus(ws: string, key: string, value: string): Promise<void>;
  clearStatus(ws: string, key: string): Promise<void>;
  linkPr(ws: string, url: string): Promise<void>;
  clearPr(ws: string): Promise<void>;
  notify(ws: string, title: string, body: string): Promise<void>;
  events(
    cursorFile: string,
    onLine: (line: string) => void,
  ): { stop(): void; ended: Promise<void> };
}

/** A start the hub refuses to make: cmux says no, or is not there. */
export class CmuxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CmuxError";
  }
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeout = CALL_TIMEOUT_MS): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const lifecycleOf = (v: unknown): CmuxAgent["lifecycle"] | null => {
  if (typeof v !== "string") return null;
  switch (v.replace(/[-_\s]/g, "").toLowerCase()) {
    case "idle":
      return "idle";
    case "running":
      return "running";
    case "needsinput":
      return "needsInput";
    default:
      return null;
  }
};

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** The rows of a cmux JSON answer: the array itself or the one inside its `key`. */
function rowsOf(text: string, key: string): Record<string, unknown>[] {
  let v: unknown;
  try {
    v = parseJson<unknown>(text, undefined, rethrowJson);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v[key]) ? v[key] : [];
  return list.filter(isObj);
}

export function parseAgents(text: string): CmuxAgent[] {
  const out: CmuxAgent[] = [];
  for (const o of rowsOf(text, "sessions")) {
    const sessionId = pick(o, "sessionId", "session_id", "id");
    const lifecycle = lifecycleOf(
      pick(
        o,
        "agent_lifecycle",
        "agentLifecycle",
        "lifecycle",
        // `runtime_status` is another thing (a record can be needsInput with it idle): never read here
      ),
    );
    const workspaceId = pick(o, "workspaceId", "workspace_id", "workspace");
    if (typeof sessionId !== "string" || lifecycle === null || typeof workspaceId !== "string")
      continue;
    const pid = pick(o, "pid");
    const transcript = pick(o, "transcriptPath", "transcript_path");
    const cwd = pick(o, "cwd", "launch_cwd", "launchCwd", "working_directory", "workingDirectory");
    out.push({
      sessionId,
      lifecycle,
      workspaceId,
      pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
      transcriptPath: typeof transcript === "string" && transcript !== "" ? transcript : null,
      cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
    });
  }
  return out;
}

export function parseWorkspaces(text: string): CmuxWorkspace[] {
  const out: CmuxWorkspace[] = [];
  for (const o of rowsOf(text, "workspaces")) {
    const id = pick(o, "id", "uuid", "workspaceId", "workspace_id");
    const name = pick(o, "title", "name", "customTitle", "custom_title");
    const cwd = pick(
      o,
      "cwd",
      "current_directory",
      "currentDirectory",
      "directory",
      "working_directory",
      "workingDirectory",
    );
    if (typeof id === "string" && typeof name === "string")
      out.push({ id, name, cwd: typeof cwd === "string" && cwd !== "" ? cwd : null });
  }
  return out;
}

/**
 * The workspace `new-workspace` says it made: `OK workspace:<n>` (or `OK <uuid>`) on stdout, after any
 * notice cmux prints first. Null when it names none.
 */
export function madeWorkspace(stdout: string): string | null {
  const said = [...stdout.matchAll(/^OK\s+(workspace:\d+|[0-9a-f]{8}-[0-9a-f-]{27})\s*$/gim)];
  return said.at(-1)?.[1] ?? null;
}

/** The id of the workspace with handle `ref` in a `--id-format both` listing. */
export function workspaceIdOf(text: string, ref: string): string | null {
  for (const o of rowsOf(text, "workspaces")) {
    if (pick(o, "ref", "handle", "workspace_ref", "workspaceRef") !== ref) continue;
    const id = pick(o, "id", "uuid", "workspace_id", "workspaceId");
    if (typeof id === "string" && id !== ref) return id;
  }
  return null;
}

/** The ids of the windows `list-windows` names. */
export function parseWindows(text: string): string[] {
  const out: string[] = [];
  for (const o of rowsOf(text, "windows")) {
    const id = pick(o, "id", "uuid", "window_id", "windowId");
    if (typeof id === "string" && id !== "") out.push(id);
  }
  return out;
}

/**
 * `list-status` output, read either way cmux may print it: JSON (a list of `{key, value}` or an
 * object keyed by key, bare or under `statuses`/`entries`), or one `key=value` / `key: value` /
 * `key<TAB>value` entry a line.
 */
export function parseStatuses(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = text.trim();
  if (trimmed === "" || /^no (status|entries)/i.test(trimmed)) return out;
  let json: unknown;
  try {
    json = parseJson<unknown>(trimmed, undefined, rethrowJson);
  } catch {
    json = undefined;
  }
  if (json !== undefined) {
    const inner = isObj(json) ? (pick(json, "statuses", "entries", "status") ?? json) : json;
    if (Array.isArray(inner)) {
      for (const e of inner.filter(isObj)) {
        const k = pick(e, "key", "name");
        const v = pick(e, "value", "text", "label");
        if (typeof k === "string" && (typeof v === "string" || typeof v === "number"))
          out[k] = String(v);
      }
    } else if (isObj(inner)) {
      for (const [k, v] of Object.entries(inner)) {
        if (typeof v === "string" || typeof v === "number") out[k] = String(v);
        else if (isObj(v)) {
          const val = pick(v, "value", "text", "label");
          if (typeof val === "string") out[k] = val;
        }
      }
    }
    return out;
  }
  for (const line of trimmed.split("\n")) {
    const m = /^\s*([\w.-]+)\s*(?:=|:|\t)\s*(.*?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[2] !== "") out[m[1]] = m[2];
  }
  return out;
}

/** `cmux agent inbox --json`: the messages whose workspace it names; others are left out. */
export function parseInbox(text: string): CmuxInboxMessage[] {
  const out: CmuxInboxMessage[] = [];
  for (const o of rowsOf(text, "messages")) {
    const target = isObj(o.to) ? o.to : isObj(o.target) ? o.target : o;
    const ws = pick(
      target,
      // real cmux (0.65.2) names it the recipient
      "recipient_workspace_id",
      "recipientWorkspaceId",
      "workspaceId",
      "workspace_id",
      "to_workspace_id",
      "target_workspace_id",
      "workspace",
    );
    const body = pick(o, "text", "body", "message", "content");
    if (typeof ws !== "string" || typeof body !== "string") continue;
    const state = pick(o, "state", "status");
    const readAt = pick(o, "read_at", "readAt");
    out.push({
      workspaceId: ws,
      text: body,
      read: state === "read" || (state === undefined && readAt !== undefined),
    });
  }
  return out;
}

export interface CmuxOptions {
  /** The command that asks macOS to start cmux (tests give a stand-in). */
  open?: readonly string[];
  /** How long `ensure` waits after it has asked (default 10 s). */
  startWaitMs?: number;
  /** How long `newWorkspace` looks for the id of the workspace it made (default 5 s). */
  findWaitMs?: number;
  /** How long `close` waits for cmux to stop listing the workspace (default 15 s). */
  closeWaitMs?: number;
  /** The command that brings cmux to the front after `focus` (tests give a stand-in). */
  activate?: readonly string[];
}

/**
 * What starts cmux from the hub (in the background), or brings it to the front: its own small
 * environment, so the app does not inherit the hub's.
 */
function openCommand(front = false): string[] {
  const env = [
    `HOME=${homedir()}`,
    `USER=${userInfo().username}`,
    `LOGNAME=${userInfo().username}`,
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    `TMPDIR=${process.env.TMPDIR ?? "/tmp"}`,
    `SHELL=${process.env.SHELL ?? "/bin/zsh"}`,
    `LANG=${process.env.LANG ?? "en_US.UTF-8"}`,
  ];
  return ["/usr/bin/env", "-i", ...env, "/usr/bin/open", ...(front ? [] : ["-g"]), "-a", "cmux"];
}

export function createCmux(
  command: readonly string[],
  log: (m: string) => void = () => {},
  options: CmuxOptions = {},
): Cmux {
  const [file, ...base] = command;
  if (file === undefined) throw new Error("cmux command is empty");
  const cmux = (args: string[]) => run(file, [...base, ...args]);
  const failed = (what: string, r: Ran) =>
    new CmuxError(`cmux ${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let agentsAt = 0;
  let agentsCall: Promise<CmuxAgent[]> | null = null;

  const inWindow = async (format: "uuids" | "both", window?: string) => {
    const r = await cmux([
      "--json",
      "--id-format",
      format,
      "list-workspaces",
      ...(window === undefined ? [] : ["--window", window]),
    ]);
    if (r.code !== 0) throw failed("list-workspaces", r);
    return r.stdout;
  };
  /** `list-workspaces` names one window's workspaces only, so every window is listed in turn. */
  async function listings(format: "uuids" | "both"): Promise<string[]> {
    const w = await cmux(["--json", "--id-format", "uuids", "list-windows"]);
    const windows = w.code === 0 ? parseWindows(w.stdout) : [];
    // a cmux with no list-windows, or no window named: the current window is all there is to read
    if (windows.length === 0) return [await inWindow(format)];
    return Promise.all(windows.map((id) => inWindow(format, id)));
  }
  async function workspaces() {
    const seen = new Set<string>();
    return (await listings("uuids")).flatMap(parseWorkspaces).filter((ws) => {
      if (seen.has(ws.id)) return false;
      seen.add(ws.id);
      return true;
    });
  }
  const ping = async (): Promise<"up" | "denied" | "down"> => {
    const r = await cmux(["ping"]);
    if (r.code === 0) return "up";
    return /access denied/i.test(`${r.stderr}\n${r.stdout}`) ? "denied" : "down";
  };

  return {
    ping,
    workspaces,
    async focus(ws) {
      const r = await cmux(["select-workspace", "--workspace", ws]);
      if (r.code !== 0) throw failed("select-workspace", r);
      const [activateFile, ...activateArgs] = options.activate ?? openCommand(true);
      const shown = await run(activateFile as string, activateArgs);
      if (shown.code !== 0) throw failed("bring to front", shown);
    },
    async statuses(ws) {
      const r = await cmux(["list-status", "--workspace", ws]);
      if (r.code !== 0) throw failed("list-status", r);
      return parseStatuses(r.stdout);
    },
    async inbox() {
      const r = await cmux(["agent", "inbox", "--json", "--limit", "200"]);
      if (r.code !== 0) throw failed("agent inbox", r);
      return parseInbox(r.stdout);
    },
    async agentMessage(ws, text, from) {
      const r = await cmux(["agent", "message", ws, "--from", from, "--", text]);
      if (r.code !== 0) throw failed("agent message", r);
    },
    async openBrowser(ws, url) {
      const r = await cmux([
        "new-pane",
        "--type",
        "browser",
        "--workspace",
        ws,
        "--url",
        url,
        "--focus",
        "true",
      ]);
      if (r.code !== 0) throw failed("new-pane", r);
    },
    async ensure() {
      let state = await ping();
      if (state === "down") {
        log("cmux is not running: asking macOS to start it");
        const [openFile, ...openArgs] = options.open ?? openCommand();
        await run(openFile as string, openArgs);
        const wait = options.startWaitMs ?? START_WAIT_MS;
        for (const t0 = Date.now(); state === "down" && Date.now() - t0 < wait; ) {
          await sleep(START_RETRY_MS);
          state = await ping();
        }
      }
      if (state === "denied") throw new CmuxError(CMUX_REFUSED_TEXT);
      if (state === "down") throw new CmuxError(CMUX_DOWN_TEXT);
    },
    async newWorkspace(i) {
      const r = await cmux([
        "new-workspace",
        "--name",
        i.name,
        "--cwd",
        i.cwd,
        "--command",
        i.command,
        "--focus",
        "false",
      ]);
      if (r.code !== 0) {
        if (/access denied/i.test(`${r.stderr}\n${r.stdout}`))
          throw new CmuxError(CMUX_REFUSED_TEXT);
        throw failed("new-workspace", r);
      }
      // never found by name: an old workspace of the same name may still be open (or closing)
      const made = madeWorkspace(r.stdout);
      if (made === null)
        throw new CmuxError(
          `cmux new-workspace named no workspace: ${r.stdout.trim().slice(0, 300)}`,
        );
      if (!made.startsWith("workspace:")) return made;
      const wait = options.findWaitMs ?? FIND_WAIT_MS;
      for (const t0 = Date.now(); ; ) {
        for (const text of await listings("both")) {
          const id = workspaceIdOf(text, made);
          if (id !== null) return id;
        }
        if (Date.now() - t0 >= wait) throw new CmuxError(`cmux lists no workspace ${made}`);
        await sleep(FIND_RETRY_MS);
      }
    },
    async newPane(ws, cwd, command) {
      const r = await cmux([
        "new-pane",
        "--type",
        "terminal",
        "--workspace",
        ws,
        "--cwd",
        cwd,
        "--command",
        command,
      ]);
      if (r.code !== 0) throw failed("new-pane", r);
      return r.stdout.trim() || ws;
    },
    async closePane(pane) {
      const r = await cmux(["close-pane", "--pane", pane]);
      if (r.code !== 0 && !/not found|no such/i.test(`${r.stdout}\n${r.stderr}`))
        throw failed("close-pane", r);
    },
    agents() {
      if (agentsCall !== null && Date.now() - agentsAt < AGENTS_CACHE_MS) return agentsCall;
      agentsAt = Date.now();
      const call = (async () => {
        const r = await cmux(["sessions", "--agent", "claude", "--json", "--limit", "1000"]);
        if (r.code !== 0) throw failed("sessions", r);
        return parseAgents(r.stdout);
      })();
      agentsCall = call;
      // a failed call is not kept: the next ask makes its own
      call.catch(() => {
        if (agentsCall === call) agentsCall = null;
      });
      return call;
    },
    async send(ws, text) {
      const pasted = await cmux(["send", "--paste", "--workspace", ws, "--", text]);
      if (pasted.code !== 0) {
        const said = `${pasted.stderr}\n${pasted.stdout}`;
        if (/dialog|draft|typing|question|permission|prompt|busy/i.test(said)) return "busy";
        throw failed("send", pasted);
      }
      await sleep(PASTE_SETTLE_MS);
      await this.sendKey(ws, "enter");
      return "sent";
    },
    async sendKey(ws, key, force = false) {
      const r = await cmux([
        "send-key",
        "--workspace",
        ws,
        ...(force ? ["--force"] : []),
        "--",
        key,
      ]);
      if (r.code !== 0) throw failed("send-key", r);
    },
    async readScreen(ws, lines) {
      const r = await cmux([
        "read-screen",
        "--workspace",
        ws,
        ...(lines === undefined ? [] : ["--lines", String(lines)]),
      ]);
      if (r.code !== 0) throw failed("read-screen", r);
      return r.stdout;
    },
    async close(ws) {
      const forced = await cmux(["close-workspace", "--workspace", ws, "--force"]);
      if (forced.code !== 0) {
        // an older cmux has no --force; a workspace already gone is as good as closed
        const plain = await cmux(["close-workspace", "--workspace", ws]);
        if (plain.code !== 0) {
          if (!(await workspaces().catch(() => [{ id: ws, name: "" }])).some((w) => w.id === ws))
            return;
          throw failed("close-workspace", plain);
        }
      }
      // cmux answers OK and may list the workspace a few seconds more: it is closed once it is gone
      const wait = options.closeWaitMs ?? CLOSE_WAIT_MS;
      for (const t0 = Date.now(); ; ) {
        let listed: boolean;
        try {
          listed = (await workspaces()).some((w) => w.id === ws);
        } catch (e) {
          throw new CmuxError(
            `cmux closed workspace ${ws} but would not list its workspaces: ${e}`,
          );
        }
        if (!listed) return;
        if (Date.now() - t0 >= wait)
          throw new CmuxError(`cmux still lists workspace ${ws} after closing it`);
        await sleep(CLOSE_RETRY_MS);
      }
    },
    async setStatus(ws, key, value) {
      const r = await cmux(["set-status", key, value, "--workspace", ws]);
      if (r.code !== 0) throw failed("set-status", r);
    },
    async clearStatus(ws, key) {
      const r = await cmux(["clear-status", key, "--workspace", ws]);
      if (r.code !== 0) throw failed("clear-status", r);
    },
    async linkPr(ws, url) {
      const r = await cmux(["pr", url, "--workspace", ws]);
      if (r.code !== 0) throw failed("pr", r);
    },
    async clearPr(ws) {
      const r = await cmux(["pr", "clear", "--workspace", ws]);
      if (r.code !== 0) throw failed("pr clear", r);
    },
    async notify(ws, title, body) {
      const r = await cmux(["notify", "--title", title, "--body", body, "--workspace", ws]);
      if (r.code !== 0) throw failed("notify", r);
    },
    events(cursorFile, onLine) {
      const child = spawn(file, [...base, "events", "--reconnect", "--cursor-file", cursorFile], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let remaining = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        remaining += chunk.toString();
        const lines = remaining.split("\n");
        remaining = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      });
      const ended = new Promise<void>((resolve) => {
        child.once("close", resolve);
        child.once("error", (error) => {
          log(`cmux events could not start: ${String(error)}`);
          resolve();
        });
      });
      return {
        stop: () => child.kill(),
        ended,
      };
    },
  };
}
