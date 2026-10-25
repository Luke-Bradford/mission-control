import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Run, RunDigest } from "@mc/core";
import type { AdoptedLoop } from "../config.ts";
import type { Store } from "../store.ts";
import {
  applyFacts,
  branchTicket,
  collectorName,
  FOLD_WINDOW_MS,
  type FoldState,
  foldPath,
  noteCollectorName,
  persistDigest,
  pruneFoldState,
  readAllLines,
} from "./common.ts";
import { currentBranch } from "./git-head.ts";
import { type LaunchctlRunner, launchdNote } from "./launchd.ts";
import { isSameProcessAlive, type ProcessStartRunner } from "./sessions.ts";

export { FOLD_WINDOW_MS };

export type LoopLogEvent = "start" | "ok" | "failed" | "blocked";

export interface LoopLogItem {
  seq: number;
  event: LoopLogEvent;
  at: number;
  transcript: string | null;
  rc: number | null;
  /** pid of the ta_loop process the line belongs to, when known (log context or transcript name). */
  pid: number | null;
}

const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (.*)$/;
const PROC_START = /^=== ta_loop start \(.*\bpid=(\d+)/;
const ITER_START = /^--- iteration (\d+) start\b/;
const ITER_OK = /^--- iteration (\d+) OK\b(?:.*?\(transcript: (\S+?)\))?/;
const ITER_FAILED = /^--- iteration (\d+) FAILED rc=(-?\d+)(?:.*?transcript: ([^\s)]+))?/;
const BLOCKED = /^blocked pass\b/;
const TRANSCRIPT_NAME = /^iteration-(\d{8}T\d{6}Z)-(\d+)\.(\d+)\.log$/;

const pidOfTranscript = (name: string | null): number | null => {
  const m = name === null ? null : TRANSCRIPT_NAME.exec(basename(name));
  return m ? Number(m[2]) : null;
};

/**
 * Parse loop.log lines. `=== ta_loop start (pid=N)` lines set the pid carried by later items (the
 * iteration counter restarts with every process). `STOPPING:` and `=== ta_loop exit` lines are not
 * runs and are deliberately ignored. A `blocked pass` item takes the seq/pid of the most recent
 * ended iteration (and is dropped when there is none). `initialPid` seeds the pid context when
 * parsing an incremental chunk.
 */
export function parseLoopLog(lines: string[], initialPid: number | null = null): LoopLogItem[] {
  return parseLoopLogWithPid(lines, initialPid).items;
}

/** As parseLoopLog, also returning the pid context after the last line (even if no item was produced). */
export function parseLoopLogWithPid(
  lines: string[],
  initialPid: number | null = null,
): { items: LoopLogItem[]; pid: number | null } {
  const out: LoopLogItem[] = [];
  let pid = initialPid;
  let lastEnded: { seq: number; pid: number | null } | null = null;
  for (const line of lines) {
    const t = TS.exec(line.trimEnd());
    if (!t) continue;
    const at = Date.parse(t[1] as string);
    const body = t[2] as string;
    const proc = PROC_START.exec(body);
    const start = ITER_START.exec(body);
    const ok = ITER_OK.exec(body);
    const failed = ITER_FAILED.exec(body);
    if (proc) {
      pid = Number(proc[1]);
    } else if (start) {
      out.push({ seq: Number(start[1]), event: "start", at, transcript: null, rc: null, pid });
    } else if (ok) {
      const transcript = ok[2] ?? null;
      const p = pidOfTranscript(transcript) ?? pid;
      out.push({ seq: Number(ok[1]), event: "ok", at, transcript, rc: null, pid: p });
      lastEnded = { seq: Number(ok[1]), pid: p };
    } else if (failed) {
      const transcript = failed[3] ?? null;
      const p = pidOfTranscript(transcript) ?? pid;
      out.push({
        seq: Number(failed[1]),
        event: "failed",
        at,
        transcript,
        rc: Number(failed[2]),
        pid: p,
      });
      lastEnded = { seq: Number(failed[1]), pid: p };
    } else if (BLOCKED.test(body) && lastEnded) {
      out.push({
        seq: lastEnded.seq,
        event: "blocked",
        at,
        transcript: null,
        rc: null,
        pid: lastEnded.pid,
      });
    }
  }
  return { items: out, pid };
}

export interface StatusMd {
  seq: number;
  inFlight: boolean;
  startedAt: number;
  pid: number;
  transcript: string;
}

