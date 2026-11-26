/**
 * A cmux session's repo checks, run by the hub with no agent. When an operator session goes from
 * working to idle with changed files, in a repo the operator turned on, the repo's checks run in
 * its checkout: one check at a time on this Mac, at low priority, stopped after 15 minutes or when
 * the session works again. A failure is sent to the session (`cmux agent message`) and the
 * operator gets one notice. The operator can also run them from the Sessions page.
 * Crew seats never: their push gate already runs checks.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  SESSION_CHECK_TAIL_LINES,
  SESSION_CHECK_TIMEOUT_MS,
  SESSION_CHECKS_SETTING,
  SESSION_UNKNOWN_REPO_TEXT,
  type SessionCheck,
  type SessionCheckResult,
  type SessionRepoChecks,
} from "@mc/core";
import { z } from "zod";
import { RepoRulesError, readRepoBlock } from "../engine/rules.ts";
import { parseJson } from "../json.ts";
import { originRepo } from "../preview/repo.ts";
import { cleanText } from "../repo/clean.ts";
import type { Cmux, CmuxAgent, CmuxWorkspace } from "../runtime/cmux.ts";
import { crewGit } from "../runtime/git.ts";
import { nodeFirstPath } from "../runtime/node-first.ts";
import type { Store } from "../store.ts";
import { checkoutOf, liveAgentOf } from "./sessions.ts";

/** How often the watcher reads cmux while a repo is on or a check is live. */
export const CHECK_WATCH_MS = 3000;
/** Which checks a repo names (its block at origin/HEAD, the hub's config) is read again after this. */
const REPO_CHECKS_CACHE_MS = 60_000;
/** A check's group gets SIGKILL this long after SIGTERM. */
const KILL_GRACE_MS = 5000;
/** The output kept from a check: its tail. */
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** The longest output line a session is sent. */
const LINE_MAX = 300;
/** The longest message a session is sent (cmux's paste limit, as the Sessions page's writes). */
const MESSAGE_MAX = 4000;
/** Changed files a fingerprint reads the size and time of. */
const FINGERPRINT_FILES_MAX = 5000;
/** Who the hub's messages to a session are from. */
const NOTICE_FROM = "Mission Control";
const UNKNOWN_WORKSPACE_TEXT = "No cmux workspace has that id.";

/** The cmux calls the checks make; the Sessions page's client has them all. */
export type ChecksAgent = CmuxAgent;
export type ChecksWorkspace = CmuxWorkspace;
export type ChecksCmux = Pick<Cmux, "ping" | "agents" | "workspaces" | "agentMessage">;

/** A refusal with the HTTP status the API gives it. */
export class SessionChecksError extends Error {
  readonly status: 404;
  constructor(status: 404, message: string) {
    super(message);
    this.name = "SessionChecksError";
    this.status = status;
  }
}

export interface SessionChecksDeps {
  cmux: ChecksCmux;
  store: Store;
  /** The configured seat ids: a workspace named `<seat> · …` is the crew's. */
  seatIds: () => string[];
  /** Crew worktrees, checkouts and the data dir: a checkout inside one is the crew's. */
  crewRoots: () => string[];
  /** The hub config's `rules.checks` for the configured repo with this `owner/name` (lower case). */
  configuredChecks: (github: string) => string[];
  /** One operator notice. */
  notify: (text: string) => void;
  /** What runs each check at low priority; default `lowPriorityPrefix(process.platform)`. */
  lowPriority?: readonly string[];
  /** The Mac's 1-minute load and its cores; a check starts only while load is below cores. */
  load?: () => number;
  cores?: () => number;
  timeoutMs?: number;
  watchMs?: number;
  /** Whether a process is alive; default `kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  now?: () => number;
  log?: (m: string) => void;
}

export interface SessionChecks {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  checkOf(ws: string): SessionCheck | null;
  lastResult(ws: string): SessionCheckResult | null;
  /** The repos of these rows (by main checkout path), each with its switch and checks. */
  repos(rows: readonly { repoKey: string | null }[]): Promise<SessionRepoChecks[]>;
  /** Sets a repo's switch or page commands; only a repo `repos` has seen. */
  setRepo(repo: string, change: { on?: boolean; commands?: string[] }, by: string): void;
  /** The operator's run from the row: the switch and fingerprint are ignored, the crew rule is not. */
  run(ws: string): Promise<"queued" | "no-checks" | "crew">;
}

