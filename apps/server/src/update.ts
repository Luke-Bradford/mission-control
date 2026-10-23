/**
 * The Update button: brings the hub's own checkout to the latest `main` and restarts the hub.
 *
 * `version()` reads the checkout (branch, uncommitted changes) and how far the SHA the hub started
 * on is behind origin/main, fetching at most once per VERSION_CHECK_MS. `update()` re-checks
 * everything, then runs a fixed command list in the checkout: `git pull --ff-only origin main`,
 * `pnpm install --frozen-lockfile`, and a web build into `apps/web/dist-next` beside the live
 * `dist`, which is swapped in only once the build has succeeded. Any failure leaves the old `dist`
 * serving and the hub running. Counting from the start SHA, not HEAD, means an update that pulled
 * and then failed is not "up to date": the next one skips the pull (unless main has moved again)
 * and installs, builds, swaps and restarts. On success the route answers 202 and then calls `restart()`, which hands over to
 * the hub's shutdown (crew first, then exit 0); launchd's KeepAlive starts it again.
 *
 * When every path changed since the running code is under `apps/web/` or `docs/`, nothing a seat
 * depends on changed: Update skips the crew refusals, swaps the page in and answers `{ swapped }`
 * (200) without restarting; the running SHA becomes the new HEAD.
 *
 * No command takes request input. git runs with hooks and fsmonitor off and none of the server's
 * `GIT_*` settings, like every other git call the server makes.
 */
import { spawn } from "node:child_process";
import { access, appendFile, chmod, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  globMatches,
  PREVIEW_SERVER,
  type SeatSessionRow,
  seatCallSign,
  UP_TO_DATE_MAIN,
  type VersionInfo,
} from "@mc/core";
import { type CcConfig, configuredAgents } from "./config.ts";
import { gitEnv } from "./files.ts";
import { installEnv } from "./runtime/checkouts.ts";
import { SAFE_CONFIG } from "./runtime/git.ts";
import type { Supervisor } from "./runtime/supervisor.ts";

/** How long `GET /api/version` reuses a `git fetch origin main`. */
export const VERSION_CHECK_MS = 10 * 60_000;
/** The least time between two fetch attempts for `POST /api/version/check`. */
export const VERSION_CHECK_FLOOR_MS = 15_000;
/** Every command Update runs (its checks included) is cut off after this. */
export const UPDATE_STEP_TIMEOUT_MS = 5 * 60_000;
/** After the 202, how long before the hub shuts down (the response is on its way first). */
export const UPDATE_EXIT_DELAY_MS = 500;
/** Beside the database: `{MC_DB dir}/update.log`, rewritten by each update, mode 0600. */
export const UPDATE_LOG = "update.log";
/** The web build's output beside the live `dist`, through `MC_WEB_OUTDIR` (apps/web/vite.config.ts). */
export const WEB_OUTDIR_NEXT = "dist-next";
const WEB_OUTDIR = "dist";
const WEB_OUTDIR_PREV = "dist-prev";
const MAIN = "main";
/** A change only under these needs no hub restart: the server serves `apps/web/dist` from disk. */
const WEB_ONLY_PREFIXES = ["apps/web/", "docs/"];
export const UPDATE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The only paths `updates.hub: auto` applies without a person: the page's source and assets, and
 * docs. Everything else (server and core code, roles, any package.json, lockfiles, workspace and
 * build config at any depth) is held for the operator or the controller session to run Update.
 */
export const AUTO_UPDATE_PATHS = [
  "apps/web/src/**",
  "apps/web/public/**",
  "apps/web/index.html",
  "docs/**",
] as const;
/** Whether auto-Update may apply a change to `path`. */
export const autoUpdatePath = (path: string): boolean =>
  AUTO_UPDATE_PATHS.some((g) => globMatches(g, path));

/** What auto-Update held: the commits and the paths in them it will not apply. */
export interface HeldRange {
  commits: string[];
  paths: string[];
}
/** The one Needs-you item for a range auto-Update holds. */
export const HUB_UPDATE_HELD_KEY = "hub-update-held";
/** The 409 `update({ auto: true })` answers for a range that is not all on the allowlist. */
export const HUB_CODE_NEEDS_PERSON =
  "main changes more than the page and docs; a person runs this Update";
