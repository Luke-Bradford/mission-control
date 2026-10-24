/**
 * The keeper: one small process per crew run that owns the `claude -p` child, so the hub can restart
 * without ending the seat (spike docs/spikes/2026-10-22-seat-survives-hub-restart.md). It runs
 * detached (its own session), so the hub's process group going away does not take it, and it keeps
 * running whether or not a hub is attached. It uses node builtins only: it runs from
 * `keeper-cli.ts` under the crew's node, and must not depend on the hub's code or state.
 *
 * Everything lives in the run's folder (mode 0700, every file 0600):
 *   spec.json    what to run (written by the hub before the keeper starts)
 *   s            the Unix socket the hub connects to
 *   keeper.pid   the keeper's pid; cli.pid the CLI's
 *   exit.json    written once when the CLI has exited: code, signal, time and its last stderr line
 *   keeper.log   the keeper's own stdout and stderr
 *
 * The CLI's stdout lines are written to the run's transcript and numbered from 0 (the line's number
 * is its place in this keeper's output, whatever the transcript held before). The wire is newline
 * JSON. Keeper to hub: `hello` (always first; its shape is frozen so an older or newer hub can read
 * it), `{t:"out",n,line}`, `{t:"err",text}`, `{t:"exit",code,signal}`. Hub to keeper:
 * `{t:"hello",version,from,secret}` (the first line wanted, and the secret from `spec.json`; a
 * connection whose first line is anything else is closed, and so is one silent for 5 s),
 * `{t:"in",line,user}` (a line for the CLI's stdin; `user`: it starts a turn) and
 * `{t:"close",graceMs}` (end stdin). One hub at a time: the newest to authenticate replaces the old.
 * A hub that was away gets every line from the one it asks for, replayed 500 at a time, then the
 * live ones, in order, with `exit` after the last. The CLI runs in its own process group, which the
 * keeper signals, and a keeper with no hub attached for 6 h ends the CLI and exits.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { uptime } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Bumped when the wire changes; a hub that finds another version ends that keeper and resumes. */
export const KEEPER_PROTOCOL_VERSION = 1;
/** The keeper's entry, from the hub's root. */
export const KEEPER_ENTRY = "apps/server/src/runtime/keeper-cli.ts";
/** A Unix socket's path is cut near here (104 bytes on macOS, with the terminator). */
export const KEEPER_SOCKET_PATH_MAX = 103;

export const KEEPER_SOCKET = "s";
export const KEEPER_PID_FILE = "keeper.pid";
export const CLI_PID_FILE = "cli.pid";
export const KEEPER_EXIT_FILE = "exit.json";
export const KEEPER_LOG_FILE = "keeper.log";
export const KEEPER_SPEC_FILE = "spec.json";

/** Lines replayed to a client per turn of the event loop. */
const REPLAY_BATCH = 500;
/**
 * After the CLI has exited before any hub has said hello (it failed at once, say), how long the
 * keeper waits for the first one: it starts the keeper, so it comes within moments.
 */
const FIRST_HUB_WAIT_MS = 3000;
/** The most stderr lines kept for a first hub that has not come yet. */
const EARLY_ERR_MAX = 100;
/** After the CLI exits, how long its pipes may stay open (a grandchild holding them). */
const EXIT_DRAIN_MS = 1000;
/** How long a connection may go without a valid hello, and how much it may send with no newline. */
const AUTH_WAIT_MS = 5000;
const AUTH_LINE_MAX = 4096;
/** A keeper that no hub has been attached to for this long ends its CLI and exits. */
export const KEEPER_HUB_ABSENT_MS = 6 * 60 * 60 * 1000;
/** The exit's reason when the hub-absent limit ended the CLI. */
export const HUB_ABSENT_TEXT = "the keeper ended the CLI: no hub was attached for 6 h";
/** The exit's reason when the spec's secret is not the 64 hex characters the hub writes. */
export const NO_SECRET_TEXT = "could not start the CLI: the keeper's spec has no secret";
const SECRET_FORMAT = /^[0-9a-f]{64}$/;
/** A turn ends with this line (the CLI prints `type` first). */
const RESULT_PREFIX = '{"type":"result"';
const DROPPED_TEXT = "a CLI output line over 64 MiB was dropped";

