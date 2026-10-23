import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import {
  createPublisher,
  MC_MERGE_AUTHOR,
  prDiffKey,
  UPDATE_MERGE_IN_PROGRESS,
  UPDATE_NO_WORKTREE,
} from "../src/engine/publish.ts";
import type { McToolsDeps } from "../src/mcp/tools.ts";
import { Store } from "../src/store.ts";

const BRANCH = "feature/7-fix-the-thing";
const START = Date.parse("2026-10-21T10:00:00Z");

let dir: string;
let store: Store;
let clone: string;
let worktree: string;
let tip: string;
let mainSha: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

const config = (): CcConfig =>
  ({
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [],
    repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      sessions: [
        {
          id: "s",
          repoId: "mc",
          checkout: clone,
          seats: [{ id: "guido-1", role: "GUIDO", accountId: "a", model: "haiku", area: [] }],
        },
      ],
    },
  }) as CcConfig;

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: START,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: BRANCH,
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const publisher = () =>
  createPublisher({
    config: config(),
    store,
    bus: { emit: () => {} } as never,
    inClone: (_c, fn) => fn(),
    gh: async () => ({ code: 0, stdout: "", stderr: "" }),
    dbPath: join(dir, "mc.sqlite"),
    knownSecrets: async () => [],
    now: () => START,
  } satisfies McToolsDeps);

/** Main moves with `edit`; the branch (in its own worktree) has one commit editing apps/a.ts. */
function setup(mainEdit: (root: string) => void): void {
  const origin = join(dir, "origin.git");
  clone = join(dir, "clone");
  worktree = join(dir, "wt");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(clone, "init", "-q", "-b", "main");
  git(clone, "config", "user.name", "t");
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "remote", "add", "origin", origin);
  write(clone, "apps/a.ts", "one\ntwo\nthree\n");
  write(clone, "docs/c.md", "doc\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "main");
  git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(clone, "worktree", "add", "-q", "-b", BRANCH, worktree);
  write(worktree, "apps/a.ts", "one\nbranch\nthree\n");
  git(worktree, "commit", "-q", "-am", "branch change");
  tip = git(worktree, "rev-parse", "HEAD");
  mainEdit(clone);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "main change");
  git(clone, "push", "-q", "origin", "main");
  mainSha = git(clone, "rev-parse", "HEAD");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-update-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("prDiffKey", () => {
  const diff = (index: string, hunk: string, plus: string): string =>
    `diff --git a/x b/x\nindex ${index}\n--- a/x\n+++ b/x\n${hunk} ctx\n-old\n+${plus}\n`;

  it("ignores index lines and hunk numbers, but not the change", () => {
    const a = diff("1111..2222 100644", "@@ -1,3 +1,3 @@", "new");
    expect(prDiffKey(diff("3333..4444 100644", "@@ -10,3 +12,3 @@", "new"))).toBe(prDiffKey(a));
    expect(prDiffKey(diff("1111..2222 100644", "@@ -1,3 +1,3 @@", "other"))).not.toBe(prDiffKey(a));
  });
});