const HELD_NAMED = 5;
const named = (xs: readonly string[]) =>
  xs.length > HELD_NAMED
    ? `${xs.slice(0, HELD_NAMED).join(", ")} and ${xs.length - HELD_NAMED} more`
    : xs.join(", ");
export const hubCodeHeldText = (held: HeldRange): string =>
  `Update waits for you: main changes more than the page and docs. Auto-Update leaves that to a person: run Update. Commits: ${named(held.commits)}. Paths: ${named(held.paths)}.`;

export const NOT_ON_MAIN = "not on main";
export const UNCOMMITTED_CHANGES = "the checkout has uncommitted changes";
export const UPDATE_RUNNING = "an update is already running";
export const CREW_STATE_UNREADABLE = "could not read the crew's state";
/** An update that failed outside any named step. */
export const UPDATE_FAILED = "update failed; see update.log";
/** `call` is the seat's call sign (`seatCallSign`). */
export const seatStarting = (call: string) => `${call} is starting`;

/** What a check answers (502) when origin cannot be fetched; `checkedAt` is the last good fetch. */
export const originUnreachable = (checkedAt: number | null) =>
  `Could not reach origin; ${checkedAt === null ? "no earlier check" : `last checked ${new Date(checkedAt).toISOString()}`}.`;

export type UpdateStep = "fetch" | "pull" | "install" | "build" | "swap";
export const updateFailed = (step: UpdateStep) => `update failed at ${step}; see update.log`;

export class UpdateError extends Error {
  readonly status: 409 | 500 | 502;
  /** A 502 from check(): when origin was last fetched, null if never. */
  readonly checkedAt?: number | null;
  /** A 409 from an auto update: the range it left for a person. */
  readonly held?: HeldRange;
  constructor(
    status: 409 | 500 | 502,
    message: string,
    options?: { cause?: unknown; checkedAt?: number | null; held?: HeldRange },
  ) {
    super(message, options);
    this.checkedAt = options?.checkedAt;
    this.held = options?.held;
    this.name = "UpdateError";
    this.status = status;
  }
}

/** Runs `file args` (no shell) and resolves its output; rejects on a non-zero exit or the timeout. */
export type Exec = (
  file: string,
  args: readonly string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

/** On a timeout the step's group gets SIGTERM, then SIGKILL this long after. */
export const UPDATE_KILL_GRACE_MS = 2_000;

/** After a step's process has exited, how long a pipe held open by a stray descendant is waited on. */
export const UPDATE_PIPE_GRACE_MS = 500;

/** Pids of the steps running now; each leads its own process group (`detached`). */
const liveSteps = new Set<number>();
export const liveStepPids = (): number[] => [...liveSteps];

/**
 * SIGKILL every running step's group. `detached` puts a step in a new session, so the terminal's
 * or launchd's signal to the hub no longer reaches it; the hub's exit does this instead.
 */
export function killLiveSteps(): void {
  for (const pid of liveSteps) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  }
}
// synchronous, and also run by the process.exit() calls in shutdown.ts
process.on("exit", killLiveSteps);

/**
 * Like `execFile`, but the step leads its own process group, and a timeout (or an output past
 * UPDATE_MAX_BUFFER) signals that whole group, so a grandchild such as a vite or esbuild worker
 * goes with it. Only `-pid` is ever signalled, and only while the step's process is alive (plus one
 * SIGKILL in its exit handler when it was being killed), so a group id that may have been reused is
 * never signalled. A descendant that left the group but kept the output pipes open is not ours to
 * kill: once the step has exited the pipes are destroyed after UPDATE_PIPE_GRACE_MS so the call
 * still settles. Rejects with `stdout`, `stderr` and `killed`, like execFile.
 */
