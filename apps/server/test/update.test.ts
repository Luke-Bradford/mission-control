import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PREVIEW_SERVER, type SeatSessionRow, UP_TO_DATE_MAIN } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { RepoRulesError } from "../src/engine/rules.ts";
import { TestLock } from "../src/guard/lock.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { CREW_LOCK_FILE, createSupervisor, type SeatBusy } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";
import {
  type AutoUpdateDeps,
  autoUpdatePath,
  CREW_STATE_UNREADABLE,
  createAutoUpdate,
  createHeldUpdateNote,
  createUpdater,
  crewRefusal,
  type Exec,
  HUB_CODE_NEEDS_PERSON,
  HUB_HEAD_OFF_MAIN,
  HUB_INSTALL_NEEDS_PERSON,
  HUB_UPDATE_HELD_KEY,
  headSha,
  hubCodeHeldText,
  killLiveSteps,
  liveStepPids,
  realExec,
  UPDATE_EXIT_DELAY_MS,
  UPDATE_KILL_GRACE_MS,
  UPDATE_MAX_BUFFER,
  UPDATE_PIPE_GRACE_MS,
  UPDATE_RUNNING,
  UPDATE_STEP_TIMEOUT_MS,
  UpdateError,
  type UpdaterDeps,
  VERSION_CHECK_FLOOR_MS,
  VERSION_CHECK_MS,
} from "../src/update.ts";

const execFileP = promisify(execFile);

let dir: string;
let origin: string;
let hub: string;
let dev: string;
let logPath: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
    cwd,
    encoding: "utf8",
  });

/** A commit on origin/main, made from a second clone. */
function upstreamCommit(name: string) {
  writeFileSync(join(dev, name), `${name}\n`);
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", name);
  git(dev, "push", "-q", "origin", "main");
}

/** A commit on origin/main adding the file `path`. */
function upstreamPath(path: string) {
  mkdirSync(dirname(join(dev, path)), { recursive: true });
  upstreamCommit(path);
}

const web = (...p: string[]) => join(hub, "apps", "web", ...p);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-update-")));
  origin = join(dir, "origin.git");
  hub = join(dir, "hub");
  dev = join(dir, "dev");
  logPath = join(dir, "db", "update.log");
  mkdirSync(join(dir, "db"));
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(dev);
  git(dev, "init", "-q", "-b", "main");
  git(dev, "remote", "add", "origin", origin);
  writeFileSync(join(dev, ".gitignore"), "dist/\ndist-next/\ndist-prev/\nnode_modules/\n");
  writeFileSync(join(dev, "a.txt"), "a\n");
  git(dev, "add", "-A");
  git(dev, "commit", "-qm", "init");
  git(dev, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, hub);
  mkdirSync(web("dist"), { recursive: true });
  writeFileSync(web("dist", "index.html"), "old");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  cmd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cwd: string;
}

/**
 * git runs for real (in the temp repos); pnpm is faked: `install` succeeds, `build` writes
 * `$MC_WEB_OUTDIR/index.html` unless `fail` names the step.
 */
function fakeExec(fail: { install?: boolean; build?: boolean } = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, o) => {
    // the git calls' leading `-c` pairs are recorded once, below, not in every command line
    const shown = file === "git" ? args.slice(4) : args;
    calls.push({ cmd: [file, ...shown].join(" "), env: o.env, timeoutMs: o.timeoutMs, cwd: o.cwd });
    if (file === "git") {
      expect(args.slice(0, 4)).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="]);
      return execFileP(file, [...args], { cwd: o.cwd, env: o.env, encoding: "utf8" });
    }
    if (args[0] === "install") {
      if (fail.install) throw Object.assign(new Error("exit 1"), { stdout: "", stderr: "boom" });
      return { stdout: "installed\n", stderr: "" };
    }
    if (fail.build) {
      mkdirSync(join(o.cwd, "apps", "web", "dist-next"), { recursive: true });
      throw Object.assign(new Error("exit 1"), { stdout: "", stderr: "vite: error" });
    }
    const out = join(o.cwd, "apps", "web", String(o.env.MC_WEB_OUTDIR));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), "new");
    return { stdout: "built\n", stderr: "" };
  };
  return { calls, exec };
}

const head = (cwd = hub) => git(cwd, "rev-parse", "HEAD").trim();

/** An updater on `hub` that started at its current HEAD, with the fake exec (or `over.exec`). */
function updater(over: Partial<UpdaterDeps> = {}, fail: Parameters<typeof fakeExec>[0] = {}) {
  const f = fakeExec(fail);
  const exit = vi.fn();
  const u = createUpdater({
    root: hub,
    startSha: head(),
    logPath,
    preview: false,
    crewRefusal: () => null,
    exit,
    exec: f.exec,
    ...over,
  });
  return { u, exit, calls: f.calls, exec: f.exec };
}

const UPDATE_CMDS = [
  "git pull --ff-only origin main",
  "pnpm install --frozen-lockfile",
  "pnpm --filter @mc/web build",
];

