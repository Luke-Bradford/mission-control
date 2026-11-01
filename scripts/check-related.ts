/** Resolve the comparison before Vitest: passWithNoTests must not hide an unreadable git base. */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function relatedBase(cwd: string): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const base = git("rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))
    throw new Error("origin/HEAD did not resolve to a commit.");
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  const common = git("merge-base", base, head);
  // Verify the comparison itself: Vitest's no-tests success cannot prove git read it.
  git("diff", "--name-only", "-z", common, head, "--");
  return base;
}

export function checkRelated(cwd: string): number {
  let base: string;
  try {
    base = relatedBase(cwd);
  } catch {
    console.error(
      "Affected tests not run: cannot compare HEAD with origin/HEAD. The controller must repair or fetch the clone's default-branch ref and history.",
    );
    return 1;
  }
  const result = spawnSync("pnpm", ["-s", "test", `--changed=${base}`], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) console.error(`Affected tests could not start: ${result.error.message}`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = checkRelated(process.cwd());
