import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BoardItem, PullRequestView, Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepBugEscapes } from "../src/bug-escapes/sweep.ts";
import { type GitExec, realGitExec } from "../src/repo/files.ts";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
let dir: string;
let repo: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-bugsweep-"));
  repo = join(dir, "clone");
  mkdirSync(repo);
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const git = (...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=F",
      "-c",
      "user.email=f@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const commit = (message: string): string => {
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

/** Two merged PRs: #7 brings a bug in, #9 fixes it. Returns the fix's merge commit. */
function fixture(): { introducing: string; fix: string } {
  git("init", "-q", "-b", "main");
  put("src/price.ts", "export const total = (x) => x + 1;\nexport const z = 3;\n");
  commit("base");
  git("checkout", "-qb", "feature/7-tax");
  put("src/price.ts", "export const total = (x) => x + tax(x);\nexport const z = 3;\n");
  const introducing = commit("feat: tax");
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-qm", "Merge pull request #7 from x/feature/7-tax", "feature/7-tax");
  git("checkout", "-qb", "feature/9-fix");
  put("src/price.ts", "export const total = (x) => x + tax(x) + 0;\nexport const z = 3;\n");
  commit("fix: total");
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-qm", "Merge pull request #9 from x/feature/9-fix", "feature/9-fix");
  return { introducing, fix: git("rev-parse", "HEAD") };
}

const pr = (number: number, over: Partial<PullRequestView>): PullRequestView => ({
  repoId: "r1",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}`,
  ticket: null,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 20 * DAY,
  updatedAt: NOW - 5 * DAY,
  mergedAt: NOW - 5 * DAY,
  headSha: null,
  mergeCommitSha: null,
  mergeable: null,
  checks: [],
  ...over,
});

const bug = (over: Partial<BoardItem>): BoardItem => ({
  repoId: "r1",
  issueNumber: 20,
  title: "Totals ignore tax",
  status: "Done",
  state: "done",
  labels: ["bug"],
  assignees: [],
  priority: null,
  updatedAt: NOW - DAY,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: true,
  prioritySource: null,
  createdAt: NOW - 2 * DAY,
  itemId: null,
  projectId: null,
  ...over,
});

const config = () =>
  ({
    repos: [{ id: "r1" }],
    crew: { sessions: [{ repoId: "r1", checkout: repo }] },
  }) as unknown as Parameters<typeof sweepBugEscapes>[0]["config"];

/** Git that only reads: any command that could write or reach a remote fails the test. */
const READ_ONLY = new Set(["version", "rev-parse", "diff", "blame", "log", "diff-tree"]);
const calls: string[][] = [];
const exec: GitExec = async (args) => {
  const sub = args.find(
    (a, i) => !a.startsWith("-") && (i === 0 || (args[i - 1] !== "-C" && args[i - 1] !== "-c")),
  );
  calls.push(args);
  if (sub === undefined || !READ_ONLY.has(sub)) throw new Error(`not read-only: ${sub}`);
  return realGitExec(args);
};

function seed(fix: string) {
  store.upsertPullRequests(
    "r1",
    [
      pr(7, { ticket: "r1#5", mergedAt: NOW - 10 * DAY }),
      pr(9, { ticket: "r1#20", mergeCommitSha: fix }),
    ],
    NOW,
  );
  store.replaceBoard("r1", [bug({})]);
}

describe("sweepBugEscapes", () => {
  it("records the introducing commit, PR, why it was missed and the time to discovery", async () => {
    const { introducing, fix } = fixture();
    seed(fix);
    expect(await sweepBugEscapes({ config: config(), store, exec })).toBe(1);
    expect(store.audit(0, NOW).bugEscapes).toEqual([
      {
        repoId: "r1",
        issue: 20,
        filedAt: NOW - 2 * DAY,
        fixPr: 9,
        commit: introducing,
        introducedPr: 7,
        mergedAt: NOW - 10 * DAY,
        missed: "review",
        discoveryMs: 8 * DAY,
      },
    ]);
  });

  it("names a missed class from the introducing PR's own records", async () => {
    const { fix } = fixture();
    seed(fix);
    store.upsertRun({
      id: "a1",
      agentId: "guido-1",
      repoId: "r1",
      seq: 1,
      startedAt: NOW - 12 * DAY,
      endedAt: NOW - 10 * DAY,
      status: "ok",
      sessionId: null,
      model: "m",
      branch: null,
      ticket: "r1#5",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    } as Run);
    store.setRunDoneWhen("a1", ["Logo is blue"]);
    (store as unknown as { db: { exec(s: string): void } }).db.exec(
      `INSERT INTO reviews (author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, created_at)
       VALUES ('a1', 'r1', 'retro-1', 7, 'abc', 1, 1, 1, 'reported', 1)`,
    );
    await sweepBugEscapes({ config: config(), store, exec });
    expect(store.audit(0, NOW).bugEscapes?.[0]?.missed).toBe("requirement");
  });

  it("adds no duplicate on a second run, and reads nothing but local git", async () => {
    const { fix } = fixture();
    seed(fix);
    await sweepBugEscapes({ config: config(), store, exec });
    expect(await sweepBugEscapes({ config: config(), store, exec })).toBe(0);
    expect(store.audit(0, NOW).bugEscapes).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flat()).not.toContain("fetch");
  });

  it("skips open bugs, bugs without a merged fix and non-bug tickets", async () => {
    const { fix } = fixture();
    seed(fix);
    // 22 is not a bug, even with a fix PR; 21 is a closed bug with no fix PR on record
    store.upsertPullRequests("r1", [pr(10, { ticket: "r1#22", mergeCommitSha: fix })], NOW);
    store.replaceBoard("r1", [
      bug({ closed: false }),
      bug({ issueNumber: 21 }),
      bug({ issueNumber: 22, labels: ["feature"] }),
    ]);
    expect(await sweepBugEscapes({ config: config(), store, exec })).toBe(0);
    expect(store.audit(0, NOW).bugEscapes).toEqual([]);
  });

  it("serves rows newest filed first within the range", async () => {
    const { fix } = fixture();
    seed(fix);
    const db = (store as unknown as { db: { exec(s: string): void } }).db;
    db.exec(
      `INSERT INTO bug_escapes VALUES ('r1', 30, ${NOW - 20 * DAY}, 9, 'c', NULL, ${NOW - 30 * DAY}, 'none')`,
    );
    await sweepBugEscapes({ config: config(), store, exec });
    expect(store.audit(0, NOW).bugEscapes?.map((e) => e.issue)).toEqual([20, 30]);
    expect(store.audit(NOW - 5 * DAY, NOW).bugEscapes?.map((e) => e.issue)).toEqual([20]);
  });
});