describe("version", () => {
  it("reports the start SHA, how far behind origin/main it is, and that it can update", async () => {
    upstreamCommit("b.txt");
    upstreamCommit("c.txt");
    const { u } = updater({ now: () => 1000 });
    const v = await u.version();
    expect(v).toEqual({
      sha: head(),
      behind: 2,
      checkedAt: 1000,
      canUpdate: true,
      reason: null,
    });
  });

  it("says Up to date with main. when current, and not when behind", async () => {
    const { u } = updater();
    expect(await u.version()).toMatchObject({
      behind: 0,
      canUpdate: false,
      reason: "Up to date with main.",
    });
    upstreamCommit("b.txt");
    const fresh = updater({ startSha: head() });
    expect(await fresh.u.version()).toMatchObject({ behind: 1, canUpdate: true, reason: null });
  });

  it("keeps every refusal ahead of up to date", async () => {
    // origin has nothing new and HEAD is the start SHA: each of these would read as up to date
    expect((await updater({ preview: true }).u.version()).reason).toBe(PREVIEW_SERVER);
    for (const reason of ["GUIDO-1 is starting", CREW_STATE_UNREADABLE]) {
      expect((await updater({ crewRefusal: () => reason }).u.version()).reason).toBe(reason);
    }
    writeFileSync(join(hub, "new.txt"), "x\n");
    expect((await updater().u.version()).reason).toBe("the checkout has uncommitted changes");
    rmSync(join(hub, "new.txt"));
    git(hub, "checkout", "-q", "-b", "feature/x");
    expect((await updater().u.version()).reason).toBe("not on main");
  });

  it("is not up to date while HEAD is not the SHA the hub started on", async () => {
    const start = head();
    git(hub, "commit", "-q", "--allow-empty", "-m", "moved on, not restarted");
    const v = await updater({ startSha: start }).u.version();
    expect(v).toMatchObject({ sha: start, behind: 0, canUpdate: true, reason: null });
  });

  it("refuses a dirty checkout, with untracked files counted", async () => {
    writeFileSync(join(hub, "a.txt"), "changed\n");
    expect(await updater().u.version()).toMatchObject({
      canUpdate: false,
      reason: "the checkout has uncommitted changes",
    });
    git(hub, "checkout", "-q", "--", "a.txt");
    writeFileSync(join(hub, "new.txt"), "x\n");
    expect((await updater().u.version()).reason).toBe("the checkout has uncommitted changes");
  });

  it("refuses a branch other than main, and a detached HEAD", async () => {
    git(hub, "checkout", "-q", "-b", "feature/x");
    expect(await updater().u.version()).toMatchObject({
      canUpdate: false,
      reason: "not on main",
    });
    git(hub, "checkout", "-q", "--detach", "main");
    expect((await updater().u.version()).reason).toBe("not on main");
  });

  it("refuses a preview server, and never fetches there", async () => {
    upstreamCommit("b.txt");
    const { u, calls } = updater({ preview: true });
    const v = await u.version();
    expect(v).toMatchObject({ canUpdate: false, reason: PREVIEW_SERVER });
    expect(v.checkedAt).toBeNull();
    expect(calls.map((c) => c.cmd)).not.toContain("git fetch origin main");
  });

  it("a running seat no longer blocks Update; a starting one does", async () => {
    const config = {
      loops: [],
      crew: { sessions: [{ id: "s", repoId: "r", seats: [{ id: "guido-1" }] }] },
    } as unknown as CcConfig;
    const seat = (state: SeatSessionRow["state"]): SeatSessionRow => ({
      seatId: "guido-1",
      runId: "r",
      cliSessionId: null,
      state,
      reason: null,
      worktree: null,
      updatedAt: 0,
    });
    const crew = (state: SeatSessionRow["state"], busy: SeatBusy[] = []) =>
      updater({
        startSha: head(),
        crewRefusal: () =>
          crewRefusal(
            config,
            { status: () => ({ enabled: true, note: null }), busy: () => busy },
            () => seat(state),
          ),
      });
    upstreamCommit("b.txt");
    const ready = { behind: 1, canUpdate: true, reason: null };
    // mid-turn, by its row and by the supervisor's memory of a line it just wrote
    expect(await crew("running").u.version()).toMatchObject(ready);
    expect(await crew("idle", [{ seatId: "guido-1", state: "running" }]).u.version()).toMatchObject(
      ready,
    );
    expect(await crew("starting").u.version()).toMatchObject({
      canUpdate: false,
      reason: "GUIDO-1 is starting",
    });
  });

  it("fetches at most once per VERSION_CHECK_MS", async () => {
    let t = 0;
    const { u, calls } = updater({ now: () => t });
    const fetches = () => calls.filter((c) => c.cmd === "git fetch origin main").length;
    await u.version();
    expect(fetches()).toBe(1);
    t = VERSION_CHECK_MS - 1;
    upstreamCommit("b.txt");
    expect((await u.version()).behind).toBe(0); // cached: not fetched again
    expect(fetches()).toBe(1);
    t = VERSION_CHECK_MS;
    const v = await u.version();
    expect(fetches()).toBe(2);
    expect(v).toMatchObject({ behind: 1, checkedAt: VERSION_CHECK_MS });
  });

  it("keeps the last good checkedAt when a fetch fails", async () => {
    let t = 5;
    const { u } = updater({ now: () => t });
    await u.version();
    git(hub, "remote", "set-url", "origin", join(dir, "gone.git"));
    t = 5 + VERSION_CHECK_MS;
    expect((await u.version()).checkedAt).toBe(5);
  });

  it("shows the SHA the hub started on and counts from it after a pull without a restart", async () => {
    const start = head();
    upstreamCommit("b.txt");
    upstreamCommit("c.txt");
    const { u } = updater({ startSha: start });
    git(hub, "pull", "-q", "--ff-only", "origin", "main"); // HEAD moves; the code running does not
    expect(await u.version()).toMatchObject({ sha: start, behind: 2, canUpdate: true });
  });

  it("reads status without optional locks (never index.lock in the live checkout)", async () => {
    const { u, calls } = updater();
    await u.version();
    expect(calls.map((c) => c.cmd)).toContain("git --no-optional-locks status --porcelain");
    expect(calls.map((c) => c.cmd)).not.toContain("git status --porcelain");
  });

  it("runs git without hooks or the server's GIT_* settings, each command with a 5-minute timeout", async () => {
    const { u, calls } = updater(); // reads the start SHA before the stub
    vi.stubEnv("GIT_DIR", "/nowhere");
    try {
      await u.version();
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.timeoutMs).toBe(UPDATE_STEP_TIMEOUT_MS);
        expect(c.env.GIT_DIR).toBeUndefined();
        expect(c.cwd).toBe(hub);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(UPDATE_STEP_TIMEOUT_MS).toBe(5 * 60_000);
  });
});

