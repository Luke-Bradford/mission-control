import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MapConflicts } from "../src/map/conflicts.ts";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const pr = (branch: string, headSha: string | null, state: PullRequestView["state"] = "open") => ({
  branch,
  headSha,
  state,
});
let base: string;
let left: string;
let right: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-conflicts-"));
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "left");
  writeFileSync(join(dir, "file.txt"), "left\n");
  git("commit", "-qam", "left");
  left = git("rev-parse", "HEAD");
  git("checkout", "-qb", "right", base);
  writeFileSync(join(dir, "file.txt"), "right\n");
  git("commit", "-qam", "right");
  right = git("rev-parse", "HEAD");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function contents(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(contents(full)))
        out[`${entry.name}/${name}`] = value;
    } else {
      const stat = statSync(full);
      out[entry.name] = JSON.stringify([
        readFileSync(full).toString("base64"),
        stat.mtimeMs,
        stat.mode,
      ]);
    }
  }
  return out;
}

it("reports computed conflicts naming both open PR branches and their stored tips", async () => {
  // Branch refs deliberately differ from the stored PR tips.
  git("branch", "-f", "left", base);
  expect(await new MapConflicts().read(dir, [pr("left", left), pr("right", right)])).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
});

it("leaves every file in the source checkout and object store unchanged", async () => {
  const before = contents(dir);
  await new MapConflicts().read(dir, [pr("left", left), pr("right", right)]);
  expect(contents(dir)).toEqual(before);
});

it("ignores closed PRs and missing tips, and never calls clean overlap a conflict", async () => {
  expect(
    await new MapConflicts().read(dir, [
      pr("left", left),
      pr("closed", right, "closed"),
      pr("missing", null),
      pr("invalid", "--help"),
      pr("merged", right, "merged"),
      pr("base", base),
    ]),
  ).toEqual([]);
});

it("caches by unordered SHA pair, retains current branch names and invalidates changed tips", async () => {
  const collector = new MapConflicts();
  await collector.read(dir, [pr("left", left), pr("right", right)]);
  git("checkout", "--detach", base);
  git("branch", "-D", "left", "right");
  // A cached pair needs no object reads, even in the reverse order.
  rmSync(join(dir, ".git", "objects"), { recursive: true });
  expect(await collector.read(dir, [pr("renamed-right", right), pr("renamed-left", left)])).toEqual(
    [{ file: "file.txt", branches: ["renamed-right", "renamed-left"], shas: [right, left] }],
  );
  await expect(collector.read(dir, [pr("left", left), pr("new", base)])).rejects.toThrow();
});

it("does not cache an unavailable pair as a clean merge", async () => {
  const collector = new MapConflicts();
  await expect(
    collector.read(dir, [pr("left", left), pr("missing", "a".repeat(40))]),
  ).rejects.toThrow();
  expect(await collector.read(dir, [pr("left", left), pr("right", right)])).toHaveLength(1);
});

it("reads linked worktree objects without changing either checkout", async () => {
  const linked = join(dir, "linked");
  git("worktree", "add", "--detach", linked, base);
  const before = contents(dir);
  expect(await new MapConflicts().read(linked, [pr("left", left), pr("right", right)])).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
  expect(contents(dir)).toEqual(before);
});
