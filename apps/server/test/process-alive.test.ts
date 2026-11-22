import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processAlive } from "../src/guard/process-alive.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";

skipTestsIf(await blockedHere("ps"));

it("sees a shell running the command in the worktree, and not once it exits", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "alive-")));
  const command = `sleep 30 # mc-alive-${process.pid}`;
  const child = spawn("/bin/sh", ["-c", command], { cwd: dir, stdio: "ignore" });
  try {
    expect(await processAlive(dir, command)).toBe(true);
    expect(await processAlive(join(dir, "elsewhere"), command)).toBe(false);
    expect(await processAlive(dir, `${command}-other`)).toBe(false);
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once("exit", r));
  expect(await processAlive(dir, command)).toBe(false);
});
