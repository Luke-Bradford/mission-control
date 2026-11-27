import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckRecorder } from "../src/guard/check-runs.ts";
import { createSeatTerminal } from "../src/sessions/terminal.ts";
import { Store } from "../src/store.ts";

const SEAT = "guido-eb";
const RUN = "run-1";

let dir = "";
let worktree = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-seat-terminal-")));
  worktree = join(dir, "worktree");
  mkdirSync(worktree);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A cmux stand-in whose panes run what is typed into them, as the seat's real terminal would. */
function paneCmux() {
  const typed: { surface: string; text: string }[] = [];
  let made = 0;
  return {
    typed,
    workspaces: vi.fn().mockResolvedValue([{ id: "ws-eb", name: `${SEAT} · #1`, cwd: worktree }]),
    newPane: vi.fn(async () => `surface:${++made}`),
    closePane: vi.fn(async () => {}),
    sendPane: vi.fn(async (surface: string, text: string) => {
      typed.push({ surface, text });
      spawn("sh", ["-c", text], { cwd: worktree, stdio: "ignore" });
    }),
  };
}

const terminal = (cmux: ReturnType<typeof paneCmux>, extra = {}) =>
  createSeatTerminal({ cmux, dir: join(dir, "hub"), pollMs: 20, ...extra });

describe("seat terminal", () => {
  it("types a command into one pane of the seat's workspace and returns its output and exit code", async () => {
    const cmux = paneCmux();
    const t = terminal(cmux);
    const first = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "pwd && echo to-stderr >&2 && exit 3",
      timeoutMs: 10_000,
    });
    expect(first).toEqual({
      output: `${worktree}\nto-stderr\n`,
      exitCode: 3,
      timedOut: false,
    });
    const second = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo again",
      timeoutMs: 10_000,
    });
    expect(second.output).toBe("again\n");
    expect(second.exitCode).toBe(0);
    expect(cmux.newPane).toHaveBeenCalledTimes(1);
    expect(cmux.newPane).toHaveBeenCalledWith("ws-eb", worktree, expect.any(String));
    expect(cmux.typed.map((x) => x.surface)).toEqual(["surface:1", "surface:1"]);
    expect(cmux.closePane).not.toHaveBeenCalled();
  });

  it("returns at its timeout with the pane still running, and refuses another command until it ends", async () => {
    const cmux = paneCmux();
    const t = terminal(cmux);
    const slow = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo started && sleep 1 && echo done",
      timeoutMs: 300,
    });
    expect(slow).toEqual({ output: "started\n", exitCode: null, timedOut: true });
    expect(cmux.closePane).not.toHaveBeenCalled();
    await expect(
      t.run({ seatId: SEAT, runId: RUN, worktree, command: "echo next", timeoutMs: 1_000 }),
    ).rejects.toThrow(/still running in this seat's terminal: echo started/);
    await new Promise((r) => setTimeout(r, 1_200));
    const next = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo next",
      timeoutMs: 5_000,
    });
    expect(next.exitCode).toBe(0);
  });

  it("closes the seat's terminal pane when its run ends", async () => {
    const cmux = paneCmux();
    const t = terminal(cmux);
    await t.run({ seatId: SEAT, runId: RUN, worktree, command: "true", timeoutMs: 5_000 });
    await t.tick([SEAT]);
    expect(cmux.closePane).not.toHaveBeenCalled();
    await t.tick([]);
    expect(cmux.closePane).toHaveBeenCalledWith("surface:1");
  });

  it("opens a fresh pane when the old one was closed", async () => {
    const cmux = paneCmux();
    const t = terminal(cmux);
    await t.run({ seatId: SEAT, runId: RUN, worktree, command: "true", timeoutMs: 5_000 });
    cmux.sendPane.mockRejectedValueOnce(new Error("cmux send failed: surface not found"));
    const again = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo back",
      timeoutMs: 5_000,
    });
    expect(again.output).toBe("back\n");
    expect(cmux.newPane).toHaveBeenCalledTimes(2);
  });

  it("refuses when the seat has no cmux workspace", async () => {
    const cmux = paneCmux();
    cmux.workspaces.mockResolvedValue([]);
    await expect(
      terminal(cmux).run({ seatId: SEAT, runId: RUN, worktree, command: "true", timeoutMs: 1_000 }),
    ).rejects.toThrow(/No live cmux workspace/);
  });

  it("records a configured check that passed in the pane, at the clean commit, for the push gate", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
    const head = git("rev-parse", "HEAD");
    const store = new Store(join(dir, "mc.sqlite"));
    try {
      const recorder = createCheckRecorder({
        store,
        checks: async () => ["true"],
        state: async () => ({
          head: git("rev-parse", "HEAD"),
          clean: git("status", "--porcelain") === "",
        }),
        worktree: async () => worktree,
      });
      const t = terminal(paneCmux(), { checks: recorder });
      const passed = await t.run({
        seatId: SEAT,
        runId: RUN,
        worktree,
        command: "true",
        timeoutMs: 5_000,
      });
      expect(passed.exitCode).toBe(0);
      expect(store.newestCheckRun(RUN, "true")).toMatchObject({
        headSha: head,
        ok: true,
        exitCode: 0,
      });
    } finally {
      store.close();
    }
  });

  it("refuses a check while another holds the seat's checkout", async () => {
    const recorder = {
      admit: vi.fn().mockResolvedValue("pnpm -s test"),
      release: vi.fn(),
      begin: vi.fn(),
      end: vi.fn(),
    };
    const cmux = paneCmux();
    await expect(
      terminal(cmux, { checks: recorder }).run({
        seatId: SEAT,
        runId: RUN,
        worktree,
        command: "pnpm -s lint",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/pnpm -s test is still running/);
    expect(cmux.sendPane).not.toHaveBeenCalled();
    expect(recorder.begin).not.toHaveBeenCalled();
  });
});