/** macOS's background policy (throttled CPU and disk); `nice` elsewhere. */
export function lowPriorityPrefix(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["/usr/sbin/taskpolicy", "-b"] : ["nice", "-n", "19"];
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export { checkoutOf, liveAgentOf };

const RepoSetting = z.record(
  z.string(),
  z.object({ on: z.boolean(), commands: z.array(z.string()) }),
);
type RepoSetting = z.infer<typeof RepoSetting>;

interface Fingerprint {
  hash: string;
  clean: boolean;
}

/** The paths in `git status --porcelain=v1 -z` output; a rename's old path is skipped. */
function statusPaths(status: string): string[] {
  const parts = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths;
}

/** A checkout's state: its HEAD, its status and each changed file's size and time. */
async function fingerprintOf(top: string, main: string): Promise<Fingerprint> {
  const common = join(main, ".git");
  const head = await crewGit(
    top,
    ["--no-optional-locks", "rev-parse", "--verify", "-q", "HEAD"],
    common,
  ).catch(() => "");
  const status = await crewGit(
    top,
    // no index refresh: the session's own `git add` or `commit` must never meet our index.lock
    ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    common,
  );
  const hash = createHash("sha256").update(head).update("\0").update(status).update("\0");
  for (const path of statusPaths(status).slice(0, FINGERPRINT_FILES_MAX)) {
    const s = await lstat(join(top, path)).catch(() => null);
    hash.update(s === null ? "-\0" : `${s.size}:${s.mtimeMs}\0`);
  }
  return { hash: hash.digest("hex"), clean: status === "" };
}

/** The process's env for a check: no `MC_*` key, this node first on PATH. */
function checkEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("MC_")),
  ) as NodeJS.ProcessEnv;
  env.PATH = nodeFirstPath(process.execPath, env.PATH ?? "");
  return env;
}

const durationText = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

/** The output's last lines, as inert text, fitted into one message after `head`. */
export function failureMessage(head: string, output: string): string {
  const lines = output.split(/\r?\n/).map((l) => cleanText(l, LINE_MAX));
  while (lines.at(-1)?.trim() === "") lines.pop();
  let last = lines.slice(-SESSION_CHECK_TAIL_LINES);
  while (last[0]?.trim() === "") last = last.slice(1);
  const text = (ls: string[]) =>
    ls.length === 0
      ? `${head} It printed nothing.`
      : `${head} Its last ${ls.length === 1 ? "line" : `${ls.length} lines`}:\n\n${ls.join("\n")}`;
  while (last.length > 0 && text(last).length > MESSAGE_MAX) last = last.slice(1);
  return text(last).slice(0, MESSAGE_MAX);
}

interface Job {
  ws: string;
  name: string;
  top: string;
  main: string;
  why: SessionCheck["why"];
}

type Ending = "timed-out" | "stopped";

