import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentBranch } from "../src/collectors/git-head.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-githead-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("currentBranch", () => {
  it("reads HEAD of a normal repo", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/3714-x\n");
    expect(currentBranch(dir)).toBe("feature/3714-x");
  });

  it("follows the gitdir file of a linked worktree (absolute and relative)", () => {
    const gitdir = join(dir, "main", ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/studio-1600-x\n");
    const wt = join(dir, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(currentBranch(wt)).toBe("feat/studio-1600-x");

    const wt2 = join(dir, "main", "wt2");
    mkdirSync(wt2);
    writeFileSync(join(wt2, ".git"), "gitdir: ../.git/worktrees/wt\n");
    expect(currentBranch(wt2)).toBe("feat/studio-1600-x");
  });

  it("returns null for a detached HEAD", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), `${SHA}\n`);
    expect(currentBranch(dir)).toBeNull();
  });

  it("returns null for a missing .git, a dangling gitdir, or garbage", () => {
    expect(currentBranch(dir)).toBeNull();
    expect(currentBranch(join(dir, "nope"))).toBeNull();
    writeFileSync(join(dir, ".git"), "gitdir: /does/not/exist\n");
    expect(currentBranch(dir)).toBeNull();
    writeFileSync(join(dir, ".git"), "garbage");
    expect(currentBranch(dir)).toBeNull();
  });
});
