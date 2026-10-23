/**
 * The driver for one crew process: a long-lived `claude -p` speaking stream-json both ways (spike
 * docs/spikes/2026-10-20-runtime-stream-json.md). The CLI is owned by a keeper (`keeper.ts`), a
 * detached process that outlives the hub; this driver speaks to the keeper's socket, writes user
 * lines and control requests through it, and reports typed events from the stdout lines the keeper
 * numbers and replays. A crew process may misbehave (die mid-line, never answer, print junk):
 * nothing here throws from an event handler or leaves a promise pending once the process is gone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
  CONTROL_TIMEOUT_MS,
  type ControlSubtype,
  type SessionEvent,
  STDERR_TEXT_MAX,
  STOP_GRACE_MS,
} from "@mc/core";
import { cleanText } from "../clean.ts";
import { CLAUDE_COMMAND } from "../cli-version.ts";
import { STREAM_EVENT_PREFIX } from "../streamjson.ts";
import {
  CLI_PID_FILE,
  endKeeper,
  KEEPER_LOG_FILE,
  KEEPER_PID_FILE,
  KEEPER_PROTOCOL_VERSION,
  KEEPER_SOCKET,
  KEEPER_SOCKET_PATH_MAX,
  KEEPER_SPEC_FILE,
  type KeeperExit,
  type KeeperHello,
  type KeeperSpec,
  pidAlive,
  readKeeperExit,
  readKeeperSecret,
  readPidFile,
} from "./keeper.ts";

export type { SessionEvent };

/** How long `startSession` waits for the keeper it spawned to listen. */
export const KEEPER_CONNECT_MS = 10_000;
/** How long a connected keeper may take to send its hello. */
export const KEEPER_HELLO_MS = 5000;
/** How long `attachSession` tries to connect to a keeper whose pid is alive. */
const ATTACH_CONNECT_MS = 2000;
/** How long `attachSession` waits for the pids of a keeper that has exited to go. */
const EXITED_WAIT_MS = 5000;
const CONNECT_RETRY_MS = 25;

export interface SessionInput {
  /** Default `"claude"`; tests pass `process.execPath` with the fake CLI as the first argument. */
  command?: string;
  args: string[];
  cwd: string;
  /** Every stdout line is appended here by the keeper (mode 0600 when created). */
  transcriptPath: string;
  env?: NodeJS.ProcessEnv;
  /** The node that runs the keeper, and the keeper's entry file. */
  node: string;
  entry: string;
  /** The run's keeper folder: made here (mode 0700), emptied first. */
  dir: string;
  /** This keeper's id: the hub's cursor is only good for the keeper it was taken from. */
  spawn: string;
  /** The CLI's own session id (`--session-id` or `--resume`): `endKeeper` knows the CLI's process by it. */
  cliSessionId: string;
  /** Where `endKeeper` says which pids it left alone; default: nowhere. */
  log?: (msg: string) => void;
  /** Defaults CONTROL_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them. */
  controlTimeoutMs?: number;
  stopGraceMs?: number;
  /** Default the module caps on a partial line; tests shrink them. */
  stdoutLineMax?: number;
  stderrLineMax?: number;
}

export interface CrewSession {
  /** Writes one user line; throws `session ended` once the process is gone or closing. */
  send(text: string): void;
  /** Resolves with the response's `response`; rejects `control timeout` or `session ended`. */
  control(subtype: ControlSubtype): Promise<unknown>;
  /**
   * Ends stdin; SIGTERM after the grace period, SIGKILL after a second one. Resolves with the exit
   * code (null when a signal ended it).
   */
  close(): Promise<number | null>;
  /**
   * Lets go of the keeper without ending the process: the socket is closed, pending controls are
   * rejected `session ended` and no event is emitted. The process keeps running.
   */
  detach(): void;
  on(listener: (e: SessionEvent) => void): () => void;
  readonly pid: number | undefined;
  readonly alive: boolean;
  /** Resolves once the keeper answered (or the session ended without it): `alive` is then the truth. */
  readonly ready: Promise<void>;
  /** The keeper line this driver has read up to: the next one wanted. */
  readonly lines: number;
  /**
   * Resolves once the `close` line has been handed to the socket, or the session has ended or been
   * detached without sending one: a hub that is exiting waits on it, so a Stop is not lost.
   */
  readonly closeSent: Promise<void>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The longest partial stdout line kept, in characters (not bytes); a longer one is dropped, never
 * half-written.
 */
const STDOUT_LINE_MAX = 64 * 1024 * 1024;
/** The longest partial stderr line kept, in characters (not bytes); only its last ones are. */
const STDERR_LINE_MAX = 64 * 1024;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Splits a socket's data into lines; lines that come while no handler is set wait for the next one. */
function lineReader(sock: Socket) {
  let buf = "";
  let handler: ((line: string) => void) | null = null;
  const queued: string[] = [];
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (handler) handler(line);
      else queued.push(line);
    }
  });
  return {
    set(h: ((line: string) => void) | null) {
      handler = h;
      while (h && queued.length > 0 && handler === h) h(queued.shift() as string);
    },
  };
}
type LineReader = ReturnType<typeof lineReader>;

