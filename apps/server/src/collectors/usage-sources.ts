import { execFile, spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AdoptedLoop } from "../config.ts";
import { foldTranscript, type TranscriptFacts } from "../streamjson.ts";
import { DEFAULT_MAX_AGE_MS, isObj } from "./usage-common.ts";

const execFileAsync = promisify(execFile);

/** Claude usage uses the default Keychain login; Codex usage inherits its CLI environment. */
export function usageProviderEnv(provider: "claude" | "codex"): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (provider === "claude") {
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      delete env[key];
  }
  return env;
}

/** Keychain service holding Claude Code's OAuth credentials (see docs/spikes/2026-10-usage-readers.md). */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";
export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const HTTP_TIMEOUT_MS = 10_000;
const APP_SERVER_TIMEOUT_MS = 20_000;
const MAX_APP_SERVER_BUFFER = 1024 * 1024;
/** Log/rollout files are read from their last TAIL_BYTES only; never whole. */
export const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ROLLOUT_FILES = 50;
/** At most this many transcripts are opened per fallback read (newest first). */
export const MAX_TRANSCRIPT_FILES = 50;

// ---------- Claude primary ----------

/**
 * Token never leaves this function: it is not logged, returned or placed in any error message.
 * Errors are rethrown with fixed text only (a JSON parse error can quote its input).
 */
async function readOauthToken(run: ExecFn): Promise<string> {
  let raw: string;
  try {
    raw = (await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])).stdout;
  } catch {
    throw new Error("keychain: could not read Claude credentials");
  }
  try {
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
      ?.accessToken;
    if (typeof token === "string" && token !== "") return token;
  } catch {
    // fall through to the fixed message
  }
  throw new Error("keychain: Claude credentials have no OAuth access token");
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface FetchUsageDeps {
  exec?: ExecFn;
  fetch?: typeof fetch;
}

export async function fetchUsage(deps: FetchUsageDeps = {}): Promise<unknown> {
  const token = await readOauthToken(deps.exec ?? ((f, a) => execFileAsync(f, a)));
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      redirect: "manual", // never replay the token to a redirect target
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`oauth usage request failed: ${err instanceof Error ? err.name : "error"}`);
  }
  if (!res.ok) throw new Error(`oauth usage request failed: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("oauth usage response was not JSON");
  }
}

// ---------- bounded file reads ----------

/** Last `maxBytes` of a file, starting at a line boundary (a partial first line is dropped). */
export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const text = buf.toString("utf8", 0, got);
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
  } finally {
    closeSync(fd);
  }
}

interface FileInfo {
  path: string;
  mtimeMs: number;
}

function listFiles(dir: string | undefined, match: RegExp): FileInfo[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: FileInfo[] = [];
  for (const name of names) {
    if (!match.test(name)) continue;
    const path = join(dir, name);
    try {
      out.push({ path, mtimeMs: Math.floor(statSync(path).mtimeMs) });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

// ---------- Claude fallback ----------

/**
 * Newest file (by mtime) across all loops' `iteration-*.log` (TA state dir) and `fire.*.log`
 * (studio logs dir) that holds a `rate_limit_event` with `unifiedWindows`; its last such event
 * wins, and each sample's `at` is that file's mtime. Bounded: at most MAX_TRANSCRIPT_FILES files
 * are read, and the scan stops at the first file older than `now - maxAgeMs` (its readings would
 * be stale, so nothing older can be used either).
 */
export function latestTranscriptLimits(
  loops: Pick<AdoptedLoop, "stateDir" | "logsDir">[],
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }: { now?: number; maxAgeMs?: number } = {},
): TranscriptFacts["rateLimits"] {
  const oldest = now - maxAgeMs;
  const files = loops
    .flatMap((l) => [
      listFiles(l.stateDir, /^iteration-.*\.log$/),
      listFiles(l.logsDir, /^fire\..*\.log$/),
    ])
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, MAX_TRANSCRIPT_FILES)) {
    if (f.mtimeMs < oldest) break;
    let text: string;
    try {
      text = readTail(f.path);
    } catch {
      continue;
    }
    const lines = text.split("\n").filter((l) => l.includes('"rate_limit_event"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const facts = foldTranscript(null, [lines[i] as string], f.mtimeMs);
      if (facts.rateLimits.length > 0) return facts.rateLimits;
    }
  }
  return [];
}

// ---------- Codex fallback ----------

function walkRollouts(dir: string, out: FileInfo[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) {
      try {
        out.push({ path: p, mtimeMs: Math.floor(statSync(p).mtimeMs) });
      } catch {
        // vanished
      }
    }
  }
}

/**
 * `{ at, rate_limits }` from the last `token_count` event in the newest rollout that has one,
 * or null. `at` is the event's own timestamp, else the file mtime.
 */
export function latestRollout(root = join(homedir(), ".codex", "sessions")): unknown {
  const files: FileInfo[] = [];
  walkRollouts(root, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, MAX_ROLLOUT_FILES)) {
    let text: string;
    try {
      text = readTail(f.path);
    } catch {
      continue;
    }
    const lines = text.split("\n").filter((l) => l.includes('"token_count"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev: unknown = JSON.parse(lines[i] as string);
        const rl = isObj(ev) && isObj(ev.payload) ? ev.payload.rate_limits : null;
        if (!isObj(rl)) continue;
        const ts =
          isObj(ev) && typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : Number.NaN;
        return { at: Number.isNaN(ts) ? f.mtimeMs : ts, rate_limits: rl };
      } catch {
        // skip unparseable line
      }
    }
  }
  return null;
}

// ---------- Codex primary ----------

const pickWindow = (w: unknown): unknown =>
  isObj(w)
    ? { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt }
    : null;

export interface AppServerDeps {
  spawn?: typeof spawn;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/** Spawns `codex app-server`, handshakes, reads rate limits. Returns only window data (no account or credit ids). */
export function appServer(deps: AppServerDeps = {}): Promise<unknown> {
  const spawnFn = deps.spawn ?? spawn;
  const maxBuffer = deps.maxBufferBytes ?? MAX_APP_SERVER_BUFFER;
  return new Promise((resolve, reject) => {
    const p = spawnFn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: usageProviderEnv("codex"),
    });
    let buf = "";
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("codex app-server timed out")),
      deps.timeoutMs ?? APP_SERVER_TIMEOUT_MS,
    );
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    p.on("error", () => finish(new Error("codex app-server failed to start")));
    p.on("exit", () => finish(new Error("codex app-server exited early")));
    p.stdin.on("error", () => finish(new Error("codex app-server stdin closed")));
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > maxBuffer) return finish(new Error("codex app-server output too large"));
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: unknown;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isObj(m)) continue;
        if (m.id === 1) {
          if (m.error !== undefined) return finish(new Error("codex app-server initialize failed"));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (m.id === 2) {
          if (m.error !== undefined || !isObj(m.result) || !isObj(m.result.rateLimits)) {
            return finish(new Error("codex app-server rate limit read failed"));
          }
          const rl = m.result.rateLimits;
          return finish(null, {
            rateLimits: { primary: pickWindow(rl.primary), secondary: pickWindow(rl.secondary) },
          });
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "mission-control", title: "Mission Control", version: "0.0.0" },
      },
    });
  });
}
