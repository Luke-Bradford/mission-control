import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckRecorder } from "../src/guard/check-runs.ts";
import { TestLock } from "../src/guard/lock.ts";
import {
  createSeatTerminal,
  type TerminalRun,
  terminalCommandDecision,
  terminalPaneShell,
  terminalSandboxProfile,
  terminalSuite,
} from "../src/sessions/terminal.ts";
import { Store } from "../src/store.ts";
import { blockedHere } from "./sandbox-gaps.ts";

const SEAT = "guido-eb";
const RUN = "run-1";
const OTHER = "guido-ae";
const OTHER_RUN = "run-2";
const seatbeltBlocked = await blockedHere("seatbelt");
/** Stands in for the guard's full-suite classification: a command naming `suite` is one. */
const suiteOf = ({ command }: { command: string }) =>
  /suite/.test(command) ? "pnpm -s test" : null;

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
    workspaces: vi.fn().mockResolvedValue([
      { id: "ws-eb", name: `${SEAT} · #1`, cwd: worktree },
      { id: "ws-ae", name: `${OTHER} · #2`, cwd: worktree },
    ]),
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
  it.skipIf(!existsSync("/bin/zsh"))(
    "starts the final login shell without provider or hub tokens",
    () => {
      const output = execFileSync("/bin/zsh", ["-fc", terminalPaneShell(undefined, "env")], {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "github",
          GITHUB_TOKEN: "github",
          ANTHROPIC_API_KEY: "anthropic",
          MC_OPERATOR_TOKEN: "operator",
          MC_CONTROLLER_TOKEN: "controller",
        },
      });
      expect(output).not.toMatch(/^(?:GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|MC_[A-Z0-9_]+)=/m);
      expect(output).toMatch(/^PATH=.+/m);
    },
  );

  it.skipIf(process.platform !== "darwin" || seatbeltBlocked)(
    "enforces credentials and worktree access after shell expansion and through symlinks",
    () => {
      const privateDir = join(dir, "private");
      const scratch = join(dir, "hub");
      mkdirSync(privateDir);
      mkdirSync(scratch);
      writeFileSync(join(privateDir, "token"), "secret\n");
      writeFileSync(join(worktree, "payload"), "payload\n");
      symlinkSync(privateDir, join(worktree, "private-link"));
      const profile = terminalSandboxProfile({
        worktree,
        scratch,
        denyRead: [privateDir],
      });
      const run = (command: string) => {
        try {
          execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-fc", command], {
            cwd: worktree,
            env: { ...process.env, HOME: dir },
            stdio: "ignore",
          });
          return 0;
        } catch (error) {
          return (error as { status?: number }).status;
        }
      };
      for (const command of [
        'cat "$HOME/private/token"',
        `cat "\${HOME}/private/token"`,
        'echo stolen > "$HOME/operator-token"',
        'cp payload --target-directory="$HOME/out"',
        "cat private-link/token",
        `${process.execPath} -e 'require("node:fs").readFileSync(process.env.HOME + "/private/token")'`,
      ])
        expect(run(command), command).not.toBe(0);
      expect(run("echo inside > result && cat result")).toBe(0);
    },
  );

  it.skipIf(process.platform !== "darwin" || seatbeltBlocked)(
    "keeps process credentials, the login keychain, the hub, and external hosts out of the pane",
    async () => {
      const scratch = join(dir, "hub");
      mkdirSync(scratch);
      const listen = () =>
        new Promise<ReturnType<typeof createServer>>((done) => {
          const server = createServer();
          server.listen(0, "127.0.0.1", () => done(server));
        });
      const app = await listen();
      const hub = await listen();
      const appPort = (app.address() as { port: number }).port;
      const hubPort = (hub.address() as { port: number }).port;
      const profile = terminalSandboxProfile({
        worktree,
        scratch,
        denyRead: [],
        denyLocalPorts: [hubPort],
      });
      const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, GH_TOKEN: "operator-token", MC_OPERATOR_TOKEN: "hub-token" },
        stdio: "ignore",
      });
      const run = (command: string) => {
        try {
          execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-fc", command], {
            cwd: worktree,
            encoding: "utf8",
          });
          return { status: 0, output: "" };
        } catch (error) {
          return {
            status: (error as { status?: number }).status ?? 1,
            output: String((error as { stdout?: Buffer }).stdout ?? ""),
          };
        }
      };
      const connect = (port: number) =>
        `${process.execPath} -e ${JSON.stringify(
          `require("node:net").connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))`,
        )}`;
      try {
        expect(run(connect(appPort)).status).toBe(0);
        expect(run(connect(hubPort)).status).not.toBe(0);
        expect(run("curl --connect-timeout 1 https://example.com").status).not.toBe(0);
        expect(run(`ps eww -p ${sibling.pid}`).status).not.toBe(0);
        expect(run("security list-keychains").status).not.toBe(0);
      } finally {
        sibling.kill();
        await Promise.all([
          new Promise<void>((done) => app.close(() => done())),
          new Promise<void>((done) => hub.close(() => done())),
        ]);
      }
    },
  );
  it.each([
    "cat ~/.local/share/mission-control/operator-token",
    "git push",
    "gh auth token",
    "ps eww -ax",
    "/bin/ps eww -ax",
    "security find-generic-password -s mission-control",
    "/usr/bin/security find-generic-password -s mission-control",
    "echo secret > /tmp/operator-token",
  ])("refuses an operator credential or GitHub command: %s", (command) => {
    expect(
      terminalCommandDecision({
        command,
        worktree,
        denyRead: [join(dir, "private")],
      }),
    ).toMatch(/refused/i);
  });

  it.each(["uv run pytest -m db", "make up", "pnpm exec vite"])(
    "permits an app or test command: %s",
    (command) => {
      expect(terminalCommandDecision({ command, worktree, denyRead: [] })).toBeNull();
    },
  );

  it("refuses before typing a protected command into the pane", async () => {
    const cmux = paneCmux();
    const t = terminal(cmux, {
      commandGuard: ({ command, worktree: terminalWorktree }: TerminalRun) =>
        terminalCommandDecision({ command, worktree: terminalWorktree, denyRead: [] }),
    });
    await expect(
      t.run({
        seatId: SEAT,
        runId: RUN,
        worktree,
        command: "git push",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/refused/i);
    expect(cmux.sendPane).not.toHaveBeenCalled();
  });

  it("applies a repository terminal command allowlist when one is configured", () => {
    expect(
      terminalCommandDecision({
        command: "make up",
        worktree,
        denyRead: [],
        commands: ["make"],
      }),
    ).toBeNull();
    expect(
      terminalCommandDecision({
        command: "uv run pytest -m db",
        worktree,
        denyRead: [],
        commands: ["make"],
      }),
    ).toMatch(/allowlist/i);
  });

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

  it("replaces a seat's pane when its active worktree changes", async () => {
    const nextWorktree = join(dir, "next-worktree");
    mkdirSync(nextWorktree);
    const cmux = paneCmux();
    const t = terminal(cmux, { sandboxProfile: (path: string) => `profile:${path}` });
    await t.run({ seatId: SEAT, runId: RUN, worktree, command: "true", timeoutMs: 5_000 });
    await t.run({
      seatId: SEAT,
      runId: "run-next",
      worktree: nextWorktree,
      command: "true",
      timeoutMs: 5_000,
    });
    expect(cmux.closePane).toHaveBeenCalledWith("surface:1");
    expect(cmux.newPane).toHaveBeenCalledTimes(2);
    expect(cmux.newPane).toHaveBeenLastCalledWith(
      "ws-eb",
      nextWorktree,
      expect.stringContaining(`profile:${nextWorktree}`),
    );
    expect(
      (cmux.newPane.mock.calls as unknown as [string, string, string][])[1]?.[2],
    ).not.toContain(`profile:${worktree}`);
    expect(cmux.typed.map((entry) => entry.surface)).toEqual(["surface:1", "surface:2"]);
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
  it("takes the shared test lock for a full suite, so two seats never run one at once", async () => {
    const lock = new TestLock();
    const t = terminal(paneCmux(), { lock, suiteOf, lockWaitMs: 50 });
    const first = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo suite-a && sleep 1",
      timeoutMs: 200,
    });
    expect(first.timedOut).toBe(true);
    expect(lock.state().holder).toMatchObject({
      runId: RUN,
      seatId: SEAT,
      command: "pnpm -s test",
    });

    await expect(
      t.run({
        seatId: OTHER,
        runId: OTHER_RUN,
        worktree,
        command: "echo suite-b",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/test lock is busy: GUIDO-EB is running pnpm -s test/);
    const plain = await t.run({
      seatId: OTHER,
      runId: OTHER_RUN,
      worktree,
      command: "echo one-file",
      timeoutMs: 5_000,
    });
    expect(plain.exitCode).toBe(0);

    await vi.waitFor(() => expect(lock.state().holder).toBeNull(), { timeout: 3_000 });
    const second = await t.run({
      seatId: OTHER,
      runId: OTHER_RUN,
      worktree,
      command: "echo suite-b",
      timeoutMs: 5_000,
    });
    expect(second).toMatchObject({ exitCode: 0, output: "suite-b\n" });
    expect(lock.state().holder).toBeNull();
  });

  it("on run teardown stops watching the command, frees the seat, ends its check record and releases the lock", async () => {
    const lock = new TestLock();
    const checks = { admit: vi.fn(), release: vi.fn(), begin: vi.fn(), end: vi.fn() };
    const cmux = paneCmux();
    const t = terminal(cmux, { lock, suiteOf, checks });
    const slow = await t.run({
      seatId: SEAT,
      runId: RUN,
      worktree,
      command: "echo suite && sleep 2",
      timeoutMs: 100,
    });
    expect(slow.timedOut).toBe(true);
    expect(lock.state().holder?.runId).toBe(RUN);

    await t.tick([]);
    expect(lock.state().holder).toBeNull();
    expect(checks.end).toHaveBeenCalledTimes(1);
    expect(checks.end).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN }), false, null);
    expect(cmux.closePane).toHaveBeenCalledWith("surface:1");
    const next = await t.run({
      seatId: SEAT,
      runId: "run-3",
      worktree,
      command: "echo next",
      timeoutMs: 5_000,
    });
    expect(next.exitCode).toBe(0);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(checks.end).toHaveBeenCalledTimes(2);
  });

  it("classifies a terminal command as a full suite the way the guard does", () => {
    const config = {
      repos: [{ id: "r", github: "o/r", fullSuite: ["pnpm -s test"] }],
    } as unknown as Parameters<typeof terminalSuite>[0];
    const related = (command: string) => (command === "pnpm -s test:related" ? command : null);
    const suite = (command: string) => terminalSuite(config, "r", worktree, command, related);
    expect(suite("pnpm -s test")).toBe("pnpm -s test");
    expect(suite("echo start && pnpm -s test")).toBe("pnpm -s test");
    expect(suite("pnpm -s test apps/server/test/x.test.ts")).toBeNull();
    expect(suite("pnpm -s test:related")).toBe("pnpm -s test:related");
    expect(suite("git push origin HEAD && pnpm -s test")).toBe("pnpm -s test");
    expect(suite("uv run pytest -m db")).toBeNull();
  });
});