/** The first line of `reader` as a hello's version: null when it is not a hello (or not JSON). */
function parseHello(line: string): KeeperHello | { version: number | null } {
  try {
    const v: unknown = JSON.parse(line);
    if (isObj(v) && v.t === "hello") {
      const version = typeof v.version === "number" ? v.version : null;
      if (version === KEEPER_PROTOCOL_VERSION) {
        const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
        return {
          t: "hello",
          version,
          spawn: typeof v.spawn === "string" ? v.spawn : "",
          pid: n(v.pid),
          cliPid: typeof v.cliPid === "number" ? v.cliPid : null,
          lines: n(v.lines),
          awaiting: v.awaiting === true,
        };
      }
      return { version };
    }
  } catch {
    // not JSON
  }
  return { version: null };
}
const isHello = (h: KeeperHello | { version: number | null }): h is KeeperHello => "t" in h;

/** The session's state and events, over a keeper socket that `link` brings (or never does). */
function createDriver(i: {
  dir: string;
  controlTimeoutMs: number;
  stopGraceMs: number;
  /** Emit `attached` once the replay is in. */
  announce: boolean;
  /** The keeper's secret, said in the hello; null for an older keeper whose spec has none. */
  secret: string | null;
  log?: (msg: string) => void;
}) {
  const listeners = new Set<(e: SessionEvent) => void>();
  const pending = new Map<string, Pending>();
  let sock: Socket | null = null;
  let hello: KeeperHello | null = null;
  /** Messages for the keeper written before the socket is linked, and who is told when each is written. */
  const outbox: { obj: Json; done?: () => void }[] = [];
  let alive = true;
  let finished = false;
  let detached = false;
  let stdinEnded = false;
  let inTurn = false;
  let announced = false;
  /** The next keeper line wanted. */
  let next = 0;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let resolveCloseSent: () => void = () => {};
  const closeSent = new Promise<void>((r) => {
    resolveCloseSent = r;
  });

  const emit = (e: SessionEvent) => {
    if (detached) return;
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // one broken listener must not stop the others, or the stream
      }
    }
  };

  /** Writes a line to the keeper; `done` is called once the socket has taken it (at once when it cannot). */
  const transmit = (obj: Json, done?: () => void) => {
    if (sock === null) outbox.push({ obj, done });
    else if (sock.destroyed) done?.();
    else sock.write(`${JSON.stringify(obj)}\n`, () => done?.());
  };

  const rejectPending = () => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error("session ended"));
    }
  };

  const stderrText = (text: string) => {
    const t = cleanText(text, STDERR_TEXT_MAX).trim();
    if (t !== "") emit({ kind: "stderr", text: t });
  };

  /** Reports the exit, once. A line cut off by the exit was kept by the keeper but never sent. */
  function end(info: { code: number | null; signal: string | null }): void {
    if (finished) return;
    finished = true;
    alive = false;
    rejectPending();
    resolveReady();
    resolveCloseSent();
    emit({ kind: "exit", code: info.code, signal: info.signal });
    resolveExit(info.code);
  }

  function stdoutLine(line: string): void {
    emit({ kind: "output", at: Date.now() });
    if (!line.startsWith("{") || line.startsWith(STREAM_EVENT_PREFIX)) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(ev)) return;
    if (ev.type === "system" && ev.subtype === "init") {
      const sessionId = str(ev.session_id);
      const model = str(ev.model);
      if (sessionId !== null) {
        emit({ kind: "init", sessionId, model: model === null ? null : cleanText(model, 200) });
      }
    } else if (ev.type === "assistant" || (ev.type === "tool_progress" && ev.heartbeat !== true)) {
      if (!inTurn) {
        inTurn = true;
        emit({ kind: "turn-start" });
      }
    } else if (ev.type === "user" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      // a tool call has ended (the CLI echoes each tool_result as a user line)
      for (const c of ev.message.content) {
        const id = isObj(c) && c.type === "tool_result" ? str(c.tool_use_id) : null;
        if (id !== null) emit({ kind: "tool-result", toolUseId: id });
      }
    } else if (ev.type === "result") {
      inTurn = false;
      const stopReason = str(ev.stop_reason);
      emit({
        kind: "result",
        isError: ev.is_error === true,
        stopReason: stopReason === null ? null : cleanText(stopReason, 200),
      });
    } else if (ev.type === "rate_limit_event") {
      const info = ev.rate_limit_info;
      const status = isObj(info) ? str(info.status) : null;
      if (isObj(info) && status !== null) {
        const resetsAt = info.resetsAt;
        emit({
          kind: "rate-limit",
          status: cleanText(status, 200),
          resetsAt:
            typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
        });
      }
    } else if (ev.type === "control_response" && isObj(ev.response)) {
      const r = ev.response;
      const id = str(r.request_id);
      const p = id === null ? undefined : pending.get(id);
      if (id === null || p === undefined) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (r.subtype === "success") p.resolve(r.response);
      else p.reject(new Error(cleanText(str(r.error) ?? "control request failed", 200)));
    }
  }

  const announceIfCaughtUp = () => {
    if (!i.announce || announced || hello === null || next < hello.lines) return;
    announced = true;
    emit({ kind: "attached", awaiting: hello.awaiting });
  };

  function onLine(text: string): void {
    if (finished || detached) return;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (m.t === "out" && typeof m.n === "number" && typeof m.line === "string") {
      if (m.n < next) return; // a line already read
      next = m.n + 1;
      stdoutLine(m.line);
      announceIfCaughtUp();
    } else if (m.t === "err" && typeof m.text === "string") {
      stderrText(m.text);
    } else if (m.t === "exit") {
      end({
        code: typeof m.code === "number" ? m.code : null,
        signal: typeof m.signal === "string" ? m.signal : null,
      });
    }
  }

  /** The keeper went without saying `exit`: end it by its pids, and report the exit it left. */
  async function lost(): Promise<void> {
    if (finished || detached) return;
    stderrText("the keeper ended unexpectedly");
    await endKeeper(i.dir, i.stopGraceMs, i.log);
    if (finished || detached) return;
    const e = readKeeperExit(i.dir);
    end({ code: e?.code ?? null, signal: e?.signal ?? null });
  }

  /** The keeper's hello is in: say ours, send what waited, and read the rest. */
  function link(s: Socket, reader: LineReader, h: KeeperHello, from: number): void {
    sock = s;
    hello = h;
    next = Math.min(Math.max(from, 0), h.lines);
    s.on("error", () => {});
    s.on("close", () => {
      if (!finished && !detached) void lost();
    });
    transmit({
      t: "hello",
      version: KEEPER_PROTOCOL_VERSION,
      from: next,
      ...(i.secret === null ? {} : { secret: i.secret }),
    });
    for (const m of outbox.splice(0)) transmit(m.obj, m.done);
    reader.set(onLine);
    resolveReady();
    // Later than the caller's own turn, so the caller's listeners hear it (a replay's lines come
    // from the socket, never before then).
    setImmediate(announceIfCaughtUp);
  }

  const writable = () => alive && !stdinEnded && !finished;

  const session: CrewSession = {
    send(text) {
      if (!writable()) throw new Error("session ended");
      transmit({
        t: "in",
        line: JSON.stringify({ type: "user", message: { role: "user", content: text } }),
        user: true,
      });
      // The activity that follows a user line starts a turn, even mid-turn.
      inTurn = false;
    },
    control(subtype) {
      if (!writable()) return Promise.reject(new Error("session ended"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("control timeout"));
        }, i.controlTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        transmit({
          t: "in",
          line: JSON.stringify({
            type: "control_request",
            request_id: id,
            request: { subtype },
          }),
          user: false,
        });
      });
    },
    close() {
      if (!stdinEnded && !finished) {
        stdinEnded = true;
        transmit({ t: "close", graceMs: i.stopGraceMs }, resolveCloseSent);
      }
      return exited;
    },
    detach() {
      if (detached) return;
      rejectPending();
      detached = true;
      alive = false;
      listeners.clear();
      sock?.destroy();
      // nobody is left waiting on a keeper this driver no longer follows
      resolveReady();
      resolveCloseSent();
      resolveExit(null);
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pid() {
      return hello?.cliPid ?? undefined;
    },
    get alive() {
      return alive;
    },
    ready,
    get lines() {
      return next;
    },
    closeSent,
  };

  return {
    session,
    link,
    /** The keeper never came up: report what it left (or that it left nothing), then the exit. */
    failed(e: KeeperExit | null, why: string | null): void {
      if (finished || detached) return;
      const said = e?.lastStderr ?? why;
      if (said !== null) stderrText(said);
      end({ code: e?.code ?? null, signal: e?.signal ?? null });
    },
    isDone: () => finished || detached,
  };
}

