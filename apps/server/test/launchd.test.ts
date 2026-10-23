import { spawn as realSpawn, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHCTL_STDOUT_MAX,
  LAUNCHCTL_TIMEOUT_MS,
  LOG_REPEAT_MS,
  launchdJob,
  launchdNote,
  makeLaunchctl,
  resetLaunchdLogState,
} from "../src/collectors/launchd.ts";
import type { AdoptedLoop } from "../src/config.ts";
import { PRINT_NOT_RUNNING, PRINT_RUNNING } from "./fixtures/launchctl.ts";

const loop = (id: string, launchdLabel: string): AdoptedLoop => ({
  id,
  repoId: "r",
  kind: "ta-loop",
  accountId: "a",
  stateDir: "/s",
  worktree: "/w",
  launchdLabel,
});

beforeEach(resetLaunchdLogState);

describe("launchdNote logging", () => {
  const failing = async () => ({ code: 1, stdout: "" });

  it("logs a repeated identical failure once per hour per label", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const a = loop("a", "com.a");
    let t = 1_000;
    for (let i = 0; i < 5; i++) await launchdNote(a, failing, 501, log, () => t + i * 30_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("launchctl print exited 1");
    // A different label has its own budget.
    await launchdNote(loop("b", "com.b"), failing, 501, log, () => t);
    expect(lines).toHaveLength(2);
    // After the hour the same failure is logged again.
    t += LOG_REPEAT_MS;
    await launchdNote(a, failing, 501, log, () => t);
    expect(lines).toHaveLength(3);
  });

  it("logs a changed failure straight away", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const a = loop("a", "com.a");
    await launchdNote(a, failing, 501, log, () => 0);
    const other = async () => ({ code: 2, stdout: "" });
    await launchdNote(a, other, 501, log, () => 1);
    expect(lines).toHaveLength(2);
  });

  it("logs again after a success in between", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const a = loop("a", "com.a");
    await launchdNote(a, failing, 501, log, () => 0);
    const ok = async () => ({ code: 0, stdout: PRINT_RUNNING });
    await launchdNote(a, ok, 501, log, () => 1);
    await launchdNote(a, failing, 501, log, () => 2);
    expect(lines).toHaveLength(2);
  });
});

describe("launchdJob", () => {
  const a = loop("a", "com.a");
  const answer = (code: number, stdout: string) => async () => ({ code, stdout });

  it("reads a running job and its pid", async () => {
    await expect(launchdJob(a, answer(0, PRINT_RUNNING), 501, () => {})).resolves.toEqual({
      kind: "running",
      pid: 4242,
    });
  });

  it("reads a job with no process; nested lines are ignored", async () => {
    await expect(launchdJob(a, answer(0, PRINT_NOT_RUNNING), 501, () => {})).resolves.toEqual({
      kind: "not running",
    });
  });

  it("reports exit 113 as missing", async () => {
    await expect(launchdJob(a, answer(113, ""), 501, () => {})).resolves.toEqual({
      kind: "missing",
      note: "launchd job missing: com.a",
    });
  });

  it("is unknown for another exit code, logged", async () => {
    const lines: string[] = [];
    await expect(launchdJob(a, answer(1, ""), 501, (m) => lines.push(m))).resolves.toEqual({
      kind: "unknown",
    });
    expect(lines.join("")).toContain("launchctl print exited 1");
  });

  it("is unknown for code 0 with no top-level state, logged", async () => {
    const lines: string[] = [];
    await expect(
      launchdJob(a, answer(0, "\t\tstate = running\n"), 501, (m) => lines.push(m)),
    ).resolves.toEqual({ kind: "unknown" });
    expect(lines.join("")).toContain("launchctl print gave no known state");
  });

  it("is unknown when the runner throws", async () => {
    const run = async () => {
      throw new Error("boom");
    };
    await expect(launchdJob(a, run, 501, () => {})).resolves.toEqual({ kind: "unknown" });
  });

  it("is unknown with no runner, and logs nothing", async () => {
    const lines: string[] = [];
    await expect(launchdJob(a, undefined, 501, (m) => lines.push(m))).resolves.toEqual({
      kind: "unknown",
    });
    expect(lines).toEqual([]);
  });

  it("never logs stdout", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    await launchdJob(a, answer(0, "\tstate = leak-me\n"), 501, log);
    await launchdJob(a, answer(1, PRINT_RUNNING), 501, log, () => LOG_REPEAT_MS * 2);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain("leak-me");
  });
});

describe("makeLaunchctl", () => {
  const fake = (): {
    spawnFn: typeof spawn;
    calls: unknown[][];
    child: EventEmitter & { stdout: EventEmitter };
  } => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    const calls: unknown[][] = [];
    const spawnFn = ((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as unknown as typeof spawn;
    return { spawnFn, calls, child };
  };

  it("pipes only stdout", async () => {
    const { spawnFn, calls, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "gui/501/x"]);
    child.emit("close", 113, null);
    await expect(p).resolves.toEqual({ code: 113, stdout: "" });
    expect(calls[0]?.[0]).toBe("launchctl");
    expect(calls[0]?.[1]).toEqual(["print", "gui/501/x"]);
    expect(calls[0]?.[2]).toMatchObject({ stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    expect(LAUNCHCTL_TIMEOUT_MS).toBe(5000);
  });

  it("collects stdout", async () => {
    const { spawnFn, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "x"]);
    child.stdout.emit("data", Buffer.from("a\n"));
    child.stdout.emit("data", Buffer.from("b\n"));
    child.emit("close", 0, null);
    await expect(p).resolves.toEqual({ code: 0, stdout: "a\nb\n" });
  });

  it("keeps the first 64 KiB", async () => {
    const { spawnFn, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "x"]);
    child.stdout.emit("data", Buffer.alloc(40_000, 97));
    child.stdout.emit("data", Buffer.alloc(40_000, 97));
    child.emit("close", 0, null);
    expect((await p).stdout.length).toBe(LAUNCHCTL_STDOUT_MAX);
  });

  it("rejects once when `error` is followed by close(-2) (ENOENT ordering)", async () => {
    const { spawnFn, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "x"]);
    child.emit("error", new Error("spawn launchctl ENOENT"));
    child.emit("close", -2, null);
    await expect(p).rejects.toThrow("ENOENT");
  });

  it("a real spawn that outlives the timeout is killed and rejects with the signal", async () => {
    const started = Date.now();
    await expect(makeLaunchctl(realSpawn, "sleep", 100)(["30"])).rejects.toThrow("SIGTERM");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a real spawn resolves with the exit code", async () => {
    await expect(makeLaunchctl(realSpawn, "false", 5000)([])).resolves.toEqual({
      code: 1,
      stdout: "",
    });
  });

  it("a real spawn returns stdout", async () => {
    await expect(makeLaunchctl(realSpawn, "printf", 5000)(["x\\n"])).resolves.toEqual({
      code: 0,
      stdout: "x\n",
    });
  });

  it("rejects when it could not run", async () => {
    const { spawnFn, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "x"]);
    child.emit("error", new Error("spawn launchctl ENOENT"));
    await expect(p).rejects.toThrow("ENOENT");
  });

  it("rejects when killed by a signal (timeout)", async () => {
    const { spawnFn, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "x"]);
    child.emit("close", null, "SIGTERM");
    await expect(p).rejects.toThrow("SIGTERM");
  });
});
