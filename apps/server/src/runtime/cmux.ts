/**
 * The `cmux` command-line wrapper. Every Claude seat's run is a cmux workspace the operator can see,
 * type into and clear; the hub starts it, sends it messages, reads its state from `cmux sessions` and
 * its results from Claude's own transcript. The cmux JSON is read defensively (names in either case):
 * it is the one place that knows its shape.
 */
import { execFile } from "node:child_process";
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

export interface CmuxAgent {
  sessionId: string;
  lifecycle: "idle" | "running" | "needsInput";
  pid: number | null;
  workspaceId: string;
  transcriptPath: string | null;
}

export interface CmuxWorkspaceInput {
  name: string;
  cwd: string;
  command: string;
  /** Workspace ids another run already holds: a same-named one among them is not this one. */
  exclude?: ReadonlySet<string>;
}

export interface Cmux {
  /** Throws a CmuxError when cmux refuses the hub or cannot be started. */
  ensure(): Promise<void>;
  newWorkspace(i: CmuxWorkspaceInput): Promise<string>;
  /** The Claude records cmux holds (`cmux sessions`), from one shared call per second. */
  agents(): Promise<CmuxAgent[]>;
  /** "busy": a dialog is open or a draft is typed; nothing was sent. */
  send(ws: string, text: string): Promise<"sent" | "busy">;
  sendKey(ws: string, key: string, force?: boolean): Promise<void>;
  readScreen(ws: string): Promise<string>;
  /** Closes the workspace, forced. A workspace already gone is not an error. */
  close(ws: string): Promise<void>;
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
    out.push({
      sessionId,
      lifecycle,
      workspaceId,
      pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
      transcriptPath: typeof transcript === "string" && transcript !== "" ? transcript : null,
    });
  }
  return out;
}

function parseWorkspaces(text: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const o of rowsOf(text, "workspaces")) {
    const id = pick(o, "id", "uuid", "workspaceId", "workspace_id");
    const name = pick(o, "title", "name", "customTitle", "custom_title");
    if (typeof id === "string" && typeof name === "string") out.push({ id, name });
  }
  return out;
}

export interface CmuxOptions {
  /** The command that asks macOS to start cmux (tests give a stand-in). */
  open?: readonly string[];
  /** How long `ensure` waits after it has asked (default 10 s). */
  startWaitMs?: number;
  /** How long `newWorkspace` looks for its workspace (default 5 s). */
  findWaitMs?: number;
}

/** What starts cmux from the hub: its own small environment, so the app does not inherit the hub's. */
function openCommand(): string[] {
  const env = [
    `HOME=${homedir()}`,
    `USER=${userInfo().username}`,
    `LOGNAME=${userInfo().username}`,
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    `TMPDIR=${process.env.TMPDIR ?? "/tmp"}`,
    `SHELL=${process.env.SHELL ?? "/bin/zsh"}`,
    `LANG=${process.env.LANG ?? "en_US.UTF-8"}`,
  ];
  return ["/usr/bin/env", "-i", ...env, "/usr/bin/open", "-g", "-a", "cmux"];
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

  async function workspaces() {
    const r = await cmux(["--json", "--id-format", "uuids", "list-workspaces"]);
    if (r.code !== 0) throw failed("list-workspaces", r);
    return parseWorkspaces(r.stdout);
  }

  return {
    async ensure() {
      const ping = async () => {
        const r = await cmux(["ping"]);
        if (r.code === 0) return "up";
        return /access denied/i.test(`${r.stderr}\n${r.stdout}`) ? "denied" : "down";
      };
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
      const wait = options.findWaitMs ?? FIND_WAIT_MS;
      for (const t0 = Date.now(); ; ) {
        const found = (await workspaces()).find((w) => w.name === i.name && !i.exclude?.has(w.id));
        if (found !== undefined) return found.id;
        if (Date.now() - t0 >= wait) throw new CmuxError("cmux made no workspace we could find");
        await sleep(FIND_RETRY_MS);
      }
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
    async readScreen(ws) {
      const r = await cmux(["read-screen", "--workspace", ws]);
      if (r.code !== 0) throw failed("read-screen", r);
      return r.stdout;
    },
    async close(ws) {
      const forced = await cmux(["close-workspace", "--workspace", ws, "--force"]);
      if (forced.code === 0) return;
      // an older cmux has no --force; a workspace already gone is as good as closed
      const plain = await cmux(["close-workspace", "--workspace", ws]);
      if (plain.code === 0) return;
      if (!(await workspaces().catch(() => [{ id: ws, name: "" }])).some((w) => w.id === ws))
        return;
      throw failed("close-workspace", plain);
    },
  };
}
