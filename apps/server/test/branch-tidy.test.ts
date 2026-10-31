import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_LOOP, type PullRequestView, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBranchTidy, isKept, SWEEP_MIN_AGE_MS } from "../src/branch-tidy.ts";
import type { CcConfig } from "../src/config.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const HOUR = 60 * 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-tidy-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = (keepBranches: string[] = []) =>
  ({ repos: [{ id: "mc", github: "o/mc", keepBranches }] }) as unknown as CcConfig;

const run = (id: string, branch: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 10 * HOUR,
  endedAt: null,
  status: "running",
  sessionId: "s",
  model: "haiku",
  branch,
  ticket: "mc#1",
  ticketTitle: "x",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const pr = (number: number, branch: string, state: PullRequestView["state"]): PullRequestView => ({
  repoId: "mc",
  number,
  headSha: "a",
  title: "x",
  url: `https://github.com/o/mc/pull/${number}`,
  branch,
  ticket: "mc#1",
  state,
  isDraft: false,
  review: null,
  ci: null,
  createdAt: NOW - 48 * HOUR,
  updatedAt: NOW - 24 * HOUR,
  mergedAt: null,
  mergeable: null,
});

/** GitHub as the tidy sees it: branches with ages in hours, branches with an open PR, and the DELETEs it gets. */
function fakeGh(branches: Record<string, number>, openHeads: string[], openBases: string[] = []) {
  const deleted: string[] = [];
  const gh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const nodes = Object.entries(branches).map(([name, hours]) => ({
        name,
        target: { committedDate: new Date(NOW - hours * HOUR).toISOString() },
      }));
      const data = {
        repository: {
          defaultBranchRef: { name: "main" },
          refs: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      const open = openHeads.map((h, i) => ({
        headRefName: h,
        baseRefName: openBases[i] ?? "main",
      }));
      return { code: 0, stdout: JSON.stringify(open), stderr: "" };
    }
    if (args[0] === "api" && args.includes("DELETE")) {
      deleted.push(args.at(-1) ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { gh, deleted };
}

const tidyWith = (gh: GhRunner, keep: string[] = []) =>
  createBranchTidy({
    config: config(keep),
    store,
    gh,
    dbPath: join(dir, "db.sqlite"),
    inClone: (_c, fn) => fn(),
    now: () => NOW,
  });

const ref = (b: string) => `repos/o/mc/git/refs/heads/${b}`;

it("closing a crew PR unmerged deletes its branch; an archive branch and a kept one survive", async () => {
  store.upsertPullRequests(
    "mc",
    [
      pr(1, "feature/1-closed", "closed"),
      pr(2, "archive/feature/2-closed", "closed"),
      pr(3, "feature/3-merged", "merged"),
      pr(4, "feature/4-kept", "closed"),
    ],
    NOW,
  );
  const { gh, deleted } = fakeGh(
    {
      "feature/1-closed": 1,
      "archive/feature/2-closed": 1,
      "feature/3-merged": 1,
      "feature/4-kept": 1,
      main: 1,
    },
    [],
  );
  const done = await tidyWith(gh, ["feature/4-*"]).closedPass();
  expect(done).toEqual(["mc:feature/1-closed"]);
  expect(deleted).toEqual([ref("feature/1-closed")]);
  expect(store.hubEvents(0).map((e) => e.text)).toEqual([
    "Deleted branch feature/1-closed in o/mc: its PR closed unmerged",
  ]);
});

it("keeps a closed PR's branch while another PR is open on it or a run is live on it", async () => {
  store.upsertPullRequests(
    "mc",
    [pr(1, "feature/1-a", "closed"), pr(2, "feature/2-b", "closed")],
    NOW,
  );
  store.upsertRun(run("live", "feature/2-b", { loop: { ...NEW_LOOP, prNumber: 2 } }));
  const { gh, deleted } = fakeGh({ "feature/1-a": 1, "feature/2-b": 1 }, ["feature/1-a"]);
  expect(await tidyWith(gh).closedPass()).toEqual([]);
  expect(deleted).toEqual([]);
});

it("the sweep deletes an orphan older than 24 hours and keeps open-PR, live-run, young, kept and stacked-on branches", async () => {
  store.upsertRun(run("live", "feature/live", {}));
  store.upsertRun(run("ended", "feature/ended", { endedAt: NOW - HOUR, status: "ok" }));
  const { gh, deleted } = fakeGh(
    {
      main: 500,
      "feature/orphan": SWEEP_MIN_AGE_MS / HOUR + 1,
      "feature/ended": 48,
      "feature/open": 100,
      "feature/live": 100,
      "feature/young": 23,
      "feature/base": 100,
      "archive/old": 900,
      "keep/me": 900,
    },
    ["feature/open", "feature/top"],
    ["main", "feature/base"],
  );
  const done = await tidyWith(gh, ["keep/*"]).sweep();
  expect(done.sort()).toEqual(["mc:feature/ended", "mc:feature/orphan"]);
  expect(deleted.sort()).toEqual([ref("feature/ended"), ref("feature/orphan")]);
  expect(store.hubEvents(0)).toHaveLength(2);
});

it("deletes nothing when GitHub cannot be read", async () => {
  const { gh, deleted } = fakeGh({ "feature/orphan": 100 }, []);
  const broken: GhRunner = async (args, o) =>
    args[0] === "pr" ? { code: 1, stdout: "", stderr: "HTTP 502" } : gh(args, o);
  expect(await tidyWith(broken).sweep()).toEqual([]);
  expect(deleted).toEqual([]);
});

it("never deletes a branch name that is not path-safe", async () => {
  const { gh, deleted } = fakeGh({ "feature/a b": 100, "feature/a%2e": 100 }, []);
  expect(await tidyWith(gh).sweep()).toEqual([]);
  expect(deleted).toEqual([]);
});

it("keeps the default branch, archive/* and the keep-list", () => {
  expect(isKept("main", "main", [])).toBe(true);
  expect(isKept("archive/x", "main", [])).toBe(true);
  expect(isKept("release/1", "main", ["release/*"])).toBe(true);
  expect(isKept("exact", "main", ["exact"])).toBe(true);
  expect(isKept("exactly", "main", ["exact"])).toBe(false);
});

it("drops a seat clone's merged and remote-gone branches, and keeps a live run's and a checked-out one", async () => {
  const sh = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd,
      encoding: "utf8",
    });
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, clone);
  sh(clone, "checkout", "-q", "-b", "main");
  sh(clone, "commit", "-q", "--allow-empty", "-m", "init");
  sh(clone, "push", "-q", "origin", "main");
  sh(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  sh(clone, "remote", "set-head", "origin", "main");
  // merged: no commits beyond main; gone: pushed with tracking, then deleted on origin
  for (const b of ["merged", "live", "wt"]) sh(clone, "branch", b);
  sh(clone, "checkout", "-q", "-b", "gone");
  sh(clone, "commit", "-q", "--allow-empty", "-m", "gone work");
  sh(clone, "push", "-q", "-u", "origin", "gone");
  sh(clone, "checkout", "-q", "main");
  sh(clone, "worktree", "add", "-q", join(dir, "wt"), "wt");
  sh(origin, "update-ref", "-d", "refs/heads/gone");
  store.upsertRun(run("live", "live"));

  const tidy = createBranchTidy({
    config: {
      repos: [{ id: "mc", github: "o/mc" }],
      crew: { sessions: [{ repoId: "mc", checkout: clone }] },
    } as unknown as CcConfig,
    store,
    gh: async () => ({ code: 1, stdout: "", stderr: "" }),
    dbPath: join(dir, "db.sqlite"),
    inClone: (_c, fn) => fn(),
    now: () => NOW,
  });
  expect((await tidy.pruneLocal()).sort()).toEqual(["mc:gone", "mc:merged"]);
  expect(
    sh(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads")
      .split("\n")
      .filter(Boolean)
      .sort(),
  ).toEqual(["live", "main", "wt"]);
});
