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

/** The conflicts, or a rejection when any pair went unchecked: never a clean report by omission. */
async function strict(collector: MapConflicts, worktree: string, prs: ReturnType<typeof pr>[]) {
  const { conflicts, unchecked } = await collector.check(worktree, prs);
  if (unchecked.length > 0) throw new Error(`unchecked: ${JSON.stringify(unchecked)}`);
  return conflicts;
}

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
  expect(await strict(new MapConflicts(), dir, [pr("left", left), pr("right", right)])).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
});

it("leaves every file in the source checkout and object store unchanged", async () => {
  const before = contents(dir);
  await strict(new MapConflicts(), dir, [pr("left", left), pr("right", right)]);
  expect(contents(dir)).toEqual(before);
});

it("ignores closed PRs and missing tips, and never calls clean overlap a conflict", async () => {
  expect(
    await strict(new MapConflicts(), dir, [
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
  await strict(collector, dir, [pr("left", left), pr("right", right)]);
  git("checkout", "--detach", base);
  git("branch", "-D", "left", "right");
  // A cached pair needs no object reads, even in the reverse order.
  rmSync(join(dir, ".git", "objects"), { recursive: true });
  expect(
    await strict(collector, dir, [pr("renamed-right", right), pr("renamed-left", left)]),
  ).toEqual([
    { file: "file.txt", branches: ["renamed-right", "renamed-left"], shas: [right, left] },
  ]);
  await expect(strict(collector, dir, [pr("left", left), pr("new", base)])).rejects.toThrow();
});

it("does not cache an unavailable pair as a clean merge", async () => {
  const collector = new MapConflicts();
  await expect(
    strict(collector, dir, [pr("left", left), pr("missing", "a".repeat(40))]),
  ).rejects.toThrow();
  expect(await strict(collector, dir, [pr("left", left), pr("right", right)])).toHaveLength(1);
});

it("reads linked worktree objects without changing either checkout", async () => {
  const linked = join(dir, "linked");
  git("worktree", "add", "--detach", linked, base);
  const before = contents(dir);
  expect(await strict(new MapConflicts(), linked, [pr("left", left), pr("right", right)])).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
  expect(contents(dir)).toEqual(before);
});

it("skips a pair whose head the checkout has not fetched, keeping the rest of the snapshot", async () => {
  const missing = "f".repeat(40);
  const result = await new MapConflicts().check(dir, [
    pr("left", left),
    pr("right", right),
    pr("unfetched", missing),
  ]);
  expect(result.unchecked).toEqual([{ branch: "unfetched", reason: "head not fetched" }]);
  expect(result.conflicts).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
});

it("fails rather than reporting unchecked when the checkout itself is broken", async () => {
  const gone = join(dir, "not-a-checkout");
  await expect(
    new MapConflicts().check(gone, [pr("left", left), pr("right", right)]),
  ).rejects.toThrow();
});

it("names an unfetched head unchecked, never clean", async () => {
  const result = await new MapConflicts().check(dir, [
    pr("left", left),
    pr("unfetched", "e".repeat(40)),
  ]);
  expect(result.conflicts).toEqual([]);
  expect(result.unchecked).toEqual([{ branch: "unfetched", reason: "head not fetched" }]);
});

it("blames only the unrelated tip, holds its failed pairs until a head changes, and logs them once", async () => {
  git("checkout", "-q", "--orphan", "orphan");
  writeFileSync(join(dir, "file.txt"), "orphan\n");
  git("add", ".");
  git("commit", "-qm", "orphan");
  const orphan = git("rev-parse", "HEAD");
  let now = 1_000_000;
  const collector = new MapConflicts(() => now);
  const prs = [pr("left", left), pr("right", right), pr("orphan", orphan)];
  const first = await collector.check(dir, prs);
  expect(first.conflicts).toEqual([
    { file: "file.txt", branches: ["left", "right"], shas: [left, right] },
  ]);
  // left and right checked against each other, so only the tip common to the failures is unknown
  expect(first.unchecked).toEqual([{ branch: "orphan", reason: "merge check failed" }]);
  expect(first.failures.map((f) => f.branches)).toEqual([
    ["left", "orphan"],
    ["right", "orphan"],
  ]);
  expect(first.failures[0]?.reason).toMatch(/^exit 128: /);
  // exit 128 is deterministic: held, still unchecked, not retried or logged again, even much later
  now += 3_600_000;
  const again = await collector.check(dir, prs);
  expect(again.failures).toEqual([]);
  expect(again.unchecked).toEqual([{ branch: "orphan", reason: "merge check failed" }]);
  // a new orphan head is a new pair: checked (and logged) afresh
  writeFileSync(join(dir, "file.txt"), "orphan 2\n");
  git("commit", "-qam", "orphan 2");
  const moved = git("rev-parse", "HEAD");
  const next = await collector.check(dir, [pr("left", left), pr("orphan", moved)]);
  expect(next.failures).toHaveLength(1);
  expect(next.unchecked).toEqual([
    { branch: "left", reason: "merge check failed" },
    { branch: "orphan", reason: "merge check failed" },
  ]);
});

it("checks a pair once its head is fetched, after the 10 s missing-head hold", async () => {
  const other = mkdtempSync(join(tmpdir(), "mc-map-conflicts-other-"));
  try {
    execFileSync("git", ["clone", "-q", dir, other]);
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", other, ...args], { encoding: "utf8" }).trim();
    run("config", "user.name", "Fixture");
    run("config", "user.email", "fixture@example.invalid");
    run("checkout", "-qb", "late", base);
    writeFileSync(join(other, "file.txt"), "late\n");
    run("commit", "-qam", "late");
    const late = run("rev-parse", "HEAD");
    let now = 1_000_000;
    const collector = new MapConflicts(() => now);
    const prs = [pr("left", left), pr("late", late)];
    expect((await collector.check(dir, prs)).unchecked).toEqual([
      { branch: "late", reason: "head not fetched" },
    ]);
    // the hold is per checkout: one that has the head is not held by another that lacks it
    expect((await collector.check(other, [pr("late", late), pr("base", base)])).unchecked).toEqual(
      [],
    );
    git("fetch", "-q", other, "late");
    now += 1_000;
    // still within the hold: git is not asked again
    expect((await collector.check(dir, prs)).unchecked).toHaveLength(1);
    now += 10_000;
    const fetched = await collector.check(dir, prs);
    expect(fetched.unchecked).toEqual([]);
    expect(fetched.conflicts).toEqual([
      { file: "file.txt", branches: ["left", "late"], shas: [left, late] },
    ]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

it("fails when the checkout is an existing directory that is not a repo", async () => {
  const plain = mkdtempSync(join(tmpdir(), "mc-map-conflicts-plain-"));
  try {
    await expect(
      new MapConflicts().check(plain, [pr("left", left), pr("right", right)]),
    ).rejects.toThrow();
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