describe("updateBranch (real git)", () => {
  it("a clean merge makes an engine commit with both parents, and records it", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    store.upsertRun(run());
    const r = await publisher().updateBranch(run(), mainSha, worktree);
    const sha = git(worktree, "rev-parse", "HEAD");
    expect(r).toEqual({ ok: true, kind: "merged", sha, parent: tip, prSame: true });
    expect(git(worktree, "rev-list", "--parents", "-n1", "HEAD").split(" ").slice(1)).toEqual([
      tip,
      mainSha,
    ]);
    expect(git(worktree, "log", "-1", "--format=%an|%cn|%s")).toBe(
      `${MC_MERGE_AUTHOR}|${MC_MERGE_AUTHOR}|Merge main into ${BRANCH}`,
    );
    expect(store.branchCommits("mc", BRANCH).has(sha)).toBe(true);
    expect(readFileSync(join(worktree, "docs/c.md"), "utf8")).toBe("doc\nmore\n");
  });

  it("a clean merge that changes the PR's diff is not prSame", async () => {
    setup((root) => write(root, "apps/a.ts", "one\nbranch\nthree\n"));
    store.upsertRun(run());
    const r = await publisher().updateBranch(run(), mainSha, worktree);
    expect(r).toMatchObject({ ok: true, kind: "merged", prSame: false });
  });

  it("a conflict stays in the worktree with its markers, and names the files", async () => {
    setup((root) => write(root, "apps/a.ts", "one\nmain\nthree\n"));
    store.upsertRun(run());
    const r = await publisher().updateBranch(run(), mainSha, worktree);
    expect(r).toEqual({ ok: true, kind: "conflict", files: ["apps/a.ts"] });
    expect(readFileSync(join(worktree, "apps/a.ts"), "utf8")).toContain("<<<<<<< ");
    expect(git(worktree, "rev-parse", "MERGE_HEAD")).toBe(mainSha);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(store.branchCommits("mc", BRANCH).size).toBe(0);
  });

  it("the same conflict, asked again, is reported again", async () => {
    setup((root) => write(root, "apps/a.ts", "one\nmain\nthree\n"));
    store.upsertRun(run());
    await publisher().updateBranch(run(), mainSha, worktree);
    expect(await publisher().updateBranch(run(), mainSha, worktree)).toEqual({
      ok: true,
      kind: "conflict",
      files: ["apps/a.ts"],
    });
  });

  it("another merge in progress is refused", async () => {
    setup((root) => write(root, "apps/a.ts", "one\nmain\nthree\n"));
    store.upsertRun(run());
    await publisher().updateBranch(run(), mainSha, worktree);
    const other = git(clone, "rev-parse", "HEAD~1");
    expect(await publisher().updateBranch(run(), other, worktree)).toEqual({
      ok: false,
      text: UPDATE_MERGE_IN_PROGRESS,
      transient: false,
    });
  });

  it("a worktree with changes waits, and nothing is merged", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    store.upsertRun(run());
    write(worktree, "apps/new.ts", "seat's work\n");
    expect(await publisher().updateBranch(run(), mainSha, worktree)).toEqual({
      ok: true,
      kind: "wait",
    });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(store.branchCommits("mc", BRANCH).size).toBe(0);
  });

  it("a path that is not a worktree of the clone is refused", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    expect(await publisher().updateBranch(run(), mainSha, join(dir, "elsewhere"))).toEqual({
      ok: false,
      text: UPDATE_NO_WORKTREE,
      transient: false,
    });
  });

  it("a branch that is not the run's own is refused", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    const r = await publisher().updateBranch(run({ branch: "main" }), mainSha, worktree);
    expect(r).toMatchObject({ ok: false, transient: false });
  });

  it("a main tip only origin has (a merge made on GitHub) is fetched, then merged", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    const onOrigin = elsewhereOnMain((root) => write(root, "docs/d.md", "new\n"));
    store.upsertRun(run());
    const r = await publisher().updateBranch(run(), onOrigin, worktree);
    expect(r).toMatchObject({ ok: true, kind: "merged" });
    expect(git(worktree, "rev-list", "--parents", "-n1", "HEAD").split(" ").slice(1)).toEqual([
      tip,
      onOrigin,
    ]);
  });
});

/** Another clone moves origin's main with `edit` (a change, or its own commit), so the session clone lacks the new tip. */
function elsewhereOnMain(edit: (root: string) => void): string {
  const other = join(dir, "other");
  execFileSync("git", ["clone", "-q", join(dir, "origin.git"), other]);
  git(other, "config", "user.name", "t");
  git(other, "config", "user.email", "t@example.com");
  edit(other);
  git(other, "add", "-A");
  if (git(other, "status", "--porcelain") !== "") git(other, "commit", "-q", "-m", "elsewhere");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

describe("deleteLocalBranch (real git)", () => {
  it("deletes a branch merged on origin by a merge commit the clone has not fetched", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    git(worktree, "push", "-q", "origin", BRANCH);
    git(clone, "worktree", "remove", "--force", worktree);
    const merged = elsewhereOnMain((root) => {
      git(root, "fetch", "-q", "origin", BRANCH);
      git(root, "merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD");
    });
    const r = run({ loop: { prNumber: 12, merging: { sha: merged, done: ["merge"] } } as never });
    expect(await publisher().deleteLocalBranch(r)).toEqual({ ok: true });
    expect(git(clone, "branch", "--list", BRANCH)).toBe("");
  });

  it("localBranchGone is false while the branch exists and true once it is deleted", async () => {
    setup((root) => write(root, "docs/c.md", "doc\nmore\n"));
    git(clone, "worktree", "remove", "--force", worktree);
    expect(await publisher().localBranchGone(run({}))).toBe(false);
    git(clone, "branch", "-D", BRANCH);
    expect(await publisher().localBranchGone(run({}))).toBe(true);
  });
});