export function parseStatusMd(text: string): StatusMd | null {
  const iter = /^- iteration: \*\*(\d+)\*\*(.*)$/m.exec(text);
  const started = /^- started: (\S+)/m.exec(text);
  const pid = /^- pid: (\d+)/m.exec(text);
  if (!iter || !started || !pid) return null;
  const startedAt = Date.parse(started[1] as string);
  if (Number.isNaN(startedAt)) return null;
  const transcript = /^- transcript: `([^`]*)`/m.exec(text);
  return {
    seq: Number(iter[1]),
    inFlight: /IN FLIGHT/.test(iter[2] as string),
    startedAt,
    pid: Number(pid[1]),
    transcript: transcript?.[1] ?? "",
  };
}

/** The TA loop's pause sentinel in its state dir; the only file Mission Control writes into a loop. */
export const PAUSE_FILE = "PAUSE";

export function isPaused(loop: AdoptedLoop): boolean {
  return existsSync(join(loop.stateDir, PAUSE_FILE));
}

/** In-memory collector state: transcript facts by path (empty after a server restart). */
export interface TaCollectorState {
  transcripts: Map<string, FoldState>;
  /** The digest JSON last written per run id. */
  digests: Map<string, string>;
  lastPid: Map<string, number | null>;
  /** The start time first seen for each ta_loop pid: a pid seen again with another start is reused. */
  pidStarts: Map<number, string>;
}

export const newTaState = (): TaCollectorState => ({
  transcripts: new Map(),
  digests: new Map(),
  lastPid: new Map(),
  pidStarts: new Map(),
});
const defaultState = newTaState();

const compactTs = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Ids are minted once and then reused: `loop:pid.seq`, or `loop:t<startEpochSeconds>.seq` with no known pid. */
const runId = (loop: AdoptedLoop, pid: number | null, seq: number, startedAt: number): string =>
  pid === null ? `${loop.id}:t${Math.floor(startedAt / 1000)}.${seq}` : `${loop.id}:${pid}.${seq}`;

/** Max start-time difference for treating a log start and a status.md start as the same iteration. */
const SAME_START_MS = 60_000;
const READ_BACK_BYTES = 64 * 1024;

/** Latest `ta_loop start` pid in the (at most 64 KiB) text before `offset`; bounded read. */
function recoverPid(path: string, offset: number): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const start = Math.max(0, offset - READ_BACK_BYTES);
    const len = Math.min(offset, fstatSync(fd).size) - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const got = readSync(fd, buf, 0, len, start);
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = TS.exec((lines[i] as string).trimEnd());
      const m = t ? PROC_START.exec(t[2] as string) : null;
      if (m) return Number(m[1]);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Collect the TA loop's runs from loop.log + status.md (+ transcripts) into the store. Read-only
 * with respect to the loop's files. loop.log is read incrementally via stored offsets; transcript
 * facts live in `state`. Only the in-flight iteration and iterations started in the last 24h
 * (FOLD_WINDOW_MS) get their transcript folded, so older backfilled runs carry no cost/tokens.
 *
 * The status.md IN FLIGHT iteration is `running` only while its ta_loop pid is alive. By default
 * that means the same process as first seen under the pid (`startOf`, `ps -o lstart=`, recorded in
 * `state`), so a reused pid reads as dead; `isAlive` replaces the whole check. A dead pid (the loop was killed mid-iteration and
 * status.md never updated) makes the run `unknown` and records collector status ok=false,
 * `loop process not running (pid N)`.
 */
export async function collectTaLoop(
  loop: AdoptedLoop,
  store: Store,
  now: number,
  state: TaCollectorState = defaultState,
  isAlive?: (pid: number) => boolean,
  launchctl?: LaunchctlRunner,
  startOf?: ProcessStartRunner,
): Promise<void> {
  const alive = isAlive ?? ((pid: number) => isSameProcessAlive(state.pidStarts, pid, startOf));
  const collector = collectorName("ta-loop", loop.id);
  const noteRow = noteCollectorName(loop.kind, loop.id);
  // Every path writes the note row, so a "launchd job missing" note never outlives the condition.
  let missing: string | null = null;
  try {
    if (!existsSync(loop.stateDir)) {
      store.setStatus(collector, false, `source missing: ${loop.stateDir}`);
      store.setStatus(noteRow, true, null);
      return;
    }
    missing = await launchdNote(loop, launchctl);
    const liveness = collect(loop, store, now, state, alive, missing !== null) ?? missing;
    store.setStatus(collector, liveness === null, liveness);
    store.setStatus(noteRow, true, missing);
  } catch (e) {
    store.setStatus(collector, false, e instanceof Error ? e.message : String(e));
    store.setStatus(noteRow, true, missing);
  }
}

/** Returns the liveness error for the in-flight iteration, or null when there is none. */
function collect(
  loop: AdoptedLoop,
  store: Store,
  now: number,
  state: TaCollectorState,
  isAlive: (pid: number) => boolean,
  jobMissing: boolean,
): string | null {
  const logPath = join(loop.stateDir, "loop.log");
  const files = new Map<string, { name: string; pid: number; seq: number }>();
  for (const name of readdirSync(loop.stateDir)) {
    const m = TRANSCRIPT_NAME.exec(name);
    if (m) files.set(m[1] as string, { name, pid: Number(m[2]), seq: Number(m[3]) });
  }
  const findFile = (startedAt: number, seq: number) => {
    const f = files.get(compactTs(startedAt));
    return f && f.seq === seq ? f : undefined;
  };
  const tPath = (name: string) => join(loop.stateDir, basename(name));

  let status: StatusMd | null = null;
  try {
    status = parseStatusMd(readFileSync(join(loop.stateDir, "status.md"), "utf8"));
  } catch {
    status = null;
  }

  const logErrors: string[] = [];
  const storedOffset = store.getOffset(logPath);
  const log = readAllLines(logPath, storedOffset, (e) =>
    logErrors.push(e instanceof Error ? e.message : String(e)),
  );
  // Pid context: carried in memory; recovered by bounded read-back on a cold start; cleared on reset.
  const initialPid = log.reset
    ? null
    : state.lastPid.has(loop.id)
      ? (state.lastPid.get(loop.id) ?? null)
      : storedOffset > 0
        ? recoverPid(logPath, storedOffset)
        : null;
  const parsed = parseLoopLogWithPid(log.lines, initialPid);
  const items = parsed.items;
  state.lastPid.set(loop.id, parsed.pid);

  let stored: Run[] | null = null;
  const storedRuns = () => {
    stored ??= store.runs(loop.id, 500);
    return stored;
  };

  const changed = new Map<string, Run>();
  const open: Run[] = [];
  const ended: Run[] = [];
  const blank = (id: string, seq: number, startedAt: number): Run => ({
    id,
    agentId: loop.id,
    repoId: loop.repoId,
    seq,
    startedAt,
    endedAt: null,
    status: "unknown",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: null,
  });
  const compatible = (r: Run, pid: number | null) =>
    pid === null || r.id === `${loop.id}:${pid}.${r.seq}` || r.id.startsWith(`${loop.id}:t`);
  /**
   * An already-known run for the same iteration (same seq, start within 60 s, pid-compatible): never
   * mint a second id, and never merge two processes' iterations.
   */
  const known = (seq: number, startedAt: number, pid: number | null): Run | undefined =>
    [...changed.values(), ...storedRuns()].find(
      (r) =>
        r.seq === seq && Math.abs(r.startedAt - startedAt) <= SAME_START_MS && compatible(r, pid),
    );
  /** The start time held in a transcript name (`iteration-<YYYYMMDDTHHMMSSZ>-...`), or null. */
  const transcriptStart = (name: string | null): number | null => {
    const m = name === null ? null : TRANSCRIPT_NAME.exec(basename(name));
    const t = m?.[1];
    if (!t) return null;
    const ms = Date.parse(
      `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`,
    );
    return Number.isNaN(ms) ? null : ms;
  };

  /**
   * The known run an end line belongs to: same seq, pid-compatible, started at or before the end,
   * and not ended by an end line (still open, or closed as `unknown` by reconcile). Latest start wins.
   * The copy keeps every existing field so the end line updates the row in place.
   */
  const unfinished = (seq: number, pid: number | null, endAt: number): Run | undefined => {
    const byId = new Map<string, Run>();
    for (const r of [...storedRuns(), ...changed.values()]) byId.set(r.id, r);
    const best = [...byId.values()]
      .filter(
        (r) =>
          r.seq === seq &&
          (r.endedAt === null || r.status === "unknown") &&
          r.startedAt <= endAt &&
          compatible(r, pid),
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return best ? { ...best } : undefined;
  };

  for (const it of items) {
    if (it.event === "start") {
      const f = findFile(it.at, it.seq);
      const pid =
        it.pid ??
        f?.pid ??
        (status && status.seq === it.seq && status.startedAt === it.at ? status.pid : null);
      const existing = known(it.seq, it.at, pid);
      const r = existing
        ? { ...existing, endedAt: null, status: "unknown" as const }
        : blank(runId(loop, pid, it.seq, it.at), it.seq, it.at);
      const name =
        f?.name ??
        (status && status.pid === pid && status.seq === it.seq ? basename(status.transcript) : "");
      if (name) r.transcriptPath = tPath(name);
      changed.set(r.id, r);
      open.push(r);
    } else if (it.event === "ok" || it.event === "failed") {
      let r = [...open].reverse().find((o) => o.seq === it.seq && compatible(o, it.pid));
      if (r) open.splice(open.indexOf(r), 1);
      else {
        const prior = unfinished(it.seq, it.pid, it.at);
        r = prior
          ? { ...prior }
          : blank(
              runId(loop, it.pid, it.seq, it.at),
              it.seq,
              transcriptStart(it.transcript) ?? it.at,
            );
      }
      r.endedAt = it.at;
      r.status = it.event;
      if (it.transcript) r.transcriptPath = tPath(it.transcript);
      else if (r.transcriptPath === "") {
        const f = findFile(r.startedAt, r.seq);
        if (f) r.transcriptPath = tPath(f.name);
      }
      changed.set(r.id, r);
      ended.push(r);
    } else {
      let r = ended.find((e) => e.seq === it.seq && compatible(e, it.pid));
      if (!r) {
        const prior = storedRuns()
          .filter((s) => s.endedAt !== null && (s.status === "ok" || s.status === "failed"))
          .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
        if (prior) r = { ...prior };
      }
      if (r) {
        r.status = "blocked";
        changed.set(r.id, r);
      }
    }
  }

  // The status.md IN FLIGHT iteration is running unless loop.log already shows it ended, or its
  // ta_loop process is gone (then it is unknown, and the collector reports the dead pid).
  let inFlightId: string | null = null;
  let liveness: string | null = null;
  if (status?.inFlight) {
    const byPid = `${loop.id}:${status.pid}.${status.seq}`;
    let r =
      changed.get(byPid) ??
      storedRuns().find((x) => x.id === byPid) ??
      known(status.seq, status.startedAt, status.pid);
    if (!r) r = blank(byPid, status.seq, status.startedAt);
    if (r.endedAt === null) {
      r = changed.get(r.id) ?? { ...r };
      if (r.transcriptPath === "" && status.transcript) r.transcriptPath = tPath(status.transcript);
      if (!jobMissing && isAlive(status.pid)) {
        r.status = "running";
        inFlightId = r.id;
      } else {
        r.status = "unknown";
        if (!jobMissing) liveness = `loop process not running (pid ${status.pid})`;
      }
      changed.set(r.id, r);
    }
  }

  // Reconcile: a stored `running` run that is not the current in-flight iteration was abandoned.
  // A later OK/FAILED line may still update it. Skipped when status.md was unreadable.
  if (status) {
    const everything = [...changed.values(), ...storedRuns()];
    for (const sr of storedRuns()) {
      if (sr.status !== "running" || sr.id === inFlightId) continue;
      const r = changed.get(sr.id) ?? { ...sr };
      if (r.endedAt !== null || r.id === inFlightId) continue;
      const next = everything
        .filter((x) => x.startedAt > r.startedAt)
        .reduce<number | null>((m, x) => (m === null || x.startedAt < m ? x.startedAt : m), null);
      r.status = "unknown";
      r.endedAt = next;
      changed.set(r.id, r);
    }
  }

  for (const r of changed.values()) {
    // `r` is the stored row (or a blank one) with this poll's changes: what is already known.
    let transcriptBranch: string | null = null;
    let digest: RunDigest | null = null;
    let folded = false;
    if (r.transcriptPath !== "" && (r.id === inFlightId || r.startedAt >= now - FOLD_WINDOW_MS)) {
      const facts = foldPath(state.transcripts, r.transcriptPath, undefined, r.vendor);
      if (facts) {
        digest = facts.digest;
        applyFacts(r, facts);
        folded = true;
      }
      transcriptBranch = facts?.branch ?? null;
    }
    // In-flight run whose transcript has no branch yet: the worktree's current branch (file read).
    if (r.status === "running" && transcriptBranch === null)
      r.branch = currentBranch(loop.worktree) ?? r.branch;
    r.ticket = branchTicket(r);
    store.upsertRun(r, folded);
    if (digest) persistDigest(store, state.digests, r.id, digest);
  }

  // A running run whose transcript facts were lost (fresh collector) is re-folded above because
  // the in-flight run is always in `changed`; stored ended runs are never re-read.
  store.setOffset(logPath, log.next);
  pruneFoldState(store, state, now);
  if (logErrors.length > 0) throw new Error(`loop.log: ${logErrors[0]}`);
  return liveness;
}
