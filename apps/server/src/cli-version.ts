/**
 * The installed `claude` CLI's version, for the crew rows. Read with `claude --version` off the
 * request path and cached per resolved binary path and mtime, so it runs once per launch and again
 * only after an upgrade. A request that finds nothing cached gets null and starts the probe; the
 * next poll has the answer.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The command that runs the Claude CLI: the version probe and the crew spawn both use it. */
export const CLAUDE_COMMAND = "claude";

const VERSION_TIMEOUT_MS = 2000;
/** How long "not on PATH" stands before PATH is walked again. */
const NOT_FOUND_TTL_MS = 30_000;
/** How long a failed run stands before the binary is probed again (one slow start must not stick). */
const FAILURE_TTL_MS = 60_000;
/** Versions read, per path and mtime. */
const cache = new Map<string, string>();
const failedUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();
const notFoundUntil = new Map<string, number>();

interface Located {
  path: string;
  key: string;
}

/** The first executable named `name` on PATH, else null. */
function resolveOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** `2.1.302` from `2.1.302 (Claude Code)`; null for output that starts otherwise. */
export function parseCliVersion(out: string): string | null {
  return /^\d+(?:\.\d+)+\S*/.exec(out.trim())?.[0] ?? null;
}

/** The binary's path and cache key (path and mtime), or null when it is not on PATH. Never throws. */
function locate(binary: string): Located | null {
  const missKey = `${process.env.PATH ?? ""}\0${binary}`;
  if ((notFoundUntil.get(missKey) ?? 0) > Date.now()) return null;
  try {
    const path = resolveOnPath(binary);
    if (path !== null) return { path, key: `${path}:${statSync(path).mtimeMs}` };
  } catch {
    // vanished between the walk and the stat: treated as not found
  }
  notFoundUntil.set(missKey, Date.now() + NOT_FOUND_TTL_MS);
  return null;
}

/** The answer for this binary without running it: a version, null for a recent failure, else undefined. */
function knownAnswer(key: string): string | null | undefined {
  const version = cache.get(key);
  if (version !== undefined) return version;
  return (failedUntil.get(key) ?? 0) > Date.now() ? null : undefined;
}

function probe({ path, key }: Located, timeoutMs: number): Promise<string | null> {
  const running = inFlight.get(key);
  if (running) return running;
  const p = new Promise<string | null>((resolve) => {
    // SIGKILL: a binary that ignores SIGTERM must not outlive the timeout
    const child = execFile(
      path,
      ["--version"],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
      (err, stdout) => {
        const version = err ? null : parseCliVersion(stdout);
        // a failed run is remembered too: a broken binary must not be probed again on every poll
        if (version === null) failedUntil.set(key, Date.now() + FAILURE_TTL_MS);
        else cache.set(key, version);
        inFlight.delete(key);
        resolve(version);
      },
    );
    child.stdin?.end();
  });
  inFlight.set(key, p);
  return p;
}

/** Runs `claude --version` unless cached, and caches the answer; null on failure. Never rejects. */
export function probeClaudeVersion(
  binary = CLAUDE_COMMAND,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
  const found = locate(binary);
  if (found === null) return Promise.resolve(null);
  const known = knownAnswer(found.key);
  if (known !== undefined) return Promise.resolve(known);
  return probe(found, timeoutMs);
}

/**
 * The cached version of `claude` on PATH. Never blocks and never throws: null while the first
 * probe is running, when the binary is missing, or when it answers oddly.
 */
export function claudeVersion(binary = CLAUDE_COMMAND): string | null {
  const found = locate(binary);
  if (found === null) return null;
  const known = knownAnswer(found.key);
  if (known !== undefined) return known;
  void probe(found, VERSION_TIMEOUT_MS);
  return null;
}
