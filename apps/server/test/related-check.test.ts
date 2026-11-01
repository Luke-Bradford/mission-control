import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { relatedBase } from "../../../scripts/check-related.ts";

it("rejects missing or unrelated default history and returns a verified immutable base", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-related-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "file"), "one");
    commit();
    expect(() => relatedBase(dir)).toThrow();
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(dir, "file"), "two");
    commit();
    expect(relatedBase(dir)).toBe(base);
    expect(relatedBase(dir)).not.toBe(git("rev-parse", "HEAD"));
    git("checkout", "--orphan", "unrelated");
    writeFileSync(join(dir, "file"), "unrelated");
    commit();
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    git("checkout", "main");
    expect(() => relatedBase(dir)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
