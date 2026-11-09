/** Resolve the comparison before Vitest: passWithNoTests must not hide an unreadable git base. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

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

export async function checkRelated(cwd: string): Promise<number> {
  let base: string;
  try {
    base = relatedBase(cwd);
  } catch {
    console.error(
      "Affected tests not run: cannot compare HEAD with origin/HEAD. The controller must repair or fetch the clone's default-branch ref and history.",
    );
    return 1;
  }
  // Keep the complete output on disk: large failures must survive without a maxBuffer limit.
  const args = ["-s", "test", `--changed=${base}`, "--reporter=dot", "--silent=passed-only"];
  const dir = mkdtempSync(join(tmpdir(), "mc-related-output-"));
  const fd = openSync(join(dir, "output"), "w+", 0o600);
  try {
    const result = spawnSync("pnpm", args, { cwd, stdio: ["inherit", fd, fd] });
    if (result.status === 0) {
      const size = fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(size, 64 * 1024));
      readSync(fd, tail, 0, tail.length, size - tail.length);
      const summary = stripVTControlCharacters(tail.toString())
        .split(/\r?\n/)
        .filter((line) =>
          /^\s*(Test Files|Tests|Start at|Duration|No test files found)\b/.test(line),
        )
        .slice(-5);
      console.log(summary.length ? summary.join("\n") : "Affected tests passed.");
      return 0;
    }
    await pipeline(createReadStream(join(dir, "output")), process.stdout, { end: false });
    if (result.error) console.error(`Affected tests could not start: ${result.error.message}`);
    if (result.signal) console.error(`Affected tests ended on signal ${result.signal}.`);
    return result.status ?? 1;
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await checkRelated(process.cwd());