/**
 * Starts a keeper for a new run (its folder emptied and made, its spec written), and drives it. The
 * keeper runs `claude` with `i.args`, `i.env` and `i.cwd`. Throws before anything is spawned when the
 * transcript cannot be opened or the folder's socket path is too long. The session is usable at once:
 * lines and controls sent before the keeper answers wait for it. A keeper that cannot start the CLI
 * (or never answers) ends the session with its stderr line and an exit.
 */
export function startSession(i: SessionInput): CrewSession {
  const socketPath = join(i.dir, KEEPER_SOCKET);
  if (socketPath.length > KEEPER_SOCKET_PATH_MAX) {
    throw new Error(`the keeper's socket path is too long (${socketPath.length} characters)`);
  }
  // A transcript that cannot be opened throws here, before anything is spawned.
  closeSync(openSync(i.transcriptPath, "a", 0o600));
  const stopGraceMs = i.stopGraceMs ?? STOP_GRACE_MS;
  rmSync(i.dir, { recursive: true, force: true });
  mkdirSync(i.dir, { mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  const spec: KeeperSpec = {
    runId: i.spawn,
    spawn: i.spawn,
    command: i.command ?? CLAUDE_COMMAND,
    args: i.args,
    cwd: i.cwd,
    env: Object.fromEntries(
      Object.entries(i.env ?? process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    transcriptPath: i.transcriptPath,
    stdoutLineMax: i.stdoutLineMax ?? STDOUT_LINE_MAX,
    stderrLineMax: i.stderrLineMax ?? STDERR_LINE_MAX,
    stopGraceMs,
    secret,
    cliSessionId: i.cliSessionId,
  };
  writeFileSync(join(i.dir, KEEPER_SPEC_FILE), JSON.stringify(spec), { mode: 0o600 });
  const driver = createDriver({
    dir: i.dir,
    controlTimeoutMs: i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS,
    stopGraceMs,
    announce: false,
    secret,
    log: i.log,
  });
  const log = openSync(join(i.dir, KEEPER_LOG_FILE), "a", 0o600);
  let keeper: ChildProcess;
  try {
    keeper = spawn(i.node, ["--experimental-strip-types", i.entry, i.dir], {
      cwd: i.dir,
      detached: true,
      stdio: ["ignore", log, log],
      // the keeper needs none of the hub's environment; the CLI's is in the spec
      env: { PATH: process.env.PATH ?? "" },
    });
  } finally {
    closeSync(log);
  }
  keeper.unref();
  let keeperGone = false;
  let spawnError: string | null = null;
  keeper.on("error", (e) => {
    spawnError = `could not start the CLI: ${e.message}`;
    keeperGone = true;
  });
  keeper.on("exit", () => {
    keeperGone = true;
  });

  const t0 = Date.now();
  const attempt = () => {
    if (driver.isDone()) return;
    if (keeperGone) {
      // the keeper left without listening: its exit file says why (a CLI that would not start)
      const e = readKeeperExit(i.dir);
      driver.failed(e, e === null ? (spawnError ?? "the keeper ended unexpectedly") : null);
      return;
    }
    if (Date.now() - t0 > KEEPER_CONNECT_MS) {
      void endKeeper(i.dir, stopGraceMs, i.log).then(() =>
        driver.failed(null, "could not start the CLI: the keeper did not answer"),
      );
      return;
    }
    const sock = connect(socketPath);
    sock.once("error", () => {
      sock.destroy();
      setTimeout(attempt, CONNECT_RETRY_MS);
    });
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      sock.on("error", () => {});
      const reader = lineReader(sock);
      const timer = setTimeout(() => {
        sock.destroy();
        void endKeeper(i.dir, stopGraceMs, i.log).then(() =>
          driver.failed(null, "could not start the CLI: the keeper did not answer"),
        );
      }, KEEPER_HELLO_MS);
      reader.set((line) => {
        clearTimeout(timer);
        reader.set(null);
        const h = parseHello(line);
        if (isHello(h)) {
          driver.link(sock, reader, h, 0);
        } else {
          sock.destroy();
          void endKeeper(i.dir, stopGraceMs, i.log).then(() =>
            driver.failed(null, "could not start the CLI: the keeper spoke another version"),
          );
        }
      });
    });
  };
  attempt();
  return driver.session;
}

/** What `attachSession` found. */
export type Attached =
  | { kind: "attached"; session: CrewSession; hello: KeeperHello }
  /** The CLI exited while no hub was attached. */
  | { kind: "exited"; exit: KeeperExit }
  /** No keeper to attach to (null), or one that speaks another version (its number). */
  | { kind: "gone"; version: number | null };

/**
 * Attaches to the keeper of a run folder that an earlier hub started. `from` says which keeper line
 * to replay from, given the keeper's hello. Never throws.
 */
export async function attachSession(i: {
  dir: string;
  from: (h: KeeperHello) => number;
  controlTimeoutMs?: number;
  stopGraceMs?: number;
  log?: (msg: string) => void;
}): Promise<Attached> {
  try {
    const exitedResult = async (): Promise<Attached | null> => {
      const exit = readKeeperExit(i.dir);
      if (exit === null) return null;
      const live = () =>
        [KEEPER_PID_FILE, CLI_PID_FILE].some((n) => {
          const pid = readPidFile(i.dir, n);
          return pid !== null && pidAlive(pid);
        });
      for (const t0 = Date.now(); live() && Date.now() - t0 < EXITED_WAIT_MS; ) await sleep(50);
      return { kind: "exited", exit };
    };
    const done = await exitedResult();
    if (done !== null) return done;
    const keeperPid = readPidFile(i.dir, KEEPER_PID_FILE);
    if (keeperPid === null || !pidAlive(keeperPid)) return { kind: "gone", version: null };

    const socketPath = join(i.dir, KEEPER_SOCKET);
    let sock: Socket | null = null;
    for (const t0 = Date.now(); sock === null && Date.now() - t0 < ATTACH_CONNECT_MS; ) {
      sock = await new Promise<Socket | null>((resolve) => {
        const s = connect(socketPath);
        s.once("connect", () => resolve(s));
        s.once("error", () => {
          s.destroy();
          setTimeout(() => resolve(null), CONNECT_RETRY_MS);
        });
      });
    }
    if (sock === null) {
      // the keeper may have finished between the checks
      return (await exitedResult()) ?? { kind: "gone", version: null };
    }
    const s = sock;
    s.on("error", () => {});
    const reader = lineReader(s);
    const first = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        reader.set(null);
        resolve(null);
      }, KEEPER_HELLO_MS);
      reader.set((line) => {
        clearTimeout(timer);
        reader.set(null);
        resolve(line);
      });
    });
    const h = first === null ? { version: null } : parseHello(first);
    if (!isHello(h)) {
      s.destroy();
      return { kind: "gone", version: h.version };
    }
    const driver = createDriver({
      dir: i.dir,
      controlTimeoutMs: i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS,
      stopGraceMs: i.stopGraceMs ?? STOP_GRACE_MS,
      announce: true,
      // an older keeper's spec has no secret, and that keeper asks for none
      secret: readKeeperSecret(i.dir),
      log: i.log,
    });
    driver.link(s, reader, h, i.from(h));
    return { kind: "attached", session: driver.session, hello: h };
  } catch {
    return { kind: "gone", version: null };
  }
}
