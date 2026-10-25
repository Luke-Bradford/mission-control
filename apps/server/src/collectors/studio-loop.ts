import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type DriverStop, driverStopKey, type Run, type RunDigest, zoneFormatter } from "@mc/core";
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
import { type LaunchctlRunner, type LaunchdJob, launchdJob } from "./launchd.ts";
import { type LiveSession, sessionForLoop } from "./sessions.ts";

export type DriverEvent =
  | { kind: "fire-start"; at: number; fire: number }
  | { kind: "fire-exit"; at: number; fire: number; rc: number }
  | { kind: "quota"; at: number; pct: number }
  | { kind: "quota-reset"; at: number; resetsAt: number }
  | { kind: "stop"; at: number; reason: string };

const TS = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\] (.*)$/;
const FIRE_START = /^=== FIRE (\d+)\b/;
const FIRE_EXIT = /^fire (\d+) exited (-?\d+)\b/;
const QUOTA = /^quota\b.*?\butilization (\d+)%/;
const QUOTA_RESET = /^quota window: resets (\S+)/;
const STOP = /^STOP: (.*)$/;
/** A quota stop's reason starts `7-day quota`; `utilization 88%` or, when unreadable, `reading was 87%`. */
const QUOTA_STOP_REASON = /^7-day quota/;
const STOP_USED = /(?:utilization|reading was) (\d+)%/;
const STOP_LIMIT = /QUOTA_STOP_PCT=(\d+)%/;
/** The driver's own wording is "operator signal open"; "signal issue open" is the documented form. */
const SIGNAL_STOP = /\bsignal(?: issue)? open\b/;
const FIRE_LOG = /^fire\.(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.log$/;

/** Parse driver.log lines. Drift reports, auth probes, shadow quota readings etc. are ignored. */
export function parseDriverLog(lines: string[]): DriverEvent[] {
  const out: DriverEvent[] = [];
  for (const line of lines) {
    const t = TS.exec(line.trimEnd());
    if (!t) continue;
    const at = Date.parse(t[1] as string);
    const body = t[2] as string;
    const start = FIRE_START.exec(body);
    const exit = FIRE_EXIT.exec(body);
    const quota = QUOTA.exec(body);
    const stop = STOP.exec(body);
    const reset = QUOTA_RESET.exec(body);
    if (start) out.push({ kind: "fire-start", at, fire: Number(start[1]) });
    else if (exit) out.push({ kind: "fire-exit", at, fire: Number(exit[1]), rc: Number(exit[2]) });
    else if (quota) out.push({ kind: "quota", at, pct: Number(quota[1]) });
    else if (reset) {
      const resetsAt = Date.parse(reset[1] as string);
      if (!Number.isNaN(resetsAt)) out.push({ kind: "quota-reset", at, resetsAt });
    } else if (stop) out.push({ kind: "stop", at, reason: stop[1] as string });
  }
  return out;
}

/** Offset (ms, local minus UTC) of `tz` at the instant `ms`. */
function zoneOffset(ms: number, tz: string): number {
  const f = zoneFormatter(tz, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  const asUtc = Date.UTC(
    p.year as number,
    (p.month as number) - 1,
    p.day as number,
    p.hour as number,
    p.minute as number,
    p.second as number,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** `fire.YYYYMMDD-HHMMSS.log` is named in `tz` local time; returns UTC epoch ms (NaN if not a fire log). */
export function fireLogStartedAt(fileName: string, tz: string): number {
  const m = FIRE_LOG.exec(fileName);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset when the guess lands on the other side of a DST change.
  let t = local - zoneOffset(local, tz);
  t = local - zoneOffset(t, tz);
  return t;
}

interface Fire {
  fire: number;
  startAt: number;
  exitAt: number | null;
  rc: number | null;
  blocked: boolean;
}

/**
 * The parsed driver.log: fires in file order, the latest non-signal STOP note, and the driver's
 * own stop (the latest non-signal STOP, until a fire starts) with the quota reset time seen since
 * the last fire. `stoppedLast` is true when the latest parsed driver event is a STOP line (signal or not).
 */
interface FireModel {
  fires: Fire[];
  note: string | null;
  stop: DriverStop | null;
  resetsAt: number | null;
  stoppedLast: boolean;
}

const emptyModel = (): FireModel => ({
  fires: [],
  note: null,
  stop: null,
  resetsAt: null,
  stoppedLast: false,
});

function driverStop(e: { at: number; reason: string }, resetsAt: number | null): DriverStop {
  if (!QUOTA_STOP_REASON.test(e.reason)) {
    return { reason: e.reason, at: e.at, quota: null, resumesAt: null };
  }
  const used = STOP_USED.exec(e.reason);
  const limit = STOP_LIMIT.exec(e.reason);
  return {
    reason: e.reason,
    at: e.at,
    quota: {
      usedPct: used ? Number(used[1]) : null,
      stopPct: limit ? Number(limit[1]) : null,
    },
    resumesAt: resetsAt,
  };
}

/** Per-loop incremental driver.log state: bytes consumed so far and the model built from them. */
interface DriverState {
  offset: number;
  model: FireModel;
}

/** Cached fire-log directory listing (epoch second -> file name), valid while the dir mtime holds. */
interface DirCache {
  mtimeMs: number;
  logsBySec: Map<number, string>;
}

/** In-memory collector state (empty after a server restart, which re-parses driver.log once). */
export interface StudioCollectorState {
  transcripts: Map<string, FoldState>;
  /** The digest JSON last written per run id. */
  digests: Map<string, string>;
  drivers: Map<string, DriverState>;
  dirs: Map<string, DirCache>;
}
export const newStudioState = (): StudioCollectorState => ({
  transcripts: new Map(),
  digests: new Map(),
  drivers: new Map(),
  dirs: new Map(),
});
const defaultState = newStudioState();

/**
 * A fire this young counts as running without a live session: the CLI registers its session a
 * moment after the FIRE line, and the scheduler re-reads sessions only every 15 s.
 */
export const SESSION_GRACE_MS = 60_000;
export const NO_SESSION_ERROR = "loop process not running (no live Claude session in its worktree)";
export const jobNotRunningError = (label: string): string =>
  `loop process not running (launchd job ${label} has no process)`;
export const NO_STOP_ERROR = "studio driver not running (no STOP logged)";

/** Max gap between a FIRE line's timestamp and its fire log's (local-time) name. */
const PAIR_TOLERANCE_S = 5;
const HOUR_S = 3600;
/** Recent fires (and stored rows) re-examined on every poll; older ones only when a new line touches them. */
const RECENT_FIRES = 500;

/**
 * Apply driver events to the model. Fire numbers repeat across driver restarts, so an exit closes the
 * most recent still-open start with the same number. A signal STOP marks the latest fire blocked when
 * that fire had ended. `note` is the last non-signal STOP seen since the latest fire started;
 * `stop` is the same STOP with its quota figures and the reset time logged since that fire.
 * Fires changed by these events are added to `touched`.
 */
function applyEvents(model: FireModel, events: DriverEvent[], touched: Set<Fire>): void {
  const { fires } = model;
  for (const e of events) {
    model.stoppedLast = e.kind === "stop";
    if (e.kind === "fire-start") {
      const f: Fire = { fire: e.fire, startAt: e.at, exitAt: null, rc: null, blocked: false };
      fires.push(f);
      touched.add(f);
      model.note = null;
      model.stop = null;
      model.resetsAt = null;
    } else if (e.kind === "quota-reset") {
      model.resetsAt = e.resetsAt;
    } else if (e.kind === "fire-exit") {
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i] as Fire;
        if (f.fire === e.fire && f.exitAt === null) {
          f.exitAt = e.at;
          f.rc = e.rc;
          touched.add(f);
          break;
        }
      }
    } else if (e.kind === "stop") {
      const latest = fires[fires.length - 1];
      if (SIGNAL_STOP.test(e.reason)) {
        if (latest && latest.exitAt !== null) {
          latest.blocked = true;
          touched.add(latest);
        }
      } else {
        if (latest) model.note = `stopped: ${e.reason}`;
        model.stop = driverStop(e, model.resetsAt);
      }
    }
  }
}

/** A run's identity for the change check; `reviewId` is the store's (a collected run has none). */
const sig = ({ reviewId: _reviewId, ...r }: Run): string => JSON.stringify(r);

/**
 * Collect the studio build loop's runs from driver.log + the per-fire stream-json logs. Read-only with
 * respect to the loop's files. driver.log is large (MBs) and append-only: it is parsed once on a fresh
 * collector, then only bytes past the stored offset are read (a truncation re-parses from 0). The fire
 * log directory (hundreds of files) is listed again only when its mtime changes. Transcripts are
 * folded (facts kept in `state`) only for the running fire and fires started in the last 24h
 * (FOLD_WINDOW_MS).
 *
 * Liveness comes from the launchd job's own process. The latest open fire is `running` while the
 * job has one. With the job loaded but no process it is `unknown` and the collector records ok=false,
 * `jobNotRunningError`, even with a live Claude session in the worktree. Only when launchd's answer is
 * unknown does the session check apply: `running` while a live Claude session (`sessions`, the
 * scheduler's latest read of the session registry) has the loop's worktree as its cwd, or within
 * SESSION_GRACE_MS of the fire's start, else `unknown` with NO_SESSION_ERROR (`sessions` null means
 * "not known", e.g. the registry read failed: no check). With no open fire, a job with no process
 * and no STOP line since the last fire records NO_STOP_ERROR; after a STOP no process is normal.
 */
export async function collectStudioLoop(
  loop: AdoptedLoop,
  store: Store,
  tz: string,
  now: number,
  state: StudioCollectorState = defaultState,
  sessions: LiveSession[] | null = null,
  launchctl?: LaunchctlRunner,
): Promise<void> {
  const collector = collectorName("studio-loop", loop.id);
  const noteRow = noteCollectorName(loop.kind, loop.id);
  // Every path writes the note row, so a "launchd job missing" note never outlives the condition.
  let missing: string | null = null;
  try {
    const dir = loop.logsDir;
    if (dir === undefined || !existsSync(dir)) {
      store.setStatus(collector, false, `source missing: ${dir ?? "logsDir not configured"}`);
      store.setStatus(noteRow, true, null);
      return;
    }
    const job = await launchdJob(loop, launchctl);
    missing = job.kind === "missing" ? job.note : null;
    const { note, liveness } = collect(loop, dir, store, tz, now, state, sessions, job);
    store.setStatus(collector, (liveness ?? missing) === null, liveness ?? missing);
    store.setStatus(
      noteRow,
      true,
      missing !== null && note !== null ? `${missing} · ${note}` : (missing ?? note),
    );
  } catch (e) {
    store.setStatus(collector, false, e instanceof Error ? e.message : String(e));
    store.setStatus(noteRow, true, missing);
  }
}

/** Keep the settings row equal to the driver's stop: written when it changes, deleted when none. */
function persistStop(store: Store, loopId: string, stop: DriverStop | null): void {
  const key = driverStopKey(loopId);
  const json = stop === null ? null : JSON.stringify(stop);
  if (store.getSetting(key) === json) return;
  if (json === null) store.deleteSetting(key);
  else store.setSetting(key, json);
}

function logsBySecond(dir: string, tz: string, state: StudioCollectorState): Map<number, string> {
  const mtimeMs = statSync(dir).mtimeMs;
  const cached = state.dirs.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.logsBySec;
  const logsBySec = new Map<number, string>();
  for (const name of readdirSync(dir)) {
    const at = fireLogStartedAt(name, tz);
    if (!Number.isNaN(at)) logsBySec.set(Math.floor(at / 1000), name);
  }
  state.dirs.set(dir, { mtimeMs, logsBySec });
  return logsBySec;
}

function collect(
  loop: AdoptedLoop,
  dir: string,
  store: Store,
  tz: string,
  now: number,
  state: StudioCollectorState,
  sessions: LiveSession[] | null,
  job: LaunchdJob,
): { note: string | null; liveness: string | null } {
  const errors: string[] = [];
  const prevDriver = state.drivers.get(loop.id);
  const log = readAllLines(join(dir, "driver.log"), prevDriver?.offset ?? 0, (e) =>
    errors.push(e instanceof Error ? e.message : String(e)),
  );
  if (errors.length > 0) throw new Error(`driver.log: ${errors[0]}`);
  const driver: DriverState =
    prevDriver && !log.reset ? prevDriver : { offset: 0, model: emptyModel() };
  const touched = new Set<Fire>();
  applyEvents(driver.model, parseDriverLog(log.lines), touched);
  driver.offset = log.next;
  state.drivers.set(loop.id, driver);
  persistStop(store, loop.id, driver.model.stop);
  const { fires } = driver.model;

  const logsBySec = logsBySecond(dir, tz, state);
  const near = (sec: number, accept: (s: number) => boolean) => {
    for (let d = 0; d <= PAIR_TOLERANCE_S; d++) {
      for (const s of d === 0 ? [sec] : [sec + d, sec - d]) {
        const name = logsBySec.get(s);
        if (name && accept(s)) return { name, at: s * 1000 };
      }
    }
    return undefined;
  };
  const pair = (startAt: number): { name: string; at: number } | undefined => {
    const sec = Math.round(startAt / 1000);
    // A name in the hour repeated when DST ends resolves to one of its two instants; the FIRE
    // line may be the other, an hour away. Accept that only across a real offset change.
    const acrossDst = (s: number) => zoneOffset(s * 1000, tz) !== zoneOffset(startAt, tz);
    return near(sec, () => true) ?? near(sec + HOUR_S, acrossDst) ?? near(sec - HOUR_S, acrossDst);
  };

  const stored = new Map(store.runs(loop.id, RECENT_FIRES).map((r) => [r.id, r]));
  const latestIdx = fires.length - 1;
  const latest = fires[latestIdx];
  const open = latest !== undefined && latest.exitAt === null;
  const latestLive =
    job.kind === "running" ||
    (job.kind === "unknown" &&
      (sessions === null ||
        sessionForLoop(sessions, loop) !== null ||
        (latest !== undefined && now - latest.startAt < SESSION_GRACE_MS)));
  // With the job missing the unexited fire is unknown, but its liveness text is the missing note's.
  let liveness: string | null = null;
  if (job.kind === "missing") liveness = null;
  else if (open && !latestLive) {
    liveness =
      job.kind === "not running" ? jobNotRunningError(loop.launchdLabel) : NO_SESSION_ERROR;
  } else if (!open && job.kind === "not running" && fires.length > 0 && !driver.model.stoppedLast) {
    liveness = NO_STOP_ERROR;
  }

  fires.forEach((f, i) => {
    if (i < latestIdx - RECENT_FIRES && !touched.has(f)) return;
    const paired = pair(f.startAt);
    // The latest fire, with no exit and no log yet, is not stored: either its log appears (stamped
    // id) or its exit arrives (`t<sec>` id). Minting a `t` id now would orphan a row later.
    if (!paired && i === latestIdx && f.exitAt === null) return;
    const id = paired
      ? `${loop.id}:${paired.name.slice("fire.".length, -".log".length)}`
      : `${loop.id}:t${Math.floor(f.startAt / 1000)}`;
    const prev = stored.get(id);
    const status: Run["status"] =
      f.exitAt === null
        ? i === latestIdx && latestLive
          ? "running"
          : "unknown"
        : f.blocked
          ? "blocked"
          : f.rc === 0
            ? "ok"
            : "failed";
    const r: Run = {
      id,
      agentId: loop.id,
      repoId: loop.repoId,
      seq: f.fire,
      startedAt: f.startAt,
      endedAt: f.exitAt,
      status,
      sessionId: prev?.sessionId ?? null,
      model: prev?.model ?? null,
      branch: prev?.branch ?? null,
      ticket: prev?.ticket ?? null,
      costUsd: prev?.costUsd ?? null,
      tokens: prev?.tokens ?? null,
      transcriptPath: paired ? join(dir, paired.name) : "",
      prs: prev?.prs ?? [],
      summary: prev?.summary ?? null,
    };
    let transcriptBranch: string | null = null;
    let digest: RunDigest | null = null;
    let folded = false;
    if (r.transcriptPath !== "" && (status === "running" || f.startAt >= now - FOLD_WINDOW_MS)) {
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
    if (!prev || sig(prev) !== sig(r)) store.upsertRun(r, folded);
    if (digest) persistDigest(store, state.digests, r.id, digest);
  });
  pruneFoldState(store, state, now);
  return { note: driver.model.note, liveness };
}