export const realExec: Exec = (file, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid !== undefined) liveSteps.add(pid);
    let stdout = "";
    let stderr = "";
    let size = 0;
    let killed = false;
    let exited = false;
    let done = false;
    let signalError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals) => {
      if (exited || pid === undefined || pid <= 1) return;
      try {
        process.kill(-pid, signal);
      } catch (e) {
        // kept for the step's close: the leader may still run, so the call must not settle yet
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") signalError ??= e as Error;
      }
    };
    const terminate = () => {
      if (killed) return;
      killed = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), UPDATE_KILL_GRACE_MS);
    };
    const timer = setTimeout(terminate, o.timeoutMs);

    const collect = (which: "out" | "err") => (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > UPDATE_MAX_BUFFER) return terminate();
      if (which === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.setEncoding("utf8").on("data", collect("out"));
    child.stderr?.setEncoding("utf8").on("data", collect("err"));

    function finish(fail: Error | null) {
      if (done) return; // an ENOENT emits error, then close
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(pipeTimer);
      if (fail === null) return resolve({ stdout, stderr });
      reject(Object.assign(fail, { stdout, stderr, killed }));
    }
    child.on("error", (e) => finish(e));
    child.on("exit", () => {
      clearTimeout(killTimer);
      // the leader is gone but a grandchild may have outlived its SIGTERM; this is the last signal
      if (killed) signalGroup("SIGKILL");
      exited = true;
      if (pid !== undefined) liveSteps.delete(pid);
      pipeTimer = setTimeout(
        // after any read already queued has been delivered
        () =>
          setImmediate(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }),
        UPDATE_PIPE_GRACE_MS,
      );
    });
    child.on("close", (code, signal) => {
      if (signalError) return finish(signalError);
      if (code === 0 && !killed) return finish(null);
      const why = killed ? "timed out or output too large" : `exited ${code ?? signal}`;
      finish(new Error(`Command failed: ${[file, ...args].join(" ")} (${why})`));
    });
  });

export interface UpdaterDeps {
  /** The hub's own checkout (`findHubRoot()`). */
  root: string;
  /** HEAD when the hub started (`headSha`): the code running. null: unreadable, HEAD is used. */
  startSha: string | null;
  /** `{MC_DB dir}/update.log`. */
  logPath: string;
  /** Port ≠ DEFAULT_PORT, or `MC_NO_LOOP_WRITES=1`. */
  preview: boolean;
  /** Why the crew blocks an update (a seat starting), or null; never throws. */
  crewRefusal: () => string | null;
  /** The hub's shutdown: stops the crew, the scheduler and the server, then exits 0. */
  exit: () => void;
  /** Default: `realExec`. Tests fake pnpm here. */
  exec?: Exec;
  now?: () => number;
}

export interface Updater {
  version(): Promise<VersionInfo>;
  /** `version()` after a fetch now (shared with one in flight; none inside the floor). */
  check(): Promise<VersionInfo>;
  /**
   * Resolves `{ upToDate }`, `{ restarting }` (then call `restart()`) or `{ swapped }` (a change
   * under apps/web/ and docs/ only: the new page is live, nothing restarts); throws UpdateError.
   */
  update(opts?: {
    auto?: boolean;
  }): Promise<{ upToDate: true } | { restarting: true } | { swapped: true }>;
  /**
   * The commits (`<sha> <subject>`) and changed paths from the running code to origin/main, as of
   * the last fetch; null when they cannot be read.
   */
  changes(): Promise<HeldRange | null>;
  /** Schedules the exit, UPDATE_EXIT_DELAY_MS on. Called once the 202 has been sent. */
  restart(): void;
}

/**
 * `{CALL} is starting` for the first crew seat (config order) that is starting; null when none is.
 * A seat mid-turn does not refuse: its CLI runs under a keeper and keeps working through the
 * restart, and the new hub attaches to it. A start that is still in its checkout or install has no
 * keeper yet, so it does. What the supervisor holds in memory (`busy()`) counts first; the seat
 * rows are read only on a server that holds the crew lock, since another server's seats are not
 * this one's to wait for. Never throws, so `/api/version` never fails on the crew: a row read that
 * fails refuses with CREW_STATE_UNREADABLE.
 */
export function crewRefusal(
  config: CcConfig,
  supervisor: Pick<Supervisor, "status" | "busy">,
  seat: (seatId: string) => SeatSessionRow | null,
): string | null {
  try {
    const busy = new Map(supervisor.busy().map((b) => [b.seatId, b.state]));
    const enabled = supervisor.status().enabled;
    for (const a of configuredAgents(config)) {
      if (a.kind !== "crew") continue;
      const state = busy.get(a.id) ?? (enabled ? seat(a.id)?.state : undefined);
      if (state === "starting") return seatStarting(seatCallSign(a.id));
    }
    return null;
  } catch {
    return CREW_STATE_UNREADABLE;
  }
}

