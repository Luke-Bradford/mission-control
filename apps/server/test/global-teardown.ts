import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** This checkout's root: only processes started from it count, so another checkout's suite is left alone. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** What the server tests start and must end: a keeper and the fake CLI under it. */
const LEFTOVERS = [
  "apps/server/src/runtime/keeper-cli.ts",
  "apps/server/test/fixtures/fake-claude.mjs",
];
const WAIT_MS = 3000;

/** The pid and command of every process of this checkout's tests that is still running. */
function leftovers(): string[] {
  const ps = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  return ps
    .split("\n")
    .filter((line) => LEFTOVERS.some((name) => line.includes(`${ROOT}${name}`)))
    .map((line) => line.trim());
}

/**
 * Runs once after the whole suite, and fails it when a keeper or a fake CLI a test started is still
 * running: a test that leaves one behind leaks it for hours (25 keepers did, on 23 October).
 */
export async function teardown(): Promise<void> {
  let left = leftovers();
  // a process that was just told to end may take a moment to go
  for (const t0 = Date.now(); left.length > 0 && Date.now() - t0 < WAIT_MS; left = leftovers()) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (left.length > 0) {
    throw new Error(`the server tests left processes running:\n${left.join("\n")}`);
  }
}
