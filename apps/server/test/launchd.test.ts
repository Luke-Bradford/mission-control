import { spawn as realSpawn, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHCTL_TIMEOUT_MS,
  LOG_REPEAT_MS,
  launchdNote,
  makeLaunchctl,
  resetLaunchdLogState,
} from "../src/collectors/launchd.ts";
import type { AdoptedLoop } from "../src/config.ts";

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
  const failing = async () => ({ code: 1 });

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
    const other = async () => ({ code: 2 });
    await launchdNote(a, other, 501, log, () => 1);
    expect(lines).toHaveLength(2);
  });

  it("logs again after a success in between", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const a = loop("a", "com.a");
    await launchdNote(a, failing, 501, log, () => 0);
    const ok = async () => ({ code: 0 });
    await launchdNote(a, ok, 501, log, () => 1);
    await launchdNote(a, failing, 501, log, () => 2);
    expect(lines).toHaveLength(2);
  });
});

describe("makeLaunchctl", () => {
  const fake = (): { spawnFn: typeof spawn; calls: unknown[][]; child: EventEmitter } => {
    const child = new EventEmitter();
    const calls: unknown[][] = [];
    const spawnFn = ((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as unknown as typeof spawn;
    return { spawnFn, calls, child };
  };

  it("spawns launchctl with stdio ignored", async () => {
    const { spawnFn, calls, child } = fake();
    const p = makeLaunchctl(spawnFn)(["print", "gui/501/x"]);
    child.emit("close", 113, null);
    await expect(p).resolves.toEqual({ code: 113 });
    expect(calls[0]?.[0]).toBe("launchctl");
    expect(calls[0]?.[1]).toEqual(["print", "gui/501/x"]);
    expect(calls[0]?.[2]).toMatchObject({ stdio: "ignore", timeout: 5000 });
    expect(LAUNCHCTL_TIMEOUT_MS).toBe(5000);
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
    await expect(makeLaunchctl(realSpawn, "false", 5000)([])).resolves.toEqual({ code: 1 });
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
