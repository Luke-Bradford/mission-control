import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { crewGuardDecision } from "../src/guard/decision.ts";

const config = { repos: [{ id: "r", github: "o/r" }] } as unknown as CcConfig;
const verdict = (worktree: string, command: string) =>
  crewGuardDecision(
    config,
    "r",
    "writer",
    { tool: "Bash", input: { command } },
    undefined,
    [],
    worktree,
    worktree,
    true,
  );

it("FLIGHT may merge on a detached HEAD, never on main or an unreadable checkout", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-flight-detached-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "a");
    git("add", "a");
    git("commit", "-q", "-m", "a");
    expect(verdict(dir, "git merge origin/main").kind).toBe("deny");
    git("checkout", "-q", "--detach");
    expect(verdict(dir, "git merge origin/main")).toEqual({ kind: "allow" });
    expect(verdict(dir, "git commit -am resolve")).toEqual({ kind: "allow" });
    // a push of the result to main stays refused
    expect(verdict(dir, "git push origin HEAD:main").kind).toBe("deny");
    // a checkout that cannot be read is still refused
    expect(verdict(join(dir, "missing"), "git merge origin/main").kind).toBe("deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
