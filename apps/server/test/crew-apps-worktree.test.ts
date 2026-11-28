import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckRecorder } from "../src/guard/check-runs.ts";
import { createCrewApps } from "../src/sessions/apps.ts";
import { createSeatTerminal } from "../src/sessions/terminal.ts";
import { Store } from "../src/store.ts";

const SEAT = "guido-eb";
const RUN = "run-1";
/** A configured check that fails if anything has touched the worktree while the apps run. */
const CHECK = 'test -z "$(git status --porcelain)"';

let dir = "";
let worktree = "";
const processes: ChildProcess[] = [];
const kill = (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-crew-app-worktree-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
  worktree = join(dir, "worktree");
  git(repo, "worktree", "add", "-q", "-b", "seat", worktree);
});
afterEach(() => {
  for (const child of processes.splice(0)) kill(child);
  rmSync(dir, { recursive: true, force: true });
});

/** A cmux stand-in whose panes really run, in the folder they were opened in. */
function realPanes() {
  const panes = new Map<string, ChildProcess>();
  let made = 0;
  const run = (command: string, cwd: string) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: "ignore", detached: true });
    processes.push(child);
    return child;
  };
  return {
    workspaces: async () => [{ id: "ws-eb", name: `${SEAT} · #1`, cwd: worktree }],
    newPane: async (_workspace: string, cwd: string, command: string) => {
      const surface = `surface:${++made}`;
      panes.set(surface, run(command, cwd));
      return surface;
    },
    closePane: async (surface: string) => {
      const child = panes.get(surface);
      if (child) kill(child);
      panes.delete(surface);
    },
    sendPane: async (surface: string, text: string) => {
      if (!panes.has(surface)) throw new Error("surface not found");
      run(text, worktree);
    },
    readPane: async (surface: string) => {
      const child = panes.get(surface);
      if (!child || child.exitCode !== null) throw new Error("surface not found");
      return "";
    },
    setStatus: async () => {},
  };
}

describe("crew apps and the terminal in a real seat worktree", () => {
  it("runs app panes and a configured check without dirtying the worktree, and the push gate counts the pass", async () => {
    const head = git(worktree, "rev-parse", "HEAD");
    const cmux = realPanes();
    const store = new Store(join(dir, "mc.sqlite"));
    try {
      const apps = createCrewApps({
        cmux,
        repos: () => [
          {
            id: "ebull",
            commands: [
              { command: 'echo "backend $PORT" && sleep 30', url: "http://127.0.0.1:$PORT" },
              { command: 'echo "frontend $PORT" && sleep 30', url: "http://127.0.0.1:$PORT" },
            ],
          },
        ],
        seats: () => [{ id: SEAT, repoId: "ebull", worktree }],
        probe: async () => false,
      });
      const recorder = createCheckRecorder({
        store,
        checks: async () => [CHECK],
        state: async () => ({
          head: git(worktree, "rev-parse", "HEAD"),
          clean: git(worktree, "status", "--porcelain") === "",
        }),
        worktree: async () => worktree,
      });
      const terminal = createSeatTerminal({
        cmux,
        dir: join(dir, "hub"),
        checks: recorder,
        pollMs: 20,
      });

      await apps.start(SEAT);
      expect(apps.view()[0]?.running).toBe(true);
      const result = await terminal.run({
        seatId: SEAT,
        runId: RUN,
        worktree,
        command: CHECK,
        timeoutMs: 10_000,
      });
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      await apps.tick();
      expect(apps.view()[0]?.running).toBe(true);

      expect(git(worktree, "status", "--porcelain", "--ignored")).toBe("");
      // the push gate's own question: a passing run of each configured check at the pushed commit
      expect(store.latestCheckRun(RUN, CHECK, head)).toMatchObject({ headSha: head, ok: true });

      await apps.stop(SEAT);
      await terminal.tick([]);
      expect(git(worktree, "status", "--porcelain", "--ignored")).toBe("");
    } finally {
      store.close();
    }
  });
});
