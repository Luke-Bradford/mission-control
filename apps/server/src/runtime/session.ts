/**
 * The driver for one crew process: a long-lived `claude -p` speaking stream-json both ways (spike
 * docs/spikes/2026-10-20-runtime-stream-json.md). It writes user lines and control requests to
 * stdin, tees every stdout line to the seat's transcript, and reports typed events. A crew process
 * may misbehave (die mid-line, never answer, print junk): nothing here throws from an event
 * handler or leaves a promise pending once the process is gone.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
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

export type { SessionEvent };

export interface SessionInput {
  /** Default `"claude"`; tests pass `process.execPath` with the fake CLI as the first argument. */
  command?: string;
  args: string[];
  cwd: string;
  /** Every stdout line is appended here (mode 0600 when created). */
  transcriptPath: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults CONTROL_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them. */
  controlTimeoutMs?: number;
  stopGraceMs?: number;
  /** Default the module caps on a partial line; tests shrink them. */
  stdoutLineMax?: number;
  stderrLineMax?: number;
  /** Defaults `writeSync`; tests inject one that writes short. Returns the bytes written. */
  write?: (fd: number, data: Uint8Array) => number;
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
  on(listener: (e: SessionEvent) => void): () => void;
  readonly pid: number | undefined;
  readonly alive: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * After the process exits, how long its pipes may stay open (a grandchild holding them) before
 * they are destroyed, so the exit is always reported.
 */
const EXIT_DRAIN_MS = 1000;

/**
 * The longest partial stdout line kept, in characters (not bytes); a longer one is dropped, never
 * half-written.
 */
const STDOUT_LINE_MAX = 64 * 1024 * 1024;
/** The longest partial stderr line kept, in characters (not bytes); only its last ones are. */
const STDERR_LINE_MAX = 64 * 1024;
const DROPPED_TEXT = "a CLI output line over 64 MiB was dropped";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function startSession(i: SessionInput): CrewSession {
  const controlTimeoutMs = i.controlTimeoutMs ?? CONTROL_TIMEOUT_MS;
  const stopGraceMs = i.stopGraceMs ?? STOP_GRACE_MS;
  const stdoutLineMax = i.stdoutLineMax ?? STDOUT_LINE_MAX;
  const stderrLineMax = i.stderrLineMax ?? STDERR_LINE_MAX;
  const write = i.write ?? ((f: number, d: Uint8Array) => writeSync(f, d));
  const listeners = new Set<(e: SessionEvent) => void>();
  const pending = new Map<string, Pending>();

  const emit = (e: SessionEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // one broken listener must not stop the others, or the stream
      }
    }
  };

  // Written synchronously, so a line is in the file before its event is emitted (a listener may
  // fold the transcript on a result). Opening it throws before anything is spawned.
  const fd = openSync(i.transcriptPath, "a", 0o600);
  let transcriptFailed = false;
  const record = (line: string) => {
    try {
      const bytes = Buffer.from(`${line}\n`);
      for (let done = 0; done < bytes.length; ) {
        const n = write(fd, bytes.subarray(done));
        if (n <= 0) throw new Error("no bytes written");
        done += n;
      }
    } catch (e) {
      if (transcriptFailed) return;
      transcriptFailed = true;
      const text = `transcript write failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ kind: "stderr", text: cleanText(text, STDERR_TEXT_MAX) });
    }
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(i.command ?? CLAUDE_COMMAND, i.args, {
      cwd: i.cwd,
      env: i.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    // Invalid arguments throw here; a missing command or cwd arrives as an 'error' event instead.
    closeSync(fd);
    throw e;
  }
  let alive = child.pid !== undefined;
  /** stdin has been ended by close(): nothing more may be written. */
  let stdinEnded = false;
  let finished = false;
  let inTurn = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  /** The partial line after the last newline, per stream. */
  let outBuf = "";
  let errBuf = "";
  /** Discarding an over-long stdout line up to its next newline. */
  let dropping = false;
  let stopTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });

  // EPIPE after the child died (or any write failure) lands here; the exit path reports it.
  child.stdin.on("error", () => {});

  child.on("error", (e) => {
    // Without a pid the spawn itself failed ('close' follows); otherwise a kill() failed.
    if (child.pid !== undefined) return;
    alive = false;
    emit({
      kind: "stderr",
      text: cleanText(`could not start the CLI: ${e.message}`, STDERR_TEXT_MAX),
    });
  });

  child.on("exit", (code, signal) => {
    alive = false;
    exitInfo = { code, signal };
    drainTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, EXIT_DRAIN_MS);
    drainTimer.unref();
  });

  child.on("close", (code, signal) => {
    finished = true;
    alive = false;
    clearTimeout(stopTimer);
    clearTimeout(drainTimer);
    // A line cut off by the exit is kept, but never parsed: it may be any prefix of an event.
    if (outBuf !== "") record(outBuf);
    outBuf = "";
    if (errBuf !== "") stderrLine(errBuf);
    errBuf = "";
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error("session ended"));
    }
    const info =
      child.pid === undefined
        ? { code: null, signal: null }
        : (exitInfo ?? { code, signal: signal ?? null });
    try {
      closeSync(fd);
    } catch {
      // nothing is left to write
    }
    emit({ kind: "exit", code: info.code, signal: info.signal });
    resolveExit(info.code);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
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
        if (outBuf.length > stdoutLineMax) {
          outBuf = "";
          dropping = true;
          emit({ kind: "stderr", text: DROPPED_TEXT });
        }
        return;
      }
      const line = outBuf + rest.slice(0, nl);
      outBuf = "";
      rest = rest.slice(nl + 1);
      if (line.length > stdoutLineMax) {
        emit({ kind: "stderr", text: DROPPED_TEXT });
        continue;
      }
      record(line);
      stdoutLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errBuf += chunk;
    let nl = errBuf.indexOf("\n");
    while (nl >= 0) {
      stderrLine(errBuf.slice(0, nl).slice(-stderrLineMax));
      errBuf = errBuf.slice(nl + 1);
      nl = errBuf.indexOf("\n");
    }
    if (errBuf.length > stderrLineMax) errBuf = errBuf.slice(-stderrLineMax);
  });

  function stderrLine(line: string): void {
    const text = cleanText(line, STDERR_TEXT_MAX).trim();
    if (text !== "") emit({ kind: "stderr", text });
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

  const writable = () => alive && !stdinEnded && !finished;
  const writeLine = (obj: Json) => {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    send(text) {
      if (!writable()) throw new Error("session ended");
      writeLine({ type: "user", message: { role: "user", content: text } });
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
        }, controlTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        writeLine({ type: "control_request", request_id: id, request: { subtype } });
      });
    },
    close() {
      if (!stdinEnded && !finished) {
        stdinEnded = true;
        child.stdin.end();
        if (alive) {
          stopTimer = setTimeout(() => {
            if (!alive) return;
            child.kill("SIGTERM");
            stopTimer = setTimeout(() => {
              if (alive) child.kill("SIGKILL");
            }, stopGraceMs);
          }, stopGraceMs);
        }
      }
      return exited;
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pid() {
      return child.pid;
    },
    get alive() {
      return alive;
    },
  };
}
