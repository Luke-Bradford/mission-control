import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processAlive } from "../src/guard/process-alive.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";

skipTestsIf(await blockedHere("ps"));

it("sees a node process running in the worktree, and not once it exits or elsewhere", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "alive-")));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: dir,
    stdio: "ignore",
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(await processAlive(dir)).toBe(true);
    expect(await processAlive(join(dir, "elsewhere"))).toBe(false);
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once("exit", r));
  expect(await processAlive(dir)).toBe(false);
});
