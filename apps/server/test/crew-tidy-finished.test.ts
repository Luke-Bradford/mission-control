import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prView } from "../../web/test/fixtures.ts";
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