export interface AutoUpdateDeps {
  /** `updates.hub` is `auto`. */
  enabled: boolean;
  updater: Pick<Updater, "check" | "update" | "restart" | "changes">;
  /** Raises (a range) or clears (null) the Needs-you item for a range auto-Update holds. */
  held: (range: HeldRange | null) => void;
  /** Why the hub may not restart now (a seat starting, the test lock held), or null. */
  blocked: () => string | null;
  /** The test lock is held (why), or null. */
  locked: () => string | null;
  /** HEAD of the checkout once Update has pulled. */
  headSha: () => Promise<string | null>;
  /** Writes the Activity line. */
  record: (text: string) => void;
}

export type AutoUpdateResult = "off" | "current" | "waiting" | "updated";

/**
 * `updates.hub: auto`: one check, run by the scheduler every VERSION_CHECK_MS. It applies only a
 * range whose every path is on AUTO_UPDATE_PATHS (the page and docs); anything else is held, with one
 * Needs-you item (`held`), for a person to run Update. `update({ auto: true })` checks the range
 * again after its own fetch and pulls exactly the commit it checked. When origin/main is
 * ahead and nothing Update refuses on applies (the check answers canUpdate; a busy crew is no
 * refusal for a web-only change), and the test lock is free, it runs the same `update()` the route does. The pull, install and build take minutes, so a
 * turn may have started meanwhile: the restart (and the `Updated to <sha> (auto)` line) waits, off
 * the tick, until `blocked()` is null, rechecked every VERSION_CHECK_FLOOR_MS. Anything that stops it (a refusal, the lock, an unreachable origin, a
 * failed step) is "waiting": the next check tries again. Never forces, never throws.
 */
