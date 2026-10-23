import { execFileSync } from "node:child_process";

/** The pid and command of every running process whose command line names `root`. */
function running(root: string): string[] {
  const ps = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  return ps
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => line.trim());
}

/**
 * For a test file's `afterAll`: fails, listing the pids, when a keeper or fake CLI started under the
 * file's tmp `root` is still running after up to 3 s. Another file's processes name another root, so
 * files running in parallel do not see each other's.
 */
export async function expectNoLeftovers(root: string): Promise<void> {
  let left = running(root);
  for (const t0 = Date.now(); left.length > 0 && Date.now() - t0 < 3000; left = running(root)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (left.length > 0) {
    throw new Error(`processes started under ${root} are still running:\n${left.join("\n")}`);
  }
}
