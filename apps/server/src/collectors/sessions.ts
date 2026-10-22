import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdoptedLoop } from "../config.ts";

/** A running Claude Code CLI process, read from `~/.claude/sessions/<pid>.json`. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: "busy" | "idle" | null;
  name: string;
  alive: boolean;
}

/** Signal 0 checks existence without delivering a signal. EPERM still means the process exists. */
export function defaultIsAlive(pid: number): boolean {
  // kill(0, 0) signals our own process group and kill(-1, 0) signals every process we may
  // signal; both would report "alive" for a corrupt registry entry, so reject them first.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A process's start time as `ps -o lstart=` prints it; null when there is no such process. Throws
 * when `ps` itself could not run (the caller decides what an unreadable answer means).
 */
export type ProcessStartRunner = (pid: number) => string | null;

/** `ps` exits 1 and prints nothing when the pid does not exist. */
const PS_NO_SUCH_PROCESS = 1;
const PS_TIMEOUT_MS = 5_000;

/**
 * `lstart` prints in the local timezone and locale, so `ps` runs with both pinned: a timezone
 * change while the hub runs must not make a live process's start time read as different.
 */
export const PS_ENV = { TZ: "UTC", LC_ALL: "C" } as const;

/** `exec` is a parameter so tests can see how `ps` is invoked. */
export const makeProcessStart =
  (exec: typeof execFileSync = execFileSync): ProcessStartRunner =>
  (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const out = exec("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: PS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...PS_ENV },
      }).trim();
      return out === "" ? null : out;
    } catch (err) {
      // Exit 1 with nothing on stderr is "no such process"; anything else is a failed `ps`.
      const { status, stderr } = err as { status?: unknown; stderr?: unknown };
      if (status === PS_NO_SUCH_PROCESS && String(stderr ?? "").trim() === "") return null;
      throw err;
    }
  };

export const defaultProcessStart: ProcessStartRunner = makeProcessStart();

/**
 * Whether `pid` is still the process first seen under that number. The first sighting records its
 * start time in `starts`; a later one is alive only if the start time is the same, so a pid the OS
 * has reused for another process reads as dead. No process is dead. If `ps` cannot run, the answer
 * falls back to signal 0 (which cannot tell a reused pid).
 */
export function isSameProcessAlive(
  starts: Map<number, string>,
  pid: number,
  startOf: ProcessStartRunner = defaultProcessStart,
): boolean {
  let start: string | null;
  try {
    start = startOf(pid);
  } catch {
    return defaultIsAlive(pid);
  }
  if (start === null) {
    starts.delete(pid);
    return false;
  }
  const recorded = starts.get(pid);
  if (recorded === undefined) starts.set(pid, start);
  return recorded === undefined || recorded === start;
}

interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status?: unknown;
  name?: unknown;
}

function isRawSession(v: unknown): v is RawSession {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    typeof r.sessionId === "string" &&
    typeof r.cwd === "string" &&
    Number.isInteger(r.startedAt) &&
    (r.startedAt as number) >= 0
  );
}

/** Read every `*.json` registry entry in `dir`. Malformed files are skipped; a missing dir yields []. */
export function readSessions(dir: string, isAlive: (pid: number) => boolean): LiveSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRawSession(parsed)) continue;
    sessions.push({
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      status: parsed.status === "busy" || parsed.status === "idle" ? parsed.status : null,
      name: typeof parsed.name === "string" ? parsed.name : "",
      alive: isAlive(parsed.pid),
    });
  }
  return sessions;
}

/** The alive session whose cwd is the loop's worktree, newest startedAt wins. */
export function sessionForLoop(sessions: LiveSession[], loop: AdoptedLoop): LiveSession | null {
  const worktree = resolve(loop.worktree);
  let best: LiveSession | null = null;
  for (const s of sessions) {
    if (!s.alive || resolve(s.cwd) !== worktree) continue;
    if (best === null || s.startedAt > best.startedAt) best = s;
  }
  return best;
}