export function createAutoUpdate(deps: AutoUpdateDeps): () => Promise<AutoUpdateResult> {
  return async () => {
    if (!deps.enabled) return "off";
    try {
      const v = await deps.updater.check();
      if (!v.canUpdate) {
        if (v.reason !== UP_TO_DATE_MAIN) return "waiting";
        deps.held(null);
        return "current";
      }
      // only the allowlist goes live without a person; update() checks again after its own fetch
      const range = await deps.updater.changes();
      if (range === null) return "waiting";
      const held = range.paths.filter((p) => !autoUpdatePath(p));
      if (held.length > 0) {
        deps.held({ commits: range.commits, paths: held });
        return "waiting";
      }
      if (deps.locked() !== null) return "waiting"; // update() itself refuses a busy crew unless the change is web-only
      let out: Awaited<ReturnType<Updater["update"]>>;
      try {
        out = await deps.updater.update({ auto: true }); // re-checks every refusal itself
      } catch (e) {
        if (e instanceof UpdateError && e.held !== undefined) deps.held(e.held);
        throw e;
      }
      deps.held(null);
      if ("upToDate" in out) return "current";
      if ("swapped" in out) {
        deps.record(`Updated to ${(await deps.headSha()) ?? "main"} (auto, web only)`);
        return "updated";
      }
      const text = `Updated to ${(await deps.headSha()) ?? "main"} (auto)`;
      const go = () => {
        if (deps.blocked() !== null) {
          setTimeout(go, VERSION_CHECK_FLOOR_MS).unref();
          return;
        }
        deps.record(text);
        deps.updater.restart();
      };
      go();
      return "updated";
    } catch {
      return "waiting";
    }
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// no credential prompt: a remote that wants one fails instead of hanging until the timeout
const gitEnvironment = () => ({ ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0" });

/** HEAD of `root` through the same safe git as Update (main.ts reads it once, at startup). */
export async function headSha(root: string, exec: Exec = realExec): Promise<string | null> {
  try {
    const r = await exec("git", [...SAFE_CONFIG, "rev-parse", "HEAD"], {
      cwd: root,
      env: gitEnvironment(),
      timeoutMs: UPDATE_STEP_TIMEOUT_MS,
    });
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const { root, logPath } = deps;
  const exec = deps.exec ?? realExec;
  const now = deps.now ?? Date.now;
  const web = (dir: string) => join(root, "apps", "web", dir);
  /**
   * What `behind` counts from: the code running, not a HEAD a failed update moved. A web-only
   * update does not restart the hub, so it moves this to the new head.
   */
  let running = deps.startSha;
  const base = () => running ?? "HEAD";

  /** Set from the start of an update until it fails; after a success the hub is going down. */
  let updating = false;
  let fetchTriedAt: number | null = null;
  let checkedAt: number | null = null;
  /** Whether the last fetch attempt succeeded; null before any. */
  let fetchOk: boolean | null = null;
  let fetching: Promise<void> | null = null;

  const git = (args: string[]) =>
    exec("git", [...SAFE_CONFIG, ...args], {
      cwd: root,
      env: gitEnvironment(),
      timeoutMs: UPDATE_STEP_TIMEOUT_MS,
    });
  const gitOut = (args: string[]) => git(args).then((r) => r.stdout.trim());

  /** `git fetch origin main`; resolves whether it succeeded (and records when). */
  async function fetchMain(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    fetchTriedAt = now();
    try {
      await git(["fetch", "origin", MAIN]);
      checkedAt = now();
      fetchOk = true;
      return { ok: true };
    } catch (error) {
      fetchOk = false;
      return { ok: false, error };
    }
  }

  /** At most one fetch per VERSION_CHECK_MS; concurrent callers share one. */
  function cachedFetch(): Promise<void> {
    if (fetching) return fetching;
    if (updating) return Promise.resolve(); // see floorFetch
    if (fetchTriedAt !== null && now() - fetchTriedAt < VERSION_CHECK_MS) return Promise.resolve();
    fetching = fetchMain().then(() => {
      fetching = null;
    });
    return fetching;
  }

  /** A fetch now unless one is in flight (shared), too recent (the floor), or Update is running. */
  function floorFetch(): Promise<void> {
    if (fetching) return fetching;
    if (updating) return Promise.resolve(); // update() fetches for itself; no git beside the pull
    if (fetchTriedAt !== null && now() - fetchTriedAt < VERSION_CHECK_FLOOR_MS) {
      return Promise.resolve();
    }
    fetching = fetchMain().then(() => {
      fetching = null;
    });
    return fetching;
  }

  /**
   * The first reason Update may not run, or null. Reads the checkout; never fetches. `update()`
   * passes `self` because it has already claimed `updating`.
   */
  async function refusal(self = false, crew = true): Promise<string | null> {
    if (deps.preview) return PREVIEW_SERVER;
    if (updating && !self) return UPDATE_RUNNING;
    const branch = await gitOut(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
    if (branch !== MAIN) return NOT_ON_MAIN;
    // untracked files count; a checkout that cannot report fails closed. No optional locks: a
    // status never takes index.lock in the live checkout (where the operator may be running git).
    const status = await gitOut(["--no-optional-locks", "status", "--porcelain"]).catch(() => null);
    if (status !== "") return UNCOMMITTED_CHANGES;
    return crew ? deps.crewRefusal() : null;
  }

  /** The commits and changed paths from the running code to `to`; null when git cannot say. */
  async function changes(to = `origin/${MAIN}`): Promise<HeldRange | null> {
    try {
      // -z and no renames: a file moved out of hub code names both its old and new path
      const [names, log] = await Promise.all([
        gitOut(["diff", "--name-only", "-z", "--no-renames", base(), to]),
        gitOut(["log", "--format=%h %s", `${base()}..${to}`]),
      ]);
      return {
        commits: log.split("\n").filter((l) => l !== ""),
        paths: names.split("\0").filter((p) => p !== ""),
      };
    } catch {
      return null;
    }
  }

  /** Whether every path changed from the running code to origin/main is web or docs; false if unreadable. */
  async function webOnly(): Promise<boolean> {
    const range = await changes();
    if (range === null) return false;
    const { paths } = range;
    return paths.length > 0 && paths.every((p) => WEB_ONLY_PREFIXES.some((x) => p.startsWith(x)));
  }

  /** Commits on origin/main that `from` lacks; null when they cannot be counted. */
  async function behind(from: string): Promise<number | null> {
    try {
      const n = Number(await gitOut(["rev-list", "--count", `${from}..origin/${MAIN}`]));
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  // update.log: a write that fails never stops the update
  const log = (text: string) => appendFile(logPath, text).catch(() => {});
  async function startLog(): Promise<void> {
    try {
      await writeFile(logPath, `update started ${new Date(now()).toISOString()}\n`, {
        mode: 0o600,
      });
      await chmod(logPath, 0o600); // tighten a log that already existed
    } catch {
      // see log()
    }
  }

  const outputOf = (e: unknown) => {
    const x = e as { stdout?: unknown; stderr?: unknown; killed?: boolean };
    return `${String(x?.stdout ?? "")}${String(x?.stderr ?? "")}${x?.killed ? "timed out\n" : ""}`;
  };

  /** Runs one fixed command, logging it and its output; a failure becomes "update failed at …". */
  async function step(
    name: UpdateStep,
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const shown = file === "git" ? args.slice(SAFE_CONFIG.length) : args;
    await log(`\n$ ${[file, ...shown].join(" ")}\n`);
    try {
      const r = await exec(file, args, { cwd: root, env, timeoutMs: UPDATE_STEP_TIMEOUT_MS });
      await log(r.stdout + r.stderr);
    } catch (e) {
      await log(`${outputOf(e)}failed: ${errText(e)}\n`);
      throw new UpdateError(500, updateFailed(name), { cause: e });
    }
  }

  async function build(): Promise<void> {
    const next = web(WEB_OUTDIR_NEXT);
    await rm(next, { recursive: true, force: true });
    try {
      await step("build", "pnpm", ["--filter", "@mc/web", "build"], {
        ...installEnv(root),
        MC_WEB_OUTDIR: WEB_OUTDIR_NEXT,
      });
      try {
        await access(join(next, "index.html"));
      } catch (e) {
        await log(`failed: the build wrote no ${WEB_OUTDIR_NEXT}/index.html\n`);
        throw new UpdateError(500, updateFailed("build"), { cause: e });
      }
    } catch (e) {
      await rm(next, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /** dist → dist-prev, dist-next → dist, then dist-prev removed; put back if the second fails. */
  async function swap(): Promise<void> {
    const [dist, next, prev] = [web(WEB_OUTDIR), web(WEB_OUTDIR_NEXT), web(WEB_OUTDIR_PREV)];
    await log(`\nswap ${WEB_OUTDIR_NEXT} into ${WEB_OUTDIR}\n`);
    try {
      await rm(prev, { recursive: true, force: true });
      let moved = false;
      try {
        await rename(dist, prev);
        moved = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // no dist yet
      }
      try {
        await rename(next, dist);
      } catch (e) {
        if (moved) {
          await rename(prev, dist).catch((x: unknown) =>
            log(`could not put ${WEB_OUTDIR_PREV} back as ${WEB_OUTDIR}: ${errText(x)}\n`),
          );
        }
        throw e;
      }
    } catch (e) {
      await log(`failed: ${errText(e)}\n`);
      throw new UpdateError(500, updateFailed("swap"), { cause: e });
    }
    // the new dist is in place: a leftover dist-prev is only untidy (the next swap clears it)
    await rm(prev, { recursive: true, force: true }).catch((e: unknown) =>
      log(`could not remove ${WEB_OUTDIR_PREV}: ${errText(e)}\n`),
    );
  }

  /**
   * What `version()` and `check()` answer, without fetching. Refusals come first (preview,
   * running, branch, dirty, crew); only a hub free to update reads as up to date: nothing behind
   * on origin/main and HEAD still the SHA it started on (no pulled-but-unrestarted update).
   */
  async function info(): Promise<VersionInfo> {
    const [sha, n, other, head] = await Promise.all([
      running ?? gitOut(["rev-parse", "HEAD"]).catch(() => ""),
      behind(base()),
      refusal(false, false),
      running === null ? Promise.resolve(null) : gitOut(["rev-parse", "HEAD"]).catch(() => null),
    ]);
    // a web-only change waits for no seat
    const reason = other ?? ((await webOnly()) ? null : deps.crewRefusal());
    const current = n === 0 && (running === null || head === running);
    const why = reason ?? (current ? UP_TO_DATE_MAIN : null);
    return { sha, behind: n, checkedAt, canUpdate: why === null, reason: why };
  }

  return {
    async version() {
      if (!deps.preview) await cachedFetch();
      return info();
    },

    async check() {
      if (!deps.preview) {
        await floorFetch();
        // while an update runs nothing was fetched, and the answer is UPDATE_RUNNING anyway
        if (fetchOk === false && !updating)
          throw new UpdateError(502, originUnreachable(checkedAt), { checkedAt });
      }
      return info();
    },

    changes: () => changes(),

    async update(opts) {
      if (updating) throw new UpdateError(409, UPDATE_RUNNING);
      updating = true;
      try {
        const reason = await refusal(true, false); // the crew's turn comes once the change is known
        if (reason !== null) throw new UpdateError(409, reason);
        await startLog();
        if (fetching) await fetching; // a version() fetch in flight: never two at once
        await log(`\n$ git fetch origin ${MAIN}\n`);
        const fetched = await fetchMain();
        if (!fetched.ok) {
          await log(`${outputOf(fetched.error)}failed: ${errText(fetched.error)}\n`);
          throw new UpdateError(500, updateFailed("fetch"), { cause: fetched.error });
        }
        // from the code running, and from the checkout (a failed update may have pulled already)
        const [sinceStart, toPull, head] = await Promise.all([
          behind(base()),
          behind("HEAD"),
          gitOut(["rev-parse", "HEAD"]).catch(() => null),
        ]);
        if (sinceStart === null || toPull === null) {
          await log(`failed: cannot count the commits on origin/${MAIN}\n`);
          throw new UpdateError(500, updateFailed("fetch"));
        }
        const pulledNotRestarted = running !== null && head !== running;
        if (sinceStart === 0 && !pulledNotRestarted) {
          await log("up to date\n");
          updating = false;
          return { upToDate: true };
        }
        // auto: what was fetched is checked, and exactly that commit is pulled below
        let checked: string | null = null;
        if (opts?.auto === true) {
          const [tip, range] = await Promise.all([
            gitOut(["rev-parse", `origin/${MAIN}`]).catch(() => null),
            changes(),
          ]);
          const held = range?.paths.filter((p) => !autoUpdatePath(p));
          if (tip === null || !/^[0-9a-f]{40,64}$/.test(tip) || range === null) {
            await log("failed: cannot read the range auto-Update would apply\n");
            throw new UpdateError(409, HUB_CODE_NEEDS_PERSON);
          }
          if (held !== undefined && held.length > 0) {
            await log(`held for a person: ${held.join(", ")}\n`);
            throw new UpdateError(409, HUB_CODE_NEEDS_PERSON, {
              held: { commits: range.commits, paths: held },
            });
          }
          checked = tip;
        }
        // a web-only change leaves the seats alone: no wait for them, no restart
        const webChange = await webOnly();
        if (!webChange) {
          const busy = deps.crewRefusal();
          if (busy !== null) throw new UpdateError(409, busy);
        }
        if (toPull > 0 && checked !== null) {
          // the commit that was checked, not whatever origin/main is by now
          const tip = await gitOut(["rev-parse", `origin/${MAIN}`]).catch(() => null);
          if (tip !== checked) {
            await log("failed: origin/main moved after the check\n");
            throw new UpdateError(409, HUB_CODE_NEEDS_PERSON);
          }
          await step("pull", "git", [...SAFE_CONFIG, "merge", "--ff-only", checked], {
            ...gitEnvironment(),
          });
        } else if (toPull > 0) {
          await step("pull", "git", [...SAFE_CONFIG, "pull", "--ff-only", "origin", MAIN], {
            ...gitEnvironment(),
          });
        } else {
          await log(`\nHEAD is already origin/${MAIN}'s; not restarted since: no pull\n`);
        }
        await step("install", "pnpm", ["install", "--frozen-lockfile"], installEnv(root));
        await build();
        await swap();
        if (webChange) {
          await log("\ndone; web-only update; not restarting\n");
          if (running !== null) {
            running = (await gitOut(["rev-parse", "HEAD"]).catch(() => null)) ?? running;
          }
          updating = false;
          return { swapped: true };
        }
        await log("\ndone; restarting\n");
        return { restarting: true };
      } catch (e) {
        updating = false;
        if (e instanceof UpdateError) throw e;
        await log(`failed: ${errText(e)}\n`);
        throw new UpdateError(500, UPDATE_FAILED, { cause: e });
      }
    },

    restart() {
      setTimeout(deps.exit, UPDATE_EXIT_DELAY_MS);
    },
  };
}