/** What the hub writes to `spec.json`: the CLI to run, as the hub would have run it. */
export interface KeeperSpec {
  runId: string;
  spawn: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  transcriptPath: string;
  stdoutLineMax: number;
  stderrLineMax: number;
  stopGraceMs: number;
  /** 32 random bytes as hex: only a hub that says it in its hello drives this keeper. */
  secret: string;
  /** The CLI's own session id, which its command line carries: `endKeeper` knows the CLI by it. */
  cliSessionId: string;
  /** Absent in older specs: Claude's result prefix and CLI session id. */
  turnEnd?: "claude" | "codex";
  marker?: string;
  /** Default FIRST_HUB_WAIT_MS; tests that have no hub shorten it. */
  firstHubWaitMs?: number;
  /** Default KEEPER_HUB_ABSENT_MS; tests shorten it. */
  hubAbsentMs?: number;
}

export interface KeeperExit {
  code: number | null;
  signal: string | null;
  at: number;
  lastStderr: string | null;
  lastStderrAt: number | null;
  endReason: string | null;
}

/** The keeper's first line to a client. Its shape is frozen. */
export interface KeeperHello {
  t: "hello";
  version: number;
  /** The id of this keeper's run (`spec.spawn`). */
  spawn: string;
  pid: number;
  cliPid: number | null;
  /** Lines written so far: the next line's number. */
  lines: number;
  /** A user line was written and the turn's `result` has not come. */
  awaiting: boolean;
}

export const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, owned by someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The pid in `dir/name` and its file's mtime; null when the file is missing, not a pid, or older than the boot (a stale pid). */
export function readPidStamp(dir: string, name: string): { pid: number; mtimeMs: number } | null {
  try {
    const path = join(dir, name);
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const bootedAt = Date.now() - uptime() * 1000;
    const { mtimeMs } = statSync(path);
    return mtimeMs < bootedAt - 2000 ? null : { pid, mtimeMs };
  } catch {
    return null;
  }
}

/** The pid in `dir/name`; null when the file is missing, not a pid, or older than the boot (a stale pid). */
export function readPidFile(dir: string, name: string): number | null {
  return readPidStamp(dir, name)?.pid ?? null;
}

/** The hub secret in the run folder's spec; null when the spec is unreadable or its secret is not 64 hex characters. */
export function readKeeperSecret(dir: string): string | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, KEEPER_SPEC_FILE), "utf8"));
    const secret = (v as { secret?: unknown } | null)?.secret;
    return typeof secret === "string" && SECRET_FORMAT.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/** Whether a pid file of the run folder names a live process (`kill -0`: not a check of whose). */
