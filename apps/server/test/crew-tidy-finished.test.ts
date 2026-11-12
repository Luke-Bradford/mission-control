import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { boardItem, prView } from "../../web/test/fixtures.ts";
import type { CcConfig } from "../src/config.ts";
import { createCrewTidy } from "../src/flight/tidy.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 12);
let root: string;
let store: Store;
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
  });

const config = (): CcConfig =>
  ({
    crew: {
      worktrees: join(root, "wt"),
      sessions: [
        {
          id: "s1",
          repoId: "mc",
          checkout: join(root, "clone"),
          seats: [{ id: "guido-1", role: "GUIDO", accountId: "a", model: "opus", area: [] }],
        },
      ],
    },
  }) as unknown as CcConfig;

const run = (id: string, branch: string): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 1000,
  endedAt: NOW - 500,
  status: "ok",
  sessionId: "cli",
  model: "opus",
  branch,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mc-tidyfin-")));
  execFileSync("git", ["init", "-q", "-b", "main", join(root, "clone")]);
  writeFileSync(join(root, "clone", ".gitignore"), "node_modules\n");
  git(join(root, "clone"), "add", ".gitignore");
  git(join(root, "clone"), "commit", "-q", "-m", "init");
  mkdirSync(join(root, "wt"));
  store = new Store(":memory:");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const worktree = (name: string, branch: string): string => {
  const wt = join(root, "wt", name);
  git(join(root, "clone"), "worktree", "add", "-q", "-b", branch, wt);
  mkdirSync(join(wt, "node_modules"));
  writeFileSync(join(wt, "node_modules", "dep"), "x".repeat(50));
  return wt;
};

it("removes the worktree of a finished PR's ended run and trims a set-aside run's node_modules", async () => {
  const done = worktree("guido-1-1", "mc/1");
  const aside = worktree("guido-1-2", "mc/2");
  store.upsertRun(run("r1", "mc/1"));
  store.upsertRun(run("r2", "mc/2"));
  store.upsertPullRequests(
    "mc",
    [
      prView({ repoId: "mc", number: 1, branch: "mc/1", state: "merged" }),
      prView({ repoId: "mc", number: 2, branch: "mc/2", state: "open" }),
    ],
    NOW,
  );
  const tidy = createCrewTidy({ config: config(), store, pruneLocal: async () => [] });
  const r = await tidy.tidyFinished(NOW);
  expect(existsSync(done)).toBe(false);
  expect(existsSync(aside)).toBe(true);
  expect(existsSync(join(aside, "node_modules"))).toBe(false);
  expect(r.removed).toEqual(["r1"]);
  expect(r.trimmed).toEqual(["r2"]);
});

const prs = (state: "open" | "closed" | "merged", branch: string, number: number) =>
  store.upsertPullRequests("mc", [prView({ repoId: "mc", number, branch, state })], NOW);
const tidyOf = (extra: Partial<Parameters<typeof createCrewTidy>[0]> = {}) =>
  createCrewTidy({ config: config(), store, pruneLocal: async () => [], ...extra });

it("removes the worktree of a closed (not merged) PR", async () => {
  const wt = worktree("guido-1-4", "mc/4");
  store.upsertRun(run("r4", "mc/4"));
  prs("closed", "mc/4", 4);
  expect((await tidyOf().tidyFinished(NOW)).removed).toEqual(["r4"]);
  expect(existsSync(wt)).toBe(false);
});

it("removes the worktree of an ended run whose ticket is closed and that has no PR", async () => {
  const wt = worktree("guido-1-3", "mc/3");
  store.upsertRun({ ...run("r3", "mc/3"), ticket: "mc#3" });
  store.replaceBoard("mc", [boardItem({ repoId: "mc", issueNumber: 3, state: "done" })]);
  expect((await tidyOf().tidyFinished(NOW)).removed).toEqual(["r3"]);
  expect(existsSync(wt)).toBe(false);
});

it("leaves a worktree alone while another run is live on its branch", async () => {
  const wt = worktree("guido-1-5", "mc/5");
  store.upsertRun(run("r5", "mc/5"));
  store.upsertRun({ ...run("r5b", "mc/5"), endedAt: null, status: "running" });
  prs("merged", "mc/5", 5);
  const r = await tidyOf().tidyFinished(NOW);
  expect(r).toEqual({ removed: [], trimmed: [] });
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
});

it("leaves a worktree a seat still holds", async () => {
  const wt = worktree("guido-1-6", "mc/6");
  store.upsertRun(run("r6", "mc/6"));
  store.setSeatSession({
    seatId: "guido-1",
    runId: null,
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: wt,
    updatedAt: NOW,
  });
  const r = await tidyOf().tidyFinished(NOW);
  expect(r).toEqual({ removed: [], trimmed: [] });
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
});

it("waits for the clone lock, then skips a branch a run went live on meanwhile", async () => {
  const wt = worktree("guido-1-7", "mc/7");
  store.upsertRun(run("r7", "mc/7"));
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let started = false;
  // a pretend prepareCheckout: it holds the lock while the run is not yet recorded
  const inClone = async <T>(_c: string, fn: () => Promise<T>): Promise<T> => {
    await held;
    started = true;
    return await fn();
  };
  const cycle = tidyOf({ inClone }).tidyFinished(NOW);
  await new Promise((r) => setTimeout(r, 20));
  expect(started).toBe(false);
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
  store.upsertRun({ ...run("r7b", "mc/7"), endedAt: null, status: "running" });
  release();
  expect(await cycle).toEqual({ removed: [], trimmed: [] });
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
});