export function createSessionChecks(deps: SessionChecksDeps): SessionChecks {
  const { cmux, store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const alive = deps.alive ?? pidAlive;
  const load = deps.load ?? (() => loadavg()[0] ?? 0);
  const cores = deps.cores ?? availableParallelism;
  const prefix = deps.lowPriority ?? lowPriorityPrefix(process.platform);
  const timeoutMs = deps.timeoutMs ?? SESSION_CHECK_TIMEOUT_MS;

  /** Each workspace's lifecycle at the last tick (null: no agent). */
  const lifecycles = new Map<string, ChecksAgent["lifecycle"] | null>();
  /** Each checkout's fingerprint when its checks last ran, or its baseline. */
  const fingerprints = new Map<string, string>();
  const states = new Map<string, SessionCheck>();
  const results = new Map<string, SessionCheckResult>();
  /** Main checkouts `repos` has shown: only these can be set. */
  const known = new Set<string>();
  const named = new Map<
    string,
    { at: number; checks: Promise<{ source: "repo" | "config"; commands: string[] } | null> }
  >();
  const queue: Job[] = [];
  let current: { job: Job; end: (why: Ending) => void; done: Promise<void> } | null = null;
  let ticking: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let loadNoted = false;

  const setting = (): RepoSetting => {
    const parsed = RepoSetting.safeParse(parseJson(store.getSetting(SESSION_CHECKS_SETTING), {}));
    return parsed.success ? parsed.data : {};
  };
  const isOn = (main: string) => setting()[main]?.on === true;

  const setState = (
    ws: string,
    state: SessionCheck["state"],
    command: string | null,
    why: SessionCheck["why"],
  ) => states.set(ws, { state, at: now(), command, why });

  const crewName = (name: string) => deps.seatIds().some((s) => name.startsWith(`${s} · `));
  const crewRootsReal = async () =>
    Promise.all(deps.crewRoots().map((r) => realpath(r).catch(() => resolve(r))));
  const inCrew = async (top: string) => {
    const real = await realpath(top).catch(() => resolve(top));
    return (await crewRootsReal()).some((r) => real === r || real.startsWith(r + sep));
  };

  /** The checks the repo or the hub's config names, read at most once a minute. */
  function namedChecks(main: string) {
    const hit = named.get(main);
    if (hit !== undefined && now() - hit.at < REPO_CHECKS_CACHE_MS) return hit.checks;
    const checks = (async () => {
      // origin/HEAD, never the working copy, which the session itself could edit
      const block = await readRepoBlock(basename(main), main);
      if (block !== null && !(block instanceof RepoRulesError) && (block.checks?.length ?? 0) > 0)
        return { source: "repo" as const, commands: [...(block.checks ?? [])] };
      const github = await originRepo(main);
      const configured = github === null ? [] : deps.configuredChecks(github);
      if (configured.length > 0) return { source: "config" as const, commands: [...configured] };
      return null;
    })().catch(() => null);
    named.set(main, { at: now(), checks });
    return checks;
  }

  async function checksFor(main: string): Promise<Pick<SessionRepoChecks, "source" | "commands">> {
    const fromRepo = await namedChecks(main);
    if (fromRepo !== null) return fromRepo;
    const page = setting()[main]?.commands ?? [];
    return page.length > 0
      ? { source: "page", commands: [...page] }
      : { source: null, commands: [] };
  }

  const queued = (ws: string) => queue.some((j) => j.ws === ws) || current?.job.ws === ws;

  function enqueue(job: Job) {
    if (queued(job.ws)) return;
    queue.push(job);
    setState(job.ws, "queued", null, job.why);
  }

  /** Stops a workspace's queued or running check, with no message or notice. */
  function stopOf(ws: string) {
    const i = queue.findIndex((j) => j.ws === ws);
    if (i >= 0) {
      const [job] = queue.splice(i, 1);
      if (job !== undefined) setState(ws, "stopped", null, job.why);
    }
    if (current?.job.ws === ws) current.end("stopped");
  }

  /** Runs one command in the checkout, in its own process group; resolves when it has exited. */
  function runCommand(
    command: string,
    cwd: string,
    held: { child: ChildProcess | null },
  ): Promise<{ code: number; output: string }> {
    return new Promise((done) => {
      const argv = [...prefix, "/bin/sh", "-c", command];
      let output = "";
      const add = (chunk: Buffer | string) => {
        output += chunk.toString();
        if (output.length > OUTPUT_TAIL_BYTES) output = output.slice(-OUTPUT_TAIL_BYTES);
      };
      let child: ChildProcess;
      try {
        child = spawn(argv[0] as string, argv.slice(1), {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: checkEnv(),
        });
      } catch (e) {
        done({ code: 127, output: String(e) });
        return;
      }
      held.child = child;
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);
      // a command that could not start (a missing program) reads as the shell's "not found"
      let failed = false;
      child.once("error", (e) => {
        failed = true;
        add(`\n${e.message}\n`);
      });
      child.once("close", (code, signal) => {
        held.child = null;
        done({ code: failed ? 127 : (code ?? (signal === null ? 1 : 128)), output });
      });
    });
  }

  /** SIGTERM to the check's process group, SIGKILL after the grace if its leader has not closed. */
  function killGroup(child: ChildProcess | null) {
    const pid = child?.pid;
    if (child === null || pid === undefined) return;
    const send = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // gone already
      }
    };
    send("SIGTERM");
    const kill = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  }

  async function report(
    job: Job,
    ending: "failed" | "timed-out",
    command: string,
    code: number,
    output: string,
  ) {
    const middle =
      ending === "failed"
        ? `\`${command}\` failed with exit code ${code}.`
        : `\`${command}\` was stopped after ${durationText(timeoutMs)}.`;
    const message = failureMessage(
      `Mission Control ran this repo's checks after your last piece of work. ${middle}`,
      output,
    );
    try {
      await cmux.agentMessage(job.ws, message, NOTICE_FROM);
    } catch (e) {
      log(`session checks: could not tell "${job.name}": ${String(e)}`);
    }
    const notice = `Checks ${ending === "failed" ? "failed" : "timed out"} in cmux session "${job.name}": ${command}`;
    deps.notify(notice);
    store.addHubEvent(notice, now());
  }

  async function runJob(
    job: Job,
    ending: { why: Ending | null },
    held: { child: ChildProcess | null },
  ) {
    if (job.why === "idle" && !isOn(job.main)) {
      log(`session checks: "${job.name}"'s repo was turned off; dropped`);
      states.delete(job.ws);
      return;
    }
    const { commands } = await checksFor(job.main);
    if (commands.length === 0) {
      log(`session checks: "${job.name}" has no checks now; dropped`);
      states.delete(job.ws);
      return;
    }
    const start = await fingerprintOf(job.top, job.main).catch(() => null);
    const deadline = setTimeout(() => {
      if (current?.job === job) current.end("timed-out");
    }, timeoutMs);
    try {
      let last = commands[0] as string;
      for (const command of commands) {
        if (ending.why !== null) break;
        last = command;
        setState(job.ws, "running", command, job.why);
        const { code, output } = await runCommand(command, job.top, held);
        if (ending.why !== null) {
          setState(job.ws, ending.why, command, job.why);
          if (ending.why === "timed-out") {
            results.set(job.ws, { ok: false, command, at: now() });
            await report(job, "timed-out", command, code, output);
          }
          break;
        }
        if (code !== 0) {
          setState(job.ws, "failed", command, job.why);
          results.set(job.ws, { ok: false, command, at: now() });
          await report(job, "failed", command, code, output);
          break;
        }
      }
      if (ending.why === null && states.get(job.ws)?.state === "running") {
        setState(job.ws, "passed", last, job.why);
        results.set(job.ws, { ok: true, command: last, at: now() });
      }
      // a stopped check never finished: the next idle runs it again
      if (ending.why !== "stopped" && start !== null) fingerprints.set(job.top, start.hash);
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Starts the next check when none is running and the Mac is not busy. */
  function pump() {
    if (closed || current !== null) return;
    const job = queue[0];
    if (job === undefined) return;
    if (load() >= cores()) {
      if (!loadNoted) log(`session checks: waiting, load ${load().toFixed(1)} of ${cores()} cores`);
      loadNoted = true;
      return;
    }
    loadNoted = false;
    queue.shift();
    const ending: { why: Ending | null } = { why: null };
    const held: { child: ChildProcess | null } = { child: null };
    const run: { job: Job; end: (why: Ending) => void; done: Promise<void> } = {
      job,
      end: (why) => {
        if (ending.why !== null) return;
        ending.why = why;
        if (held.child === null)
          setState(job.ws, why, states.get(job.ws)?.command ?? null, job.why);
        killGroup(held.child);
      },
      done: Promise.resolve(),
    };
    current = run;
    run.done = runJob(job, ending, held)
      .catch((e) => {
        log(`session checks: "${job.name}" failed to run: ${String(e)}`);
        states.delete(job.ws);
      })
      .finally(() => {
        if (current === run) current = null;
        pump();
      });
  }

  async function baseline(top: string, main: string) {
    if (!isOn(main) || fingerprints.has(top)) return;
    const fp = await fingerprintOf(top, main).catch(() => null);
    if (fp !== null && !fingerprints.has(top)) fingerprints.set(top, fp.hash);
  }

  /** A session that went from working to idle: its checks are queued if its checkout changed. */
  async function candidate(ws: ChecksWorkspace, folder: string | null) {
    if (crewName(ws.name) || folder === null) return;
    const co = await checkoutOf(folder);
    if (co === null || !isOn(co.main) || (await inCrew(co.top))) return;
    const fp = await fingerprintOf(co.top, co.main).catch(() => null);
    if (fp === null) return;
    const last = fingerprints.get(co.top);
    if (last === fp.hash) return;
    if (last === undefined && fp.clean) {
      fingerprints.set(co.top, fp.hash);
      return;
    }
    enqueue({ ws: ws.id, name: ws.name, top: co.top, main: co.main, why: "idle" });
  }

  async function watch() {
    pump();
    const live = current !== null || queue.length > 0;
    if (!live && !Object.values(setting()).some((r) => r.on)) {
      lifecycles.clear();
      return;
    }
    if ((await cmux.ping().catch(() => "down")) !== "up") return;
    const [workspaces, agents] = await Promise.all([cmux.workspaces(), cmux.agents()]);
    for (const ws of workspaces) {
      const agent = liveAgentOf(agents, ws.id, alive);
      const life = agent?.lifecycle ?? null;
      const first = !lifecycles.has(ws.id);
      const prev = lifecycles.get(ws.id) ?? null;
      lifecycles.set(ws.id, life);
      const folder = agent?.cwd ?? ws.cwd;
      if (life === "running" && (first || prev !== "running")) {
        // first sight is not starting work: a check already running for it (an operator's run, or
        // one queued before the watcher last saw this session) keeps going
        if (!first) stopOf(ws.id);
        if (folder !== null && !crewName(ws.name)) {
          const co = await checkoutOf(folder);
          if (co !== null) await baseline(co.top, co.main);
        }
      } else if (life === "idle" && !first && prev === "running") {
        await candidate(ws, folder);
      }
    }
    const open = new Set(workspaces.map((w) => w.id));
    for (const id of lifecycles.keys()) if (!open.has(id)) lifecycles.delete(id);
    for (const id of states.keys())
      if (!open.has(id)) {
        stopOf(id);
        states.delete(id);
        results.delete(id);
      }
    pump();
  }

  return {
    start() {
      if (timer !== null || closed) return;
      timer = setInterval(() => void this.tick(), deps.watchMs ?? CHECK_WATCH_MS);
      timer.unref();
    },
    async stop() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const job of queue.splice(0)) setState(job.ws, "stopped", null, job.why);
      const run = current;
      run?.end("stopped");
      await run?.done;
      await ticking;
    },
    tick() {
      if (closed) return Promise.resolve();
      if (ticking !== null) return ticking;
      ticking = watch()
        .catch((e) => log(`session checks: ${String(e)}`))
        .finally(() => {
          ticking = null;
        });
      return ticking;
    },
    checkOf: (ws) => states.get(ws) ?? null,
    lastResult: (ws) => results.get(ws) ?? null,
    async repos(rows) {
      const keys = [...new Set(rows.flatMap((r) => (r.repoKey === null ? [] : [r.repoKey])))];
      for (const k of keys) known.add(k);
      const saved = setting();
      const out = await Promise.all(
        keys.map(async (repo): Promise<SessionRepoChecks> => {
          const { source, commands } = await checksFor(repo);
          return {
            repo,
            name: basename(repo),
            on: saved[repo]?.on === true,
            source,
            commands,
            pageCommands: [...(saved[repo]?.commands ?? [])],
          };
        }),
      );
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
    },
    setRepo(repo, change, by) {
      if (!known.has(repo)) throw new SessionChecksError(404, SESSION_UNKNOWN_REPO_TEXT);
      const all = setting();
      const was = all[repo] ?? { on: false, commands: [] };
      const next = {
        on: change.on ?? was.on,
        commands:
          change.commands === undefined ? was.commands : change.commands.map((c) => c.trim()),
      };
      all[repo] = next;
      store.setSetting(SESSION_CHECKS_SETTING, JSON.stringify(all));
      if (was.on && !next.on) {
        // a repo turned off runs nothing by itself, waiting or started; the operator's own runs stay
        for (let i = queue.length - 1; i >= 0; i--) {
          const job = queue[i] as Job;
          if (job.main !== repo || job.why !== "idle") continue;
          queue.splice(i, 1);
          states.delete(job.ws);
        }
        if (current?.job.main === repo && current.job.why === "idle") current.end("stopped");
      }
      if (next.on !== was.on)
        store.addHubEvent(
          `Checks turned ${next.on ? "on" : "off"} for repo "${basename(repo)}" by ${by}`,
          now(),
        );
    },
    async run(id) {
      const ws = (await cmux.workspaces()).find((w) => w.id.toLowerCase() === id.toLowerCase());
      if (ws === undefined) throw new SessionChecksError(404, UNKNOWN_WORKSPACE_TEXT);
      if (crewName(ws.name)) return "crew";
      const folder = liveAgentOf(await cmux.agents(), ws.id, alive)?.cwd ?? ws.cwd;
      const co = folder === null ? null : await checkoutOf(folder);
      if (co === null) return "no-checks";
      if (await inCrew(co.top)) return "crew";
      known.add(co.main);
      if ((await checksFor(co.main)).commands.length === 0) return "no-checks";
      enqueue({ ws: ws.id, name: ws.name, top: co.top, main: co.main, why: "operator" });
      pump();
      return "queued";
    },
  };
}