export function keeperAlive(dir: string): boolean {
  return [KEEPER_PID_FILE, CLI_PID_FILE].some((n) => {
    const pid = readPidFile(dir, n);
    return pid !== null && pidAlive(pid);
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One line of `ps -o lstart=,command=`: the process's start (local time, whole seconds) and its command. */
export function parsePsLine(text: string): { startedAt: number; command: string } | null {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/s.exec(
    text,
  );
  if (m === null) return null;
  const month = MONTHS.indexOf(m[1] as string);
  if (month < 0) return null;
  const startedAt = new Date(
    Number(m[6]),
    month,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
  const command = (m[7] as string).trim();
  return Number.isFinite(startedAt) && command !== "" ? { startedAt, command } : null;
}

/** What `ps` says of a pid; null when it cannot say (no such process, no `ps`, a line it cannot read). */
export function processInfo(pid: number): { startedAt: number; command: string } | null {
  try {
    const out = execFileSync("ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsLine(out);
  } catch {
    return null;
  }
}

/** `exit.json` of the run folder, or null when it is not there or not an exit. */
export function readKeeperExit(dir: string): KeeperExit | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, KEEPER_EXIT_FILE), "utf8"));
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    const code = typeof r.code === "number" ? r.code : null;
    const signal = typeof r.signal === "string" ? r.signal : null;
    const at = typeof r.at === "number" ? r.at : 0;
    const lastStderr = typeof r.lastStderr === "string" ? r.lastStderr : null;
    return {
      code,
      signal,
      at,
      lastStderr,
      lastStderrAt:
        typeof r.lastStderrAt === "number" && Number.isFinite(r.lastStderrAt)
          ? r.lastStderrAt
          : null,
      endReason: typeof r.endReason === "string" ? r.endReason : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ends the run folder's keeper and CLI by their pids: SIGTERM, then SIGKILL after `waitMs`, and a
 * wait of up to 2 s for that. Resolves whether they are all dead. Never throws. A pid is signalled
 * only when `ps` says it is this run's own process: the keeper's command names `keeper-cli` and the
 * folder, the CLI's names the spec's `cliSessionId`, and each started no later than its pid file
 * was written (a pid reused since is none of these). Any other pid is logged and left alone. A live
 * pid that cannot be identified (`ps` cannot read it, or the spec has no `cliSessionId` to know
 * the CLI by) is left alone too, and makes the result false while it lives: it may be the run's
 * own process, so the caller must not treat the run as ended. The CLI is signalled as its process group, so its
 * children go with it.
 */
export async function endKeeper(
  dir: string,
  waitMs: number,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  type Role = "keeper" | "CLI";
  type Target = { pid: number; role: Role };
  const marker = (): string | null => {
    try {
      const v: unknown = JSON.parse(readFileSync(join(dir, KEEPER_SPEC_FILE), "utf8"));
      const spec = v as { marker?: unknown; cliSessionId?: unknown } | null;
      const id = spec?.marker ?? spec?.cliSessionId;
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  };
  const fits = (role: Role, command: string): boolean => {
    if (role === "keeper") return command.includes("keeper-cli") && command.includes(dir);
    const id = marker();
    return id !== null && command.includes(id);
  };
  /**
   * The live pids of the pid files, as `ps` says now: `found` are this run's own; `unknown` are
   * ones that could not be identified (ps said nothing, or the CLI's session id is not in the
   * spec), which might be this run's and are left alone. A pid ps read and that does not fit is
   * neither: it belongs to someone else.
   */
  const targets = (quiet: boolean): { found: Target[]; unknown: Target[] } => {
    const found: Target[] = [];
    const unknown: Target[] = [];
    for (const [name, role] of [
      [KEEPER_PID_FILE, "keeper"],
      [CLI_PID_FILE, "CLI"],
    ] as const) {
      const stamp = readPidStamp(dir, name);
      if (stamp === null || !pidAlive(stamp.pid)) continue;
      const info = processInfo(stamp.pid);
      if (info !== null && info.startedAt <= stamp.mtimeMs && fits(role, info.command)) {
        found.push({ pid: stamp.pid, role });
        continue;
      }
      if (info === null || (role === "CLI" && marker() === null)) {
        unknown.push({ pid: stamp.pid, role });
      }
      if (!quiet) {
        log(
          `${dir}: pid ${stamp.pid} in ${name} is not the run's ${role}, or ps could not say; not signalled`,
        );
      }
    }
    return { found, unknown };
  };
  const signal = (list: Target[], sig: NodeJS.Signals) => {
    for (const { pid, role } of list) {
      try {
        if (role === "CLI") {
          try {
            process.kill(-pid, sig);
            continue;
          } catch {
            // not a group leader (an older keeper's CLI): the pid alone
          }
        }
        process.kill(pid, sig);
      } catch {
        // gone already
      }
    }
  };
  const waitDead = async (list: Target[], ms: number) => {
    for (const t0 = Date.now(); list.some((t) => pidAlive(t.pid)) && Date.now() - t0 < ms; ) {
      await sleep(100);
    }
  };
  const { found: first, unknown } = targets(false);
  // A pid that could not be identified is never signalled, but while it lives it may be this run's
  // CLI: the run is not ended. (An older keeper's SIGTERM ends its own CLI, so that one goes.)
  const allEnded = () => !unknown.some((t) => pidAlive(t.pid));
  if (first.length === 0) return allEnded();
  signal(first, "SIGTERM");
  await waitDead(first, waitMs);
  // checked again: a pid that went and was reused during the wait is not ours to kill
  const left = targets(true).found.filter((t) => first.some((f) => f.pid === t.pid));
  if (left.length === 0) return allEnded();
  signal(left, "SIGKILL");
  await waitDead(left, 2000);
  return !left.some((t) => pidAlive(t.pid)) && allEnded();
}

type Json = Record<string, unknown>;

interface Client {
  sock: Socket;
  /** Its first line was a hello with the hub secret: it is the client, and its lines count. */
  authed: boolean;
  /** The client's hello came: its `in` and `close` lines count, and lines are sent to it. */
  ready: boolean;
  /** The next line to send it. */
  next: number;
  pumping: boolean;
  buf: string;
}

/**
 * Runs the keeper for the run folder `dir` (its `spec.json` is read first). `done` resolves once
 * the CLI has exited and `exit.json` is written (or the CLI could not start); the caller exits then.
 * `terminate()` (the keeper's SIGTERM) ends the CLI the hard way. `opts.write` replaces `writeSync`
 * for the transcript (tests make it write short or fail).
 */
export function runKeeper(
  dir: string,
  opts: { write?: (fd: number, data: Uint8Array) => number } = {},
): { done: Promise<void>; terminate: () => void } {
  const spec = JSON.parse(readFileSync(join(dir, KEEPER_SPEC_FILE), "utf8")) as KeeperSpec;
  const write = opts.write ?? ((f: number, d: Uint8Array) => writeSync(f, d));
  const secret = (name: string, text: string) => {
    const tmp = join(dir, `${name}.tmp-${process.pid}`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  };

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let lastStderr: string | null = null;
  let lastStderrAt: number | null = null;
  /** The keeper's own failure or termination reason; it outranks the CLI's last stderr line. */
  let endReason: string | null = null;
  const writeExit = (code: number | null, signal: string | null) => {
    const exit: KeeperExit = {
      code,
      signal,
      at: Date.now(),
      lastStderr: endReason ?? lastStderr,
      lastStderrAt,
      endReason,
    };
    try {
      secret(KEEPER_EXIT_FILE, JSON.stringify(exit));
    } catch (e) {
      process.stderr.write(`could not write ${KEEPER_EXIT_FILE}: ${(e as Error).message}\n`);
    }
  };

  // a keeper no hub can authenticate to would run unreachable: it starts nothing
  const hubSecret =
    typeof spec.secret === "string" && SECRET_FORMAT.test(spec.secret) ? spec.secret : null;
  if (hubSecret === null) {
    endReason = NO_SECRET_TEXT;
    writeExit(null, null);
    resolveDone();
    return { done, terminate: () => {} };
  }
  const expectedSecret = Buffer.from(hubSecret);

  let fd = -1;
  let child: ChildProcess;
  try {
    fd = openSync(spec.transcriptPath, "a", 0o600);
    // its own process group: the keeper ends the CLI's children with it (`killCli`)
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    if (fd >= 0) closeSync(fd);
    endReason = `could not start the CLI: ${(e as Error).message}`;
    writeExit(null, null);
    resolveDone();
    return { done, terminate: () => {} };
  }
  if (child.pid === undefined) {
    // a missing command or folder arrives as an 'error' event
    child.on("error", (e) => {
      endReason = `could not start the CLI: ${e.message}`;
      closeSync(fd);
      writeExit(null, null);
      resolveDone();
    });
    return { done, terminate: () => {} };
  }
  const cli = child;
  const stdin = cli.stdin as NonNullable<ChildProcess["stdin"]>;
  const stdout = cli.stdout as NonNullable<ChildProcess["stdout"]>;
  const stderr = cli.stderr as NonNullable<ChildProcess["stderr"]>;
  const cliPid = child.pid;
  secret(CLI_PID_FILE, `${cliPid}\n`);
  secret(KEEPER_PID_FILE, `${process.pid}\n`);
  /** Signals the CLI's whole process group (it leads one), or the CLI alone when that fails. */
  const killCli = (sig: NodeJS.Signals) => {
    try {
      process.kill(-cliPid, sig);
    } catch {
      try {
        cli.kill(sig);
      } catch {
        // gone already
      }
    }
  };

  // --- the transcript and the numbered lines -------------------------------------------------
  /** Byte offset of line n in the transcript, for the lines it holds; line 0 starts at its size now. */
  const offsets: number[] = [statSync(spec.transcriptPath).size];
  /** Lines after a failed transcript write are only here (line number to text). */
  const held = new Map<number, string>();
  /** The first of them: every line below it is in the transcript. */
  let firstHeld = Number.POSITIVE_INFINITY;
  let lineCount = 0;
  let transcriptFailed = false;
  let awaiting = false;
  let awaitingId: number | string | null = null;

  const send = (c: Client, obj: Json) => {
    if (!c.sock.destroyed) c.sock.write(`${JSON.stringify(obj)}\n`);
  };
  let client: Client | null = null;

  /** Writes a line and its newline to the transcript; false (once reported) when that fails. */
  const record = (line: string): boolean => {
    if (transcriptFailed) return false;
    try {
      const bytes = Buffer.from(`${line}\n`);
      for (let done = 0; done < bytes.length; ) {
        const n = write(fd, bytes.subarray(done));
        if (n <= 0) throw new Error("no bytes written");
        done += n;
      }
      return true;
    } catch (e) {
      transcriptFailed = true;
      err(`transcript write failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  /** Whether any hub has said hello yet: until one has, stderr lines wait for it. */
  let everReady = false;
  const earlyErrs: string[] = [];
  const err = (text: string) => {
    if (client?.ready) send(client, { t: "err", text });
    else if (!everReady && earlyErrs.length < EARLY_ERR_MAX) earlyErrs.push(text);
  };

  /** Lines `a` to `b` (exclusive), all of them in the transcript, in one read. */
  const readLines = (a: number, b: number): string[] => {
    const from = offsets[a] as number;
    const to = offsets[b] as number;
    const buf = Buffer.alloc(to - from);
    const rfd = openSync(spec.transcriptPath, "r");
    try {
      for (let got = 0; got < buf.length; ) {
        const n = readSync(rfd, buf, got, buf.length - got, from + got);
        if (n <= 0) break;
        got += n;
      }
    } finally {
      closeSync(rfd);
    }
    return buf.toString("utf8").slice(0, -1).split("\n");
  };

  /** Sends the client its lines from `next`, `REPLAY_BATCH` per turn of the loop; then `exit` if the CLI has gone. */
  const pump = (c: Client) => {
    if (c.pumping || !c.ready || c.sock.destroyed) return;
    c.pumping = true;
    const step = () => {
      if (client !== c || c.sock.destroyed) {
        c.pumping = false;
        return;
      }
      try {
        const stop = Math.min(lineCount, c.next + REPLAY_BATCH);
        // the lines the transcript holds go out in one read; later ones come from memory
        const inFile = Math.min(stop, firstHeld);
        const texts = c.next < inFile ? readLines(c.next, inFile) : [];
        for (let n = c.next, i = 0; n < stop; n++, i++) {
          const line = n < inFile ? (texts[i] as string) : (held.get(n) as string);
          send(c, { t: "out", n, line });
        }
        c.next = stop;
      } catch (e) {
        err(`could not replay the transcript: ${(e as Error).message}`);
        c.sock.destroy();
        c.pumping = false;
        return;
      }
      if (c.next < lineCount) {
        setImmediate(step);
        return;
      }
      c.pumping = false;
      if (closed !== null) finishWith(c);
    };
    step();
  };
  const addLine = (line: string) => {
    const n = lineCount;
    const ok = record(line);
    if (ok) {
      offsets.push((offsets[n] as number) + Buffer.byteLength(line) + 1);
    } else {
      if (firstHeld === Number.POSITIVE_INFINITY) firstHeld = n;
      held.set(n, line);
    }
    lineCount = n + 1;
    if (spec.turnEnd === "codex") {
      try {
        const m = JSON.parse(line) as Json | null;
        if (
          m?.method === "turn/completed" ||
          (awaitingId !== null && m?.id === awaitingId && m.error != null)
        ) {
          awaiting = false;
          awaitingId = null;
        }
      } catch {
        // Non-JSON stdout does not end a turn.
      }
    } else if (line.startsWith(RESULT_PREFIX)) awaiting = false;
    if (client) pump(client);
  };

  // --- the CLI's output ----------------------------------------------------------------------
  let outBuf = "";
  let errBuf = "";
  let dropping = false;
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    let rest = chunk;
    while (rest !== "") {
      const nl = rest.indexOf("\n");
      if (dropping) {
        if (nl < 0) return;
        dropping = false;
        rest = rest.slice(nl + 1);
        continue;
      }
      if (nl < 0) {
        outBuf += rest;
        if (outBuf.length > spec.stdoutLineMax) {
          outBuf = "";
          dropping = true;
          err(DROPPED_TEXT);
        }
        return;
      }
      const line = outBuf + rest.slice(0, nl);
      outBuf = "";
      rest = rest.slice(nl + 1);
      if (line.length > spec.stdoutLineMax) {
        err(DROPPED_TEXT);
        continue;
      }
      addLine(line);
    }
  });

  const stderrLine = (line: string) => {
    if (line.trim() !== "") {
      lastStderr = line.trim();
      lastStderrAt = Date.now();
    }
    err(line);
  };
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    errBuf += chunk;
    let nl = errBuf.indexOf("\n");
    while (nl >= 0) {
      stderrLine(errBuf.slice(0, nl).slice(-spec.stderrLineMax));
      errBuf = errBuf.slice(nl + 1);
      nl = errBuf.indexOf("\n");
    }
    if (errBuf.length > spec.stderrLineMax) errBuf = errBuf.slice(-spec.stderrLineMax);
  });
  stdin.on("error", () => {});

  // --- the hub ---------------------------------------------------------------------------------
  let stopTimer: NodeJS.Timeout | undefined;
  let absentTimer: NodeJS.Timeout | undefined;
  let alive = true;
  /** (Re)starts the limit on how long the CLI runs with no hub attached; a hub's hello clears it. */
  const armHubAbsent = () => {
    clearTimeout(absentTimer);
    if (!alive || finished) return;
    absentTimer = setTimeout(() => {
      if (!alive) return;
      endReason = HUB_ABSENT_TEXT;
      terminate();
    }, spec.hubAbsentMs ?? KEEPER_HUB_ABSENT_MS);
    absentTimer.unref();
  };
  let stdinEnded = false;
  const closeStdin = (graceMs: number) => {
    if (stdinEnded) return;
    stdinEnded = true;
    stdin.end();
    stopTimer = setTimeout(() => {
      if (!alive) return;
      killCli("SIGTERM");
      stopTimer = setTimeout(() => {
        if (alive) killCli("SIGKILL");
      }, graceMs);
    }, graceMs);
  };

  const onClientLine = (c: Client, text: string) => {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m !== "object" || m === null || client !== c) return;
    const msg = m as Json;
    if (msg.t === "hello") {
      if (c.ready) return;
      const from = typeof msg.from === "number" && Number.isFinite(msg.from) ? msg.from : 0;
      c.next = Math.min(Math.max(Math.trunc(from), 0), lineCount);
      c.ready = true;
      everReady = true;
      // what the CLI said on stderr before the first hub came (a start that failed at once)
      for (const text of earlyErrs.splice(0)) send(c, { t: "err", text });
      pump(c);
    } else if (!c.ready) {
      return; // a line before the hello does not count
    } else if (msg.t === "in" && typeof msg.line === "string") {
      if (stdinEnded || !alive) return;
      if (msg.user === true) {
        if (spec.turnEnd === "codex") {
          try {
            const request = JSON.parse(msg.line) as Json | null;
            if (
              request?.method === "turn/start" &&
              (typeof request.id === "string" || typeof request.id === "number")
            ) {
              awaiting = true;
              awaitingId = request.id;
            }
          } catch {
            // Only a turn/start request can start a Codex turn.
          }
        } else awaiting = true;
      }
      stdin.write(`${msg.line}\n`);
    } else if (msg.t === "close") {
      const g = typeof msg.graceMs === "number" && msg.graceMs >= 0 ? msg.graceMs : 0;
      closeStdin(g);
    }
  };

  /** A connection's first line must be a hello with the spec's secret; only then does it replace the client. */
  const authenticate = (c: Client, text: string): boolean => {
    let ok = false;
    try {
      const m: unknown = JSON.parse(text);
      const given = (m as { t?: unknown; secret?: unknown } | null)?.secret;
      if ((m as { t?: unknown } | null)?.t === "hello" && typeof given === "string") {
        const got = Buffer.from(given);
        ok = got.length === expectedSecret.length && timingSafeEqual(got, expectedSecret);
      }
    } catch {
      // not JSON
    }
    if (!ok) {
      c.sock.destroy();
      return false;
    }
    c.authed = true;
    if (client !== null) client.sock.destroy();
    client = c;
    clearTimeout(absentTimer);
    return true;
  };

  const server: Server = createServer((sock) => {
    const c: Client = { sock, authed: false, ready: false, next: 0, pumping: false, buf: "" };
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    const authTimer = setTimeout(() => {
      if (!c.authed) sock.destroy();
    }, AUTH_WAIT_MS);
    authTimer.unref();
    sock.on("close", () => {
      clearTimeout(authTimer);
      if (client !== c) return;
      client = null;
      armHubAbsent();
      // the CLI has gone and the hub with it, before it had everything: exit.json tells the next one
      if (closed !== null) finish();
    });
    sock.on("data", (chunk: string) => {
      c.buf += chunk;
      let nl = c.buf.indexOf("\n");
      while (nl >= 0) {
        const text = c.buf.slice(0, nl);
        c.buf = c.buf.slice(nl + 1);
        if (!c.authed && !authenticate(c, text)) return;
        onClientLine(c, text);
        nl = c.buf.indexOf("\n");
      }
      if (!c.authed && c.buf.length > AUTH_LINE_MAX) sock.destroy();
    });
    const hello: KeeperHello = {
      t: "hello",
      version: KEEPER_PROTOCOL_VERSION,
      spawn: spec.spawn,
      pid: process.pid,
      cliPid,
      lines: lineCount,
      awaiting,
    };
    send(c, hello as unknown as Json);
  });
  server.on("error", (e) => {
    // a keeper nobody can reach must not leave a CLI running: end it, and say why in exit.json
    process.stderr.write(`keeper socket: ${e.message}\n`);
    endReason = `the keeper could not listen: ${e.message}`;
    terminate();
  });
  const socketPath = join(dir, KEEPER_SOCKET);
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    // owner only; the folder is 0700 too
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // the folder's mode still keeps others out
    }
  });

  // --- the CLI's end ---------------------------------------------------------------------------
  /** From the CLI's 'exit', which can come before the last of its output has been read. */
  let exited: { code: number | null; signal: string | null } | null = null;
  /** Set once the CLI's 'close' says all its output is in: only then does the client hear `exit`. */
  let closed: { code: number | null; signal: string | null } | null = null;
  let drainTimer: NodeJS.Timeout | undefined;
  let helloTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let exitSent = false;

  /** Tells the client the CLI is gone (after its last line) and lets the keeper end. */
  const finishWith = (c: Client) => {
    if (exitSent || closed === null) return;
    exitSent = true;
    send(c, { t: "exit", code: closed.code, signal: closed.signal });
    c.sock.end(() => finish());
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(helloTimer);
    clearTimeout(absentTimer);
    server.close();
    rmSync(socketPath, { force: true });
    resolveDone();
  };

  cli.on("exit", (code, signal) => {
    alive = false;
    exited = { code, signal };
    // what the CLI's Bash calls left running goes with it, so a test-lock hold freed at the exit
    // is not still in use
    killCli("SIGTERM");
    drainTimer = setTimeout(() => {
      killCli("SIGKILL");
      stdout.destroy();
      stderr.destroy();
    }, EXIT_DRAIN_MS);
    drainTimer.unref();
  });
  cli.on("close", (code, signal) => {
    alive = false;
    clearTimeout(stopTimer);
    clearTimeout(drainTimer);
    clearTimeout(absentTimer);
    // a line cut off by the exit is kept in the transcript, but never numbered or sent
    if (outBuf !== "") record(outBuf);
    outBuf = "";
    if (errBuf !== "") stderrLine(errBuf);
    errBuf = "";
    try {
      closeSync(fd);
    } catch {
      // nothing is left to write
    }
    closed = exited ?? { code, signal: signal ?? null };
    writeExit(closed.code, closed.signal);
    const c = client as Client | null;
    if (c?.ready) {
      pump(c); // sends what is left, then the exit
    } else if (c === null && everReady) {
      finish(); // no hub is attached: exit.json is what the next one reads
    } else {
      // The first hub has not come, or has not said hello yet (the CLI ended within moments of
      // its start): its hello gets the replay and the exit, within a limit.
      helloTimer = setTimeout(finish, spec.firstHubWaitMs ?? FIRST_HUB_WAIT_MS);
    }
  });

  const terminate = () => {
    if (!alive) return;
    killCli("SIGTERM");
    const t = setTimeout(() => {
      if (alive) killCli("SIGKILL");
    }, spec.stopGraceMs);
    t.unref();
  };

  armHubAbsent();
  return { done, terminate };
}