describe("check", () => {
  const fetches = (calls: { cmd: string }[]) =>
    calls.filter((c) => c.cmd === "git fetch origin main").length;

  it("fetches now, past the 10-minute throttle, and answers the same info as version()", async () => {
    let t = 0;
    const { u, calls } = updater({ now: () => t });
    await u.version();
    upstreamCommit("b.txt");
    t = VERSION_CHECK_FLOOR_MS; // inside VERSION_CHECK_MS, past the floor
    expect(t).toBeLessThan(VERSION_CHECK_MS);
    const v = await u.check();
    expect(fetches(calls)).toBe(2);
    expect(v).toMatchObject({ behind: 1, checkedAt: t, canUpdate: true, reason: null });
    expect(await u.version()).toEqual(v);
    expect(fetches(calls)).toBe(2);
  });

  it("answers the current info without fetching inside the floor", async () => {
    let t = 0;
    const { u, calls } = updater({ now: () => t });
    await u.check();
    upstreamCommit("b.txt");
    t = VERSION_CHECK_FLOOR_MS - 1;
    expect((await u.check()).behind).toBe(0);
    expect(fetches(calls)).toBe(1);
    t = VERSION_CHECK_FLOOR_MS;
    expect((await u.check()).behind).toBe(1);
    expect(fetches(calls)).toBe(2);
    expect(VERSION_CHECK_FLOOR_MS).toBe(15_000);
  });

  it("counts a failed attempt toward the floor", async () => {
    let t = 0;
    git(hub, "remote", "set-url", "origin", join(dir, "gone.git"));
    const { u, calls } = updater({ now: () => t });
    await expect(u.check()).rejects.toThrow();
    t = 1000;
    await expect(u.check()).rejects.toThrow();
    expect(fetches(calls)).toBe(1);
  });

  it("fails with 502 when the forced fetch fails, and stays failed inside the floor", async () => {
    let t = 1_700_000_000_000;
    const { u, calls } = updater({ now: () => t });
    await u.check(); // a good fetch first: checkedAt is set
    const good = t;
    git(hub, "remote", "set-url", "origin", join(dir, "gone.git"));
    t += VERSION_CHECK_FLOOR_MS;
    const err = await u.check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect((err as UpdateError).status).toBe(502);
    expect((err as UpdateError).message).toBe(
      `Could not reach origin; last checked ${new Date(good).toISOString()}.`,
    );
    expect((err as UpdateError).checkedAt).toBe(good);
    expect(fetches(calls)).toBe(2);
    t += 1000; // inside the floor: no new fetch, the last attempt still failed
    await expect(u.check()).rejects.toMatchObject({ status: 502 });
    expect(fetches(calls)).toBe(2);
    // origin is back: a fetch past the floor succeeds and the check answers 200 again
    git(hub, "remote", "set-url", "origin", origin);
    t += VERSION_CHECK_FLOOR_MS;
    expect(await u.check()).toMatchObject({ checkedAt: t });
    t += 1000;
    expect(await u.check()).toMatchObject({ checkedAt: t - 1000 }); // inside the floor, last ok
  });

  it("says there was no earlier check when none ever succeeded", async () => {
    git(hub, "remote", "set-url", "origin", join(dir, "gone.git"));
    const { u } = updater();
    await expect(u.check()).rejects.toMatchObject({
      status: 502,
      message: "Could not reach origin; no earlier check.",
    });
  });

  it("shares one fetch between concurrent callers, check or version", async () => {
    upstreamCommit("b.txt"); // only a fetch makes this visible
    const { u, calls } = updater({ now: () => 0 });
    const [a, b, c] = await Promise.all([u.check(), u.check(), u.version()]);
    expect(fetches(calls)).toBe(1);
    expect([a.behind, b.behind, c.behind]).toEqual([1, 1, 1]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("never fetches on a preview", async () => {
    upstreamCommit("b.txt");
    const { u, calls } = updater({ preview: true });
    const v = await u.check();
    expect(fetches(calls)).toBe(0);
    expect(v).toMatchObject({
      canUpdate: false,
      reason: PREVIEW_SERVER,
      checkedAt: null,
    });
  });

  it("does not fetch while an update runs", async () => {
    upstreamCommit("b.txt");
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fakeExec();
    let atInstall = false;
    const exec: Exec = async (file, args, o) => {
      if (file === "pnpm" && args[0] === "install") {
        atInstall = true;
        await gate;
      }
      return f.exec(file, args, o);
    };
    let t = 0;
    const { u } = updater({ exec, now: () => t });
    const running = u.update();
    await vi.waitFor(() => expect(atInstall).toBe(true));
    const before = fetches(f.calls);
    t = 10 * VERSION_CHECK_FLOOR_MS;
    const checked = await u.check();
    expect(fetches(f.calls)).toBe(before);
    expect(checked).toMatchObject({ canUpdate: false, reason: UPDATE_RUNNING });
    t = 10 * VERSION_CHECK_MS;
    const read = await u.version(); // the 10-minute cache has lapsed: still no git beside the pull
    expect(fetches(f.calls)).toBe(before);
    expect(read.reason).toBe(UPDATE_RUNNING);
    release();
    await running;
  });
});

describe("update", () => {
  it("answers upToDate when origin/main has nothing new, and runs no step", async () => {
    const { u, calls, exit } = updater();
    expect(await u.update()).toEqual({ upToDate: true });
    expect(calls.map((c) => c.cmd)).not.toContain(UPDATE_CMDS[0]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("fetches afresh, ignoring the version cache", async () => {
    const { u } = updater({ now: () => 0 });
    await u.version();
    upstreamCommit("b.txt");
    expect(await u.update()).toEqual({ restarting: true });
  });

  it("re-checks every condition and refuses with 409 and the reason", async () => {
    const cases: [Partial<UpdaterDeps>, string, () => void][] = [
      [{ preview: true }, PREVIEW_SERVER, () => {}],
      [{}, "not on main", () => git(hub, "checkout", "-q", "-b", "other")],
      [{}, "the checkout has uncommitted changes", () => writeFileSync(join(hub, "x"), "")],
      [{ crewRefusal: () => "GUIDO-1 is starting" }, "GUIDO-1 is starting", () => {}],
    ];
    upstreamCommit("b.txt");
    for (const [over, reason, arrange] of cases) {
      git(hub, "checkout", "-q", "main");
      rmSync(join(hub, "x"), { force: true });
      arrange();
      const { u, calls } = updater(over);
      const e = await u.update().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(UpdateError);
      expect((e as UpdateError).status).toBe(409);
      expect((e as UpdateError).message).toBe(reason);
      expect(calls.map((c) => c.cmd)).not.toContain(UPDATE_CMDS[0]);
    }
  });

  describe("a change under apps/web/ and docs/ only", () => {
    const MID_TURN = "GUIDO-1 is mid-turn";

    it("swaps without a restart or a mid-turn refusal, and the running sha becomes the new head", async () => {
      upstreamPath("apps/web/src/x.txt");
      upstreamPath("docs/y.md");
      const { u, calls, exit } = updater({ crewRefusal: () => MID_TURN });
      expect(await u.update()).toEqual({ swapped: true });
      const cmds = calls.map((c) => c.cmd);
      expect(cmds.filter((c) => UPDATE_CMDS.includes(c))).toEqual(UPDATE_CMDS);
      expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("new");
      expect(readFileSync(logPath, "utf8")).toContain("web-only update; not restarting");
      expect(exit).not.toHaveBeenCalled();
      const v = await u.version();
      expect(v.sha).toBe(head());
      expect(v.behind).toBe(0);
    });

    it("lets check() say canUpdate while a seat is mid-turn", async () => {
      upstreamPath("apps/web/src/x.txt");
      const { u } = updater({ crewRefusal: () => MID_TURN });
      expect(await u.check()).toMatchObject({ canUpdate: true, reason: null });
    });

    it("still refuses a branch other than main", async () => {
      upstreamPath("apps/web/src/x.txt");
      git(hub, "checkout", "-q", "-b", "other");
      const { u } = updater();
      const e = (await u.update().catch((x: unknown) => x)) as UpdateError;
      expect(e.message).toBe("not on main");
    });

    it("refuses mid-turn when a path is under apps/server/", async () => {
      upstreamPath("apps/server/src/x.txt");
      const { u, calls } = updater({ crewRefusal: () => MID_TURN });
      const e = (await u.update().catch((x: unknown) => x)) as UpdateError;
      expect(e).toBeInstanceOf(UpdateError);
      expect([e.status, e.message]).toEqual([409, MID_TURN]);
      expect(calls.map((c) => c.cmd)).not.toContain(UPDATE_CMDS[0]);
      expect((await u.check()).reason).toBe(MID_TURN);
    });

    it("takes today's path for mixed paths", async () => {
      upstreamPath("apps/web/src/x.txt");
      upstreamPath("packages/core/y.ts");
      const busy = updater({ crewRefusal: () => MID_TURN });
      const e = (await busy.u.update().catch((x: unknown) => x)) as UpdateError;
      expect(e.message).toBe(MID_TURN);
      expect(await updater().u.update()).toEqual({ restarting: true });
    });

    it("is recorded by auto update as web only, with no restart", async () => {
      upstreamPath("apps/web/src/x.txt");
      const upd = updater({ crewRefusal: () => MID_TURN });
      const record = vi.fn();
      const restart = vi.spyOn(upd.u, "restart");
      const tick = createAutoUpdate({
        enabled: true,
        updater: upd.u,
        held: vi.fn(),
        blocked: () => MID_TURN,
        locked: () => null,
        headSha: async () => head(),
        record,
      });
      await expect(tick()).resolves.toBe("updated");
      expect(record).toHaveBeenCalledWith(`Updated to ${head()} (auto, web only)`);
      expect(restart).not.toHaveBeenCalled();
    });
  });

  it("runs pull, install, build in order, the build into dist-next, then swaps", async () => {
    upstreamCommit("b.txt");
    const { u, calls, exit } = updater();
    expect(await u.update()).toEqual({ restarting: true });
    const cmds = calls.map((c) => c.cmd);
    const steps = cmds.filter((c) => UPDATE_CMDS.includes(c));
    expect(steps).toEqual(UPDATE_CMDS);
    expect(cmds.indexOf("git fetch origin main")).toBeLessThan(cmds.indexOf(UPDATE_CMDS[0] ?? ""));
    const build = calls.find((c) => c.cmd === UPDATE_CMDS[2]);
    expect(build?.env.MC_WEB_OUTDIR).toBe("dist-next");
    expect(build?.env.CI).toBe("false");
    expect(existsSync(join(hub, "b.txt"))).toBe(true); // pulled
    expect(readdirSync(web()).sort()).toEqual(["dist"]);
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("new");
    expect(exit).not.toHaveBeenCalled(); // only restart() schedules the exit
  });

  it("swaps in a first build when there was no dist", async () => {
    upstreamCommit("b.txt");
    rmSync(web("dist"), { recursive: true });
    expect(await updater().u.update()).toEqual({ restarting: true });
    expect(readdirSync(web())).toEqual(["dist"]);
  });

  it("clears a dist-prev left by an earlier swap", async () => {
    upstreamCommit("b.txt");
    mkdirSync(web("dist-prev"));
    writeFileSync(web("dist-prev", "stale"), "");
    expect(await updater().u.update()).toEqual({ restarting: true });
    expect(readdirSync(web())).toEqual(["dist"]);
  });

  it("a build failure leaves dist untouched, removes dist-next, and answers 500 naming build", async () => {
    upstreamCommit("b.txt");
    const { u, exit } = updater({}, { build: true });
    const e = await u.update().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UpdateError);
    expect((e as UpdateError).status).toBe(500);
    expect((e as UpdateError).message).toBe("update failed at build; see update.log");
    expect(readdirSync(web())).toEqual(["dist"]);
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("old");
    expect(exit).not.toHaveBeenCalled();
    expect(readFileSync(logPath, "utf8")).toContain("vite: error");
  });

  it("a build that writes no index.html fails at build and swaps nothing", async () => {
    upstreamCommit("b.txt");
    const f = fakeExec();
    const exec: Exec = (file, args, o) =>
      file === "pnpm" && args.includes("build")
        ? Promise.resolve({ stdout: "", stderr: "" })
        : f.exec(file, args, o);
    const { u } = updater({ exec });
    const e = (await u.update().catch((x: unknown) => x)) as UpdateError;
    expect(e.message).toBe("update failed at build; see update.log");
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("old");
  });

  it("names the step that failed: pull, install, fetch", async () => {
    upstreamCommit("b.txt");
    const install = updater({}, { install: true });
    expect(((await install.u.update().catch((x: unknown) => x)) as Error).message).toBe(
      "update failed at install; see update.log",
    );
    expect(install.calls.map((c) => c.cmd)).not.toContain(UPDATE_CMDS[2]);

    // diverged: --ff-only refuses
    writeFileSync(join(hub, "local.txt"), "x\n");
    git(hub, "add", "-A");
    git(hub, "commit", "-qm", "local");
    upstreamCommit("c.txt");
    const pull = updater();
    expect(((await pull.u.update().catch((x: unknown) => x)) as Error).message).toBe(
      "update failed at pull; see update.log",
    );

    git(hub, "remote", "set-url", "origin", join(dir, "gone.git"));
    const fetch = updater();
    expect(((await fetch.u.update().catch((x: unknown) => x)) as Error).message).toBe(
      "update failed at fetch; see update.log",
    );
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("old");
  });

  it("installs a lockfile update through the store recorded by node_modules", async () => {
    upstreamCommit("pnpm-lock.yaml");
    mkdirSync(join(hub, "node_modules"));
    writeFileSync(
      join(hub, "node_modules", ".modules.yaml"),
      JSON.stringify({ storeDir: "/interactive/pnpm-store/v11" }),
    );

    const update = updater();
    await expect(update.u.update()).resolves.toEqual({ restarting: true });

    const install = update.calls.find((call) => call.cmd === UPDATE_CMDS[1]);
    expect(install?.env.pnpm_config_store_dir).toBe("/interactive/pnpm-store");
  });

  it("leaves node_modules alone when pnpm says it needs a non-interactive purge", async () => {
    upstreamCommit("pnpm-lock.yaml");
    const fake = fakeExec();
    const exec: Exec = (file, args, options) =>
      file === "pnpm" && args[0] === "install"
        ? Promise.reject(
            Object.assign(new Error("exit 1"), {
              stdout: "",
              stderr: "ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n",
            }),
          )
        : fake.exec(file, args, options);
    const { u } = updater({ exec });

    await expect(u.update()).rejects.toMatchObject({
      status: 409,
      message: HUB_INSTALL_NEEDS_PERSON,
    });
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("old");
  });

  it("writes update.log with each command and its output, mode 0600", async () => {
    upstreamCommit("b.txt");
    writeFileSync(logPath, "an older update\n", { mode: 0o644 });
    await updater().u.update();
    const log = readFileSync(logPath, "utf8");
    for (const c of UPDATE_CMDS) expect(log).toContain(`$ ${c}`);
    expect(log).toContain("installed");
    expect(log).toContain("built");
    expect(log).not.toContain("an older update");
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("refuses a second update while one is running", async () => {
    upstreamCommit("b.txt");
    const { u } = updater();
    const first = u.update();
    const e = (await u.update().catch((x: unknown) => x)) as UpdateError;
    expect(e.status).toBe(409);
    expect(e.message).toBe("an update is already running");
    expect(await first).toEqual({ restarting: true });
    // a restart is pending: still refused
    expect(((await u.update().catch((x: unknown) => x)) as Error).message).toBe(
      "an update is already running",
    );
  });

  it("allows another try after a failed one", async () => {
    upstreamCommit("b.txt");
    const { u } = updater({}, { install: true });
    await u.update().catch(() => {});
    expect((await u.version()).canUpdate).toBe(true);
  });
});

describe("update after an earlier one failed past the pull", () => {
  it("a build that failed is retried without a pull: install, build, swap, restart", async () => {
    const start = head();
    upstreamCommit("b.txt");
    const first = updater({ startSha: start }, { build: true });
    await first.u.update().catch(() => {});
    expect(head()).not.toBe(start); // pulled, but the hub never restarted
    expect((await first.u.version()).behind).toBe(1);
    const retry = updater({ startSha: start });
    expect(await retry.u.update()).toEqual({ restarting: true });
    const steps = retry.calls.map((c) => c.cmd).filter((c) => UPDATE_CMDS.includes(c));
    expect(steps).toEqual(UPDATE_CMDS.slice(1));
    expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("new");
    expect(readdirSync(web())).toEqual(["dist"]);
  });

  it("still pulls when main has moved on since (the fix landed)", async () => {
    const start = head();
    upstreamCommit("b.txt");
    await updater({ startSha: start }, { build: true })
      .u.update()
      .catch(() => {});
    upstreamCommit("fix.txt");
    const retry = updater({ startSha: start });
    expect(await retry.u.update()).toEqual({ restarting: true });
    expect(retry.calls.map((c) => c.cmd).filter((c) => UPDATE_CMDS.includes(c))).toEqual(
      UPDATE_CMDS,
    );
    expect(existsSync(join(hub, "fix.txt"))).toBe(true);
  });
});

describe("update: the fetch and the swap", () => {
  it("waits for a version() fetch in flight before fetching (never two at once)", async () => {
    upstreamCommit("b.txt");
    const f = fakeExec();
    let inFlight = 0;
    let most = 0;
    const exec: Exec = async (file, args, o) => {
      const isFetch = args.includes("fetch");
      if (isFetch) most = Math.max(most, ++inFlight);
      try {
        return await f.exec(file, args, o);
      } finally {
        if (isFetch) inFlight--;
      }
    };
    const { u } = updater({ exec });
    const v = u.version();
    expect(await u.update()).toEqual({ restarting: true });
    await v;
    expect(most).toBe(1);
    expect(f.calls.filter((c) => c.cmd === "git fetch origin main")).toHaveLength(2);
  });

  it("fails at fetch when origin/main cannot be counted after a good fetch", async () => {
    upstreamCommit("b.txt");
    const f = fakeExec();
    const exec: Exec = (file, args, o) =>
      args.includes("rev-list") ? Promise.reject(new Error("bad ref")) : f.exec(file, args, o);
    const e = (await updater({ exec })
      .u.update()
      .catch((x: unknown) => x)) as UpdateError;
    expect(e.status).toBe(500);
    expect(e.message).toBe("update failed at fetch; see update.log");
    expect(f.calls.map((c) => c.cmd)).not.toContain(UPDATE_CMDS[0]);
  });

  it("logs a dist-prev it cannot remove after a good swap, and still restarts", async () => {
    upstreamCommit("b.txt");
    const locked = web("dist", "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "f"), "");
    chmodSync(locked, 0o500); // its file cannot be removed
    try {
      expect(await updater().u.update()).toEqual({ restarting: true });
      expect(readFileSync(web("dist", "index.html"), "utf8")).toBe("new");
      expect(readFileSync(logPath, "utf8")).toMatch(/could not remove dist-prev: .*EACCES/);
    } finally {
      chmodSync(web("dist-prev", "locked"), 0o700);
    }
  });
});

describe("headSha", () => {
  it("reads HEAD through the safe git", async () => {
    const { exec, calls } = fakeExec();
    expect(await headSha(hub, exec)).toBe(head());
    expect(calls.map((c) => c.cmd)).toEqual(["git rev-parse HEAD"]);
  });

  it("is null when HEAD cannot be read", async () => {
    expect(await headSha(join(dir, "nowhere"), fakeExec().exec)).toBeNull();
  });
});

describe("restart", () => {
  it("calls exit once, UPDATE_EXIT_DELAY_MS after it is asked", () => {
    vi.useFakeTimers();
    const { u, exit } = updater();
    u.restart();
    vi.advanceTimersByTime(UPDATE_EXIT_DELAY_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(UPDATE_EXIT_DELAY_MS).toBe(500);
  });
});

describe("crewRefusal", () => {
  const config = {
    loops: [],
    crew: {
      sessions: [
        { id: "s", repoId: "r", seats: [{ id: "guido-1" }, { id: "guido-2" }] },
        { id: "t", repoId: "r", seats: [{ id: "eva-1" }] },
      ],
    },
  } as unknown as CcConfig;
  const row = (state: SeatSessionRow["state"]): SeatSessionRow => ({
    seatId: "x",
    runId: "r",
    cliSessionId: null,
    state,
    reason: null,
    worktree: null,
    updatedAt: 0,
  });
  /** A supervisor as crewRefusal reads it: its lock state and what it holds in memory. */
  const sup = (enabled: boolean, busy: SeatBusy[] = []) => ({
    status: () => ({ enabled, note: null }),
    busy: () => busy,
  });

  it("names the first starting seat by its call sign, and not a running one", () => {
    const states: Record<string, SeatSessionRow | null> = {
      "guido-1": row("idle"),
      "guido-2": row("starting"),
      "eva-1": row("running"),
    };
    expect(crewRefusal(config, sup(true), (id) => states[id] ?? null)).toBe("GUIDO-2 is starting");
    states["guido-2"] = null;
    expect(crewRefusal(config, sup(true), (id) => states[id] ?? null)).toBeNull();
  });

  it("is null when no seat is starting, or there is no crew", () => {
    for (const st of ["idle", "running", "parked", "stopped", "error"] as const) {
      expect(crewRefusal(config, sup(true), () => row(st))).toBeNull();
    }
    const none = { loops: [] } as unknown as CcConfig;
    expect(crewRefusal(none, sup(true), () => row("starting"))).toBeNull();
  });

  it("names a start the supervisor holds in memory, before its row; a line not yet a turn is no refusal", () => {
    const idle = () => row("idle");
    expect(crewRefusal(config, sup(true, [{ seatId: "guido-2", state: "starting" }]), idle)).toBe(
      "GUIDO-2 is starting",
    );
    expect(
      crewRefusal(config, sup(true, [{ seatId: "eva-1", state: "running" }]), idle),
    ).toBeNull();
  });

  it("reads no seat row on a server that does not hold the crew lock", () => {
    const seat = vi.fn(() => row("running"));
    expect(crewRefusal(config, sup(false), seat)).toBeNull();
    expect(seat).not.toHaveBeenCalled();
  });

  it("never throws: a row read that fails refuses with a fixed text", () => {
    const seat = () => {
      throw new Error("database is locked");
    };
    expect(crewRefusal(config, sup(true), seat)).toBe(CREW_STATE_UNREADABLE);
  });
});

describe("the crew check against a real supervisor", () => {
  /** A supervisor on `dir/crew` whose lock another live process holds (pid 1, launchd). */
  function lockedOut() {
    const worktrees = join(dir, "crew");
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(worktrees, CREW_LOCK_FILE), "1\n");
    const cfg = {
      operator: { id: "op", timezone: "Europe/London" },
      accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
      repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
      loops: [],
      poll: { usageMinutes: 30, githubSeconds: 60 },
      crew: {
        worktrees,
        maxSeats: 8,
        sessions: [
          {
            id: "mc",
            repoId: "mc",
            checkout: join(dir, "clone"),
            seats: [
              { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "haiku", area: [] },
            ],
          },
        ],
      },
    } as CcConfig;
    const store = new Store(join(dir, "db", "mc.sqlite"));
    const supervisor = createSupervisor({
      config: cfg,
      store,
      bus: new ChangeBus(),
      dbPath: join(dir, "db", "mc.sqlite"),
      rules: async () => new RepoRulesError("not read"),
      login: () => null,
      fetchTicket: async () => null,
      enabled: true,
      log: () => {},
      tokens: new RunTokens(),
      lock: new TestLock(),
      hubPort: 7431,
      hubRoot: dir,
    });
    return { cfg, store, supervisor };
  }

  it("version and update never fail on a supervisor that lost or never held the lock", async () => {
    const { cfg, store, supervisor } = lockedOut();
    const check = () => crewRefusal(cfg, supervisor, (id) => store.seatSession(id));
    // never held: the window between listen and start()
    expect((await updater({ crewRefusal: check }).u.version()).reason).toBe(UP_TO_DATE_MAIN);
    supervisor.start();
    expect(supervisor.status()).toEqual({ enabled: false, note: "crew lock held by pid 1" });
    const { u } = updater({ crewRefusal: check });
    expect(await u.version()).toMatchObject({ canUpdate: false, reason: UP_TO_DATE_MAIN });
    expect(await u.update()).toEqual({ upToDate: true });
  });
});

describe("realExec", () => {
  const TEST_MS = 15_000;
  const kill0 = process.kill.bind(process); // the real one, before any spy
  const alive = (pid: number) => {
    try {
      kill0(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // ignores SIGTERM; the lifetime cap means a failed test cannot leave it running for good
  const GRANDCHILD = "process.on('SIGTERM',()=>{});setTimeout(()=>{},20000)";
  const LONG = "setTimeout(()=>{},20000)";

  let d: string;
  const strays: number[] = [];
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "mc-exec-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // only pids still expected to be alive; 0 or 1 would signal far more than a stray
    for (const pid of strays.splice(0)) {
      if (Number.isSafeInteger(pid) && pid > 1 && alive(pid)) kill0(pid, "SIGKILL");
    }
    rmSync(d, { recursive: true, force: true });
  });

  const run = (script: string, timeoutMs = 10_000) =>
    realExec(process.execPath, ["-e", script], { cwd: d, env: process.env, timeoutMs });
  /** A step script that starts GRANDCHILD and writes its pid to `pidFile`. */
  const spawnsGrandchild = (pidFile: string, o: { leaveGroup: boolean }, then: string) => `
    const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}],
      { detached: ${o.leaveGroup}, stdio: ["ignore", ${o.leaveGroup ? '"inherit", "inherit"' : '"ignore", "ignore"'}] });
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(g.pid));
    fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
    ${then}`;
  const grandchildPid = (pidFile: string) => {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`bad pid in ${pidFile}: ${pid}`);
    strays.push(pid);
    return pid;
  };
  /** Waits for `pid` to be gone, then stops expecting to sweep it (the pid may be reused). */
  const waitGone = async (pid: number) => {
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
    strays.splice(strays.indexOf(pid), 1);
  };
  /** The signals sent to a process group (a negative pid) so far. */
  const groupSignals = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([p]) => typeof p === "number" && p < 0).map(([, s]) => s);

  it("resolves a step's output", async () => {
    await expect(run("console.log('out');console.error('err')")).resolves.toEqual({
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(liveStepPids()).toEqual([]);
  });

  it("rejects a non-zero exit with the output attached", async () => {
    await expect(run("console.log('o');console.error('e');process.exit(3)")).rejects.toMatchObject({
      killed: false,
      stdout: "o\n",
      stderr: "e\n",
      message: expect.stringContaining("exited 3"),
    });
    expect(liveStepPids()).toEqual([]);
  });

  it("rejects a command that does not exist, once", async () => {
    await expect(
      realExec("mc-no-such-command", [], { cwd: d, env: process.env, timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "ENOENT", killed: false });
    expect(liveStepPids()).toEqual([]);
  });

  it(
    "kills a step whose output passes the buffer limit",
    async () => {
      const spew = `const b="x".repeat(1<<20);for(let i=0;i<20;i++)process.stdout.write(b);${LONG}`;
      const e = await run(spew).catch((x: unknown) => x as { killed: boolean; stdout: string });
      expect(e).toMatchObject({ killed: true });
      expect(e.stdout.length).toBeLessThanOrEqual(UPDATE_MAX_BUFFER);
    },
    TEST_MS,
  );

  it(
    "takes the step's grandchild down with it on a timeout",
    async () => {
      const pidFile = join(d, "grandchild.pid");
      await expect(
        run(spawnsGrandchild(pidFile, { leaveGroup: false }, LONG), 1000),
      ).rejects.toMatchObject({ killed: true });
      const pid = grandchildPid(pidFile);
      await waitGone(pid);
    },
    TEST_MS,
  );

  it(
    "sends SIGKILL after the grace when the step ignores SIGTERM",
    async () => {
      const spy = vi.spyOn(process, "kill");
      const t0 = Date.now();
      // a long timeout, so a slow runner has installed the SIGTERM handler before it fires
      const stepMs = 2000;
      await expect(run(`process.on('SIGTERM',()=>{});${LONG}`, stepMs)).rejects.toMatchObject({
        killed: true,
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(stepMs + UPDATE_KILL_GRACE_MS - 100);
      const [first, ...rest] = groupSignals(spy);
      expect(first).toBe("SIGTERM");
      expect(rest.length).toBeGreaterThan(0);
      expect(rest.every((s) => s === "SIGKILL")).toBe(true);
    },
    TEST_MS,
  );

  it(
    "keeps a signal error other than ESRCH and settles only when the step exits",
    async () => {
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGTERM" && pid < 0)
          throw Object.assign(new Error("no"), { code: "EPERM" });
        return kill0(pid, signal as NodeJS.Signals);
      });
      const t0 = Date.now();
      await expect(run(LONG, 500)).rejects.toMatchObject({ code: "EPERM", killed: true });
      // not before the SIGKILL after the grace ended the step
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500 + UPDATE_KILL_GRACE_MS - 100);
      expect(liveStepPids()).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "settles when a descendant that left the group holds the output, and signals nothing after the exit",
    async () => {
      const pidFile = join(d, "daemon.pid");
      const spy = vi.spyOn(process, "kill");
      const t0 = Date.now();
      await expect(
        run(spawnsGrandchild(pidFile, { leaveGroup: true }, LONG), 1000),
      ).rejects.toMatchObject({ killed: true });
      expect(Date.now() - t0).toBeLessThan(1000 + UPDATE_PIPE_GRACE_MS + 2000);
      const pid = grandchildPid(pidFile);
      expect(alive(pid)).toBe(true); // another group: not the step's to kill
      const sent = groupSignals(spy);
      expect(sent).toEqual(["SIGTERM", "SIGKILL"]); // the SIGKILL from the exit handler
      await new Promise((r) => setTimeout(r, UPDATE_KILL_GRACE_MS + 500));
      expect(groupSignals(spy)).toEqual(sent);
    },
    TEST_MS,
  );

  it(
    "settles when a step exits 0 leaving such a descendant behind, signalling no group",
    async () => {
      const pidFile = join(d, "daemon.pid");
      const spy = vi.spyOn(process, "kill");
      const t0 = Date.now();
      await expect(
        run(spawnsGrandchild(pidFile, { leaveGroup: true }, "g.unref();"), 10_000),
      ).resolves.toEqual({ stdout: "", stderr: "" });
      expect(Date.now() - t0).toBeLessThan(UPDATE_PIPE_GRACE_MS + 3000);
      expect(alive(grandchildPid(pidFile))).toBe(true);
      expect(groupSignals(spy)).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "keeps the live steps' pids, and killLiveSteps ends their groups",
    async () => {
      const pidFile = join(d, "grandchild.pid");
      const p = run(spawnsGrandchild(pidFile, { leaveGroup: false }, LONG));
      const settled = p.catch((x: unknown) => x);
      await vi.waitFor(() => expect(liveStepPids()).toHaveLength(1));
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const [leader] = liveStepPids();
      killLiveSteps();
      await expect(settled).resolves.toMatchObject({ killed: false });
      expect(liveStepPids()).toEqual([]);
      expect(alive(leader as number)).toBe(false);
      await waitGone(grandchildPid(pidFile));
    },
    TEST_MS,
  );
});

describe("auto update", () => {
  function auto(over: Partial<AutoUpdateDeps> = {}, upd = updater()) {
    const record = vi.fn();
    const held = vi.fn();
    const restart = vi.spyOn(upd.u, "restart");
    const tick = createAutoUpdate({
      enabled: true,
      updater: upd.u,
      held,
      blocked: () => null,
      locked: () => null,
      headSha: async () => head(),
      record,
      ...over,
    });
    return { ...upd, tick, record, restart, held };
  }
  /** The pull: manual Update runs `git pull`; auto runs `git merge --ff-only <sha>`. */
  const pulls = (calls: Call[]) =>
    calls.filter((c) => c.cmd.startsWith("git pull") || c.cmd.startsWith("git merge "));
  /** An updater that is never asked for git: a main with a change that restarts the hub. */
  const restarting = (update: () => Promise<{ restarting: true }>) => {
    const u = updater().u;
    return {
      ...u,
      check: async () => ({ sha: "s", behind: 1, checkedAt: 1, canUpdate: true, reason: null }),
      changes: async () => ({ commits: ["abc x"], paths: ["apps/web/src/x.ts"] }),
      update,
      restart: vi.fn(),
    };
  };

  it("runs Update once when main is ahead on the page and nothing blocks it, and records the SHA", async () => {
    upstreamPath("apps/web/src/b.txt");
    const a = auto();
    await expect(a.tick()).resolves.toBe("updated");
    expect(a.calls.map((c) => c.cmd)).toEqual(
      expect.arrayContaining(UPDATE_CMDS.filter((c) => !c.startsWith("git pull"))),
    );
    expect(pulls(a.calls)).toHaveLength(1);
    expect(pulls(a.calls)[0]?.cmd).toBe(`git merge --ff-only ${head()}`);
    expect(a.record).toHaveBeenCalledWith(`Updated to ${head()} (auto, web only)`);
    expect(a.held).toHaveBeenLastCalledWith(null);
  });

  it("holds a range that touches hub code: nothing is pulled and one item is raised", async () => {
    upstreamPath("apps/server/src/x.ts");
    const a = auto();
    await expect(a.tick()).resolves.toBe("waiting");
    expect(pulls(a.calls)).toHaveLength(0);
    expect(a.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
    expect(a.held).toHaveBeenCalledWith({
      commits: [expect.stringContaining("apps/server/src/x.ts")],
      paths: ["apps/server/src/x.ts"],
    });
    expect(a.record).not.toHaveBeenCalled();
  });

  it.each([
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "roles/FLIGHT.md",
    ".github/workflows/ci.yml",
    "a.config.js",
  ])("holds %s", async (path) => {
    upstreamPath("apps/web/src/ok.ts");
    upstreamPath(path);
    const a = auto();
    await expect(a.tick()).resolves.toBe("waiting");
    expect(a.held).toHaveBeenCalledWith(expect.objectContaining({ paths: [path] }));
    expect(pulls(a.calls)).toHaveLength(0);
  });

  it("a later web-only commit waits behind a held range", async () => {
    upstreamPath("apps/server/src/x.ts");
    upstreamPath("apps/web/src/y.tsx");
    const a = auto();
    await expect(a.tick()).resolves.toBe("waiting");
    expect(pulls(a.calls)).toHaveLength(0);
    expect(a.held).toHaveBeenCalledWith({
      commits: [
        expect.stringContaining("apps/web/src/y.tsx"),
        expect.stringContaining("apps/server/src/x.ts"),
      ],
      paths: ["apps/server/src/x.ts"],
    });
  });

  it("holds test paths, including runtime safeguards and test tooling", () => {
    for (const path of [
      "apps/web/test/cards.test.ts",
      "apps/server/test/views.test.ts",
      "packages/core/test/board.test.ts",
      "packages/agentcomms/test/inbox.test.ts",
      "apps/server/test/session-actions.test.ts",
      "apps/server/test/brief.test.ts",
      "apps/server/test/checkouts.test.ts",
      "apps/server/test/codex-approval.test.ts",
      "apps/server/test/keeper.test.ts",
      "apps/server/test/publish.test.ts",
      "apps/server/test/queue.test.ts",
      "apps/server/test/gh-read.test.ts",
      "apps/server/test/remove.test.ts",
      "packages/core/test/away.test.ts",
      "apps/server/test/engine.test.ts",
      "apps/server/test/flight-tools.test.ts",
      "apps/server/test/supervisor-start.test.ts",
      "apps/server/test/update.test.ts",
      "packages/core/test/loop.test.ts",
      "packages/core/test/guard.test.ts",
      "apps/server/test/engine/helpers.ts",
      "apps/web/test/package.json",
      "apps/web/test/vite.config.ts",
      "apps/web/test/../src/x.ts",
      "apps/web/test/fixtures/x.ts",
    ]) {
      expect(autoUpdatePath(path), path).toBe(false);
    }
  });

  it("applies the page and docs", async () => {
    for (const p of [
      "apps/web/src/a.ts",
      "apps/web/public/b.svg",
      "apps/web/index.html",
      "docs/c.md",
    ]) {
      expect(autoUpdatePath(p), p).toBe(true);
    }
    for (const p of [
      "apps/web/package.json",
      "CLAUDE.md",
      "apps/web/vite.config.ts",
      "README.md",
    ]) {
      expect(autoUpdatePath(p), p).toBe(false);
    }
  });

  it("update({ auto: true }) refuses a range that moved to hub code after the check", async () => {
    upstreamPath("apps/web/src/ok.ts");
    const a = auto();
    await a.u.check(); // looked fine
    upstreamPath("apps/server/src/x.ts"); // then main moved
    const e = (await a.u.update({ auto: true }).catch((x: unknown) => x)) as UpdateError;
    expect([e.status, e.message]).toEqual([409, HUB_CODE_NEEDS_PERSON]);
    expect(e.held?.paths).toEqual(["apps/server/src/x.ts"]);
    expect(pulls(a.calls)).toHaveLength(0);
    expect(readFileSync(logPath, "utf8")).toContain("held for a person");
  });

  it("update({ auto: true }) refuses if origin/main moves after its range check", async () => {
    upstreamPath("apps/web/src/ok.ts");
    const f = fakeExec();
    let tipReads = 0;
    const { u } = updater({
      exec: async (file, args, o) => {
        const result = await f.exec(file, args, o);
        if (file === "git" && args.slice(4).join(" ") === "rev-parse origin/main") {
          tipReads++;
          if (tipReads === 2) return { stdout: `${"f".repeat(40)}\n`, stderr: "" };
        }
        return result;
      },
    });
    const e = (await u.update({ auto: true }).catch((x: unknown) => x)) as UpdateError;
    expect([e.status, e.message]).toEqual([409, HUB_CODE_NEEDS_PERSON]);
    expect(tipReads).toBe(2);
    expect(pulls(f.calls)).toHaveLength(0);
    expect(readFileSync(logPath, "utf8")).toContain("origin/main moved after the check");
  });

  it("raises the item when update() holds a range the tick's own read did not", async () => {
    upstreamPath("apps/web/src/ok.ts");
    const u = updater().u;
    const held = vi.fn();
    const tick = createAutoUpdate({
      enabled: true,
      updater: {
        check: u.check,
        changes: u.changes,
        restart: u.restart,
        update: async (o) => {
          upstreamPath("apps/server/src/x.ts");
          return u.update(o);
        },
      },
      held,
      blocked: () => null,
      locked: () => null,
      headSha: async () => head(),
      record: vi.fn(),
    });
    await expect(tick()).resolves.toBe("waiting");
    expect(held).toHaveBeenCalledWith(expect.objectContaining({ paths: ["apps/server/src/x.ts"] }));
  });

  it("refuses auto Update when HEAD diverges from the checked tip", async () => {
    const startSha = head();
    mkdirSync(join(hub, "docs"));
    writeFileSync(join(hub, "docs/local.md"), "local");
    git(hub, "add", "docs/local.md");
    git(hub, "commit", "-qm", "local docs");
    upstreamPath("apps/web/src/page.tsx");
    const a = auto({}, updater({ startSha }));
    await expect(a.u.update({ auto: true })).rejects.toMatchObject({
      status: 409,
      message: HUB_HEAD_OFF_MAIN,
    });
    expect(pulls(a.calls)).toHaveLength(0);
    expect(a.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
  });

  it("refuses auto Update when HEAD contains hub code reverted at the checked tip", async () => {
    const startSha = head();
    upstreamPath("apps/server/src/x.ts");
    git(hub, "pull", "-q", "--ff-only", "origin", "main");
    git(dev, "revert", "--no-edit", "HEAD");
    upstreamPath("apps/web/src/page.tsx");
    const a = auto({}, updater({ startSha }));
    await expect(a.u.update({ auto: true })).rejects.toMatchObject({
      status: 409,
      message: HUB_CODE_NEEDS_PERSON,
    });
    expect(pulls(a.calls)).toHaveLength(0);
    expect(a.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
  });

  it("retries an auto web-only Update whose pull landed but whose build failed", async () => {
    const startSha = head();
    upstreamPath("apps/web/src/page.tsx");
    git(hub, "pull", "-q", "--ff-only", "origin", "main");
    const a = auto({}, updater({ startSha }));
    await expect(a.u.update({ auto: true })).resolves.toEqual({ swapped: true });
  });

  it("checks the diff and web-only range against the captured tip", async () => {
    upstreamPath("apps/web/src/page.tsx");
    const tip = head(dev);
    const { u, calls } = updater();
    await expect(u.update({ auto: true })).resolves.toEqual({ swapped: true });
    const diffs = calls.filter((c) => c.cmd.startsWith("git diff --name-only"));
    expect(diffs.some((c) => c.cmd.endsWith(` ${tip}`))).toBe(true);
    expect(diffs.some((c) => c.cmd.endsWith(" origin/main"))).toBe(false);
  });

  it.each(["symlink", "gitlink", "ignored gitlink"])(
    "holds a %s even under the allowlist",
    async (kind) => {
      mkdirSync(join(dev, "docs"));
      if (kind === "symlink") {
        symlinkSync("../apps/server", join(dev, "docs", "linked"));
        git(dev, "add", "docs/linked");
      } else {
        git(dev, "update-index", "--add", "--cacheinfo", `160000,${head(dev)},docs/linked`);
      }
      git(dev, "commit", "-qm", "linked docs");
      git(dev, "push", "-q", "origin", "main");
      if (kind === "ignored gitlink") git(hub, "config", "diff.ignoreSubmodules", "all");
      const a = auto();
      await expect(a.tick()).resolves.toBe("waiting");
      expect(a.held).toHaveBeenCalledWith(expect.objectContaining({ paths: ["docs/linked"] }));
      const held = a.held.mock.calls.at(-1)?.[0];
      expect(held?.unsafePaths).toEqual(["docs/linked"]);
      expect(hubCodeHeldText(held)).toContain("symlink or submodule");
      await expect(a.u.update({ auto: true })).rejects.toMatchObject({
        status: 409,
        message: HUB_CODE_NEEDS_PERSON,
      });
      expect(pulls(a.calls)).toHaveLength(0);
    },
  );

  it("clears the held note when auto Update is off", async () => {
    const a = auto({ enabled: false });
    await expect(a.tick()).resolves.toBe("off");
    expect(a.held).toHaveBeenCalledWith(null);
    expect(a.calls).toEqual([]);
  });

  it("clears a persisted held note at startup when updates.hub is off, without a tick", () => {
    const store = new Store(join(dir, "notes.sqlite"));
    const bus = new ChangeBus();
    const attention = vi.fn();
    bus.subscribe(attention);
    try {
      createHeldUpdateNote(store, bus)({ commits: ["a first"], paths: ["package.json"] });
      attention.mockClear();
      createHeldUpdateNote(store, bus, false);
      expect(store.notes()).toEqual([]);
      expect(attention).toHaveBeenCalledTimes(1);
      createHeldUpdateNote(store, bus, false);
      expect(attention).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("refreshes one held note and emits attention only when it changes", () => {
    const store = new Store(join(dir, "notes.sqlite"));
    const bus = new ChangeBus();
    const attention = vi.fn();
    bus.subscribe(attention);
    const held = createHeldUpdateNote(store, bus);
    const first = { commits: ["a first"], paths: ["apps/server/a.ts"] };
    const next = {
      commits: ["b second", "a first"],
      paths: ["apps/server/b.ts", "apps/server/a.ts"],
    };
    try {
      held(null);
      expect(attention).not.toHaveBeenCalled();
      held(first);
      held(first);
      expect(attention).toHaveBeenCalledTimes(1);
      held(next);
      expect(store.notes()).toMatchObject([
        { key: HUB_UPDATE_HELD_KEY, text: hubCodeHeldText(next) },
      ]);
      expect(attention).toHaveBeenCalledTimes(2);
      held(null);
      held(null);
      expect(store.notes()).toEqual([]);
      expect(attention).toHaveBeenCalledTimes(3);
      held(first);
      expect(store.notes()).toMatchObject([{ text: hubCodeHeldText(first) }]);
      expect(attention).toHaveBeenCalledTimes(4);
    } finally {
      store.close();
    }
  });

  it("a manual Update applies hub code and the page", async () => {
    upstreamPath("apps/server/src/x.ts");
    upstreamPath("apps/web/src/page.tsx");
    const { u, calls } = updater();
    expect(await u.update()).toEqual({ restarting: true });
    expect(calls.some((c) => c.cmd === "git pull --ff-only origin main")).toBe(true);
  });

  it("clears the held item once main is current", async () => {
    const a = auto();
    await expect(a.tick()).resolves.toBe("current");
    expect(a.held).toHaveBeenCalledWith(null);
  });

  it("the held text names the commits and the paths", () => {
    const text = hubCodeHeldText({
      commits: ["a1 one", "b2 two"],
      paths: ["apps/server/src/x.ts", "package.json"],
    });
    expect(text).toContain("a1 one, b2 two");
    expect(text).toContain("apps/server/src/x.ts, package.json");
  });

  it("does nothing when main has not moved", async () => {
    const a = auto();
    await expect(a.tick()).resolves.toBe("current");
    expect(a.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
    expect(a.record).not.toHaveBeenCalled();
  });

  it("waits while a seat is mid-turn, then updates on a later check", async () => {
    let busy = true;
    const u = restarting(async () => {
      if (busy) throw new UpdateError(409, "GUIDO-1 is mid-turn");
      return { restarting: true };
    });
    const record = vi.fn();
    const tick = createAutoUpdate({
      enabled: true,
      updater: u,
      held: vi.fn(),
      blocked: () => null,
      locked: () => null,
      headSha: async () => head(),
      record,
    });
    await expect(tick()).resolves.toBe("waiting");
    expect(record).not.toHaveBeenCalled();
    busy = false;
    await expect(tick()).resolves.toBe("updated");
    expect(record).toHaveBeenCalledTimes(1);
    expect(u.restart).toHaveBeenCalledTimes(1);
  });

  it("waits on a change outside apps/web/ and docs/ while a seat is mid-turn", async () => {
    upstreamPath("apps/server/src/x.txt");
    const busy = "GUIDO-1 is mid-turn";
    const a = auto(
      { blocked: () => busy, locked: () => null },
      updater({ crewRefusal: () => busy }),
    );
    await expect(a.tick()).resolves.toBe("waiting");
    expect(pulls(a.calls)).toHaveLength(0);
    expect(a.record).not.toHaveBeenCalled();
    expect(a.restart).not.toHaveBeenCalled();
    expect(a.held).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["apps/server/src/x.txt"] }),
    );
  });

  it("waits while the test lock is held", async () => {
    upstreamPath("apps/web/src/b.txt");
    let held = true;
    const a = auto({ locked: () => (held ? "the test lock is held" : null) });
    await expect(a.tick()).resolves.toBe("waiting");
    expect(a.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
    held = false;
    await expect(a.tick()).resolves.toBe("updated");
  });

  it("holds the restart while a turn that started during the build is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let busy: string | null = null;
    // update() sees an idle crew; a seat is mid-turn by the time the build is done
    const u = restarting(async () => {
      busy = "GUIDO-1 is mid-turn";
      return { restarting: true };
    });
    const record = vi.fn();
    const tick = createAutoUpdate({
      enabled: true,
      updater: u,
      held: vi.fn(),
      blocked: () => busy,
      locked: () => null,
      headSha: async () => head(),
      record,
    });
    await expect(tick()).resolves.toBe("updated");
    expect(u.restart).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_FLOOR_MS);
    expect(u.restart).not.toHaveBeenCalled();
    busy = null;
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_FLOOR_MS);
    expect(u.restart).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("never runs when off", async () => {
    upstreamCommit("b.txt");
    const a = auto({ enabled: false });
    await expect(a.tick()).resolves.toBe("off");
    expect(a.calls).toEqual([]);
  });

  it("never runs on a preview", async () => {
    upstreamCommit("b.txt");
    const a = auto({}, updater({ preview: true }));
    await expect(a.tick()).resolves.toBe("waiting");
    // reads only: no fetch, pull or install
    expect(a.calls.filter((c) => /^(pnpm|git (fetch|pull))/.test(c.cmd))).toEqual([]);
    expect(a.record).not.toHaveBeenCalled();
  });

  it("waits when the checkout is off main, and when origin is unreachable", async () => {
    upstreamCommit("b.txt");
    git(hub, "checkout", "-q", "-b", "feature/x");
    const off = auto();
    await expect(off.tick()).resolves.toBe("waiting");
    expect(off.calls.some((c) => c.cmd.startsWith("pnpm"))).toBe(false);
    const down = auto({}, updater({ exec: () => Promise.reject(new Error("no route")) }));
    await expect(down.tick()).resolves.toBe("waiting");
  });
});
