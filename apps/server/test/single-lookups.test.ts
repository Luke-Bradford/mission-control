import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardItem, PullRequestView } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { questionFacts } from "../src/attention/question-watch.ts";
import { forgetGithubToken, GITHUB_TOKEN_TTL_MS, githubToken } from "../src/collectors/github.ts";
import type { AdoptedLoop } from "../src/config.ts";
import { loopPause } from "../src/loop/pause.ts";
import { STAGGERED_FIRST_DELAY_MS } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

let dir: string;
let dbPath: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-lookups-"));
  dbPath = join(dir, "mc.sqlite");
  store = new Store(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem =>
  ({
    repoId: "r",
    issueNumber: n,
    title: `t${n}`,
    status: "Todo",
    state: "planned",
    labels: [],
    priority: null,
    updatedAt: n,
    url: "u",
    stage: null,
    owner: null,
    parent: null,
    blockedBy: [],
    milestone: null,
    size: null,
    closed: false,
    prioritySource: null,
    createdAt: n,
    itemId: `i${n}`,
    projectId: "p",
    ...over,
  }) as BoardItem;

const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "r",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}-x`,
  ticket: null,
  state: "open",
  isDraft: false,
  review: null,
  ci: null,
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
  headSha: "sha",
  mergeCommitSha: null,
  mergeable: null,
  author: "a",
  assignees: [],
  checks: [],
  closingIssues: [],
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  ...over,
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

describe("single lookups", () => {
  it("no server code lists a repo's board or PRs to find one by number", () => {
    const listThenFind =
      /\.(board|pullRequests)\(((?:[^()]|\([^()]*\))*)\)\s*\.find\(\s*\(?\w+\)?\s*=>[^)]*\b(issueNumber|number)\b/;
    const offenders = sourceFiles(join(import.meta.dirname, "..", "src")).filter((file) =>
      listThenFind.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no server code lists the board or PRs into a variable, within a few lines of finding one by number", () => {
    const viaVariable =
      /const (\w+) = (?:[\w.]+\.)?store\.(?:board|pullRequests)\([^;]*\);(?:[^;]*\n){0,6}?[^;]*?\b\1\.(?:find|some)\(\s*\(?\w+\)?\s*=>[^)]*\b(?:issueNumber|number)\b/;
    const offenders = sourceFiles(join(import.meta.dirname, "..", "src")).filter((file) =>
      viaVariable.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("a loop's pause issue and a question's PR are read by key, not by listing", () => {
    store.replaceBoard("r", [card(1), card(2, { closed: true })]);
    store.upsertPullRequests("r", [pr(7)], 1);
    const board = vi.spyOn(store, "board");
    const prs = vi.spyOn(store, "pullRequests");
    const loop = (number: number) =>
      ({ pausedBy: { issue: { repoId: "r", number } } }) as unknown as AdoptedLoop;
    expect(loopPause(loop(1), store, () => "o/r")).toMatchObject({ paused: true, by: "r#1" });
    expect(loopPause(loop(2), store).paused).toBe(false);
    const facts = questionFacts(store, {
      key: "ask:1",
      askAt: 1,
      question: "q",
      ticket: "r#1",
      runId: null,
      seatId: null,
      prNumber: 7,
      operator: false,
    });
    expect(facts.ticket).toBe("open");
    expect(board).not.toHaveBeenCalled();
    expect(prs).not.toHaveBeenCalled();
  });

  it("reads one card and one PR by key", () => {
    store.replaceBoard("r", [card(1), card(2)]);
    store.upsertPullRequests("r", [pr(7), pr(8)], 1);
    expect(store.boardItem("r", 2)?.title).toBe("t2");
    expect(store.boardItem("r", 3)).toBeNull();
    expect(store.boardCardOf("r#1")?.issueNumber).toBe(1);
    expect(store.boardCardOf("r#x")).toBeNull();
    expect(store.pullRequest("r", 8)?.title).toBe("PR 8");
    expect(store.pullRequest("r", 9)).toBeNull();
  });
});

describe("board poll writes", () => {
  it("writes nothing when the board is unchanged", () => {
    store.replaceBoard("r", [card(1), card(2, { labels: ["a"] })]);
    const before = store.readVersion();
    expect(store.replaceBoard("r", [card(1), card(2, { labels: ["a"] })])).toBe(false);
    expect(store.readVersion()).toBe(before);
  });

  it("writes only the changed card and deletes only a card that left", () => {
    store.replaceBoard("r", [card(1), card(2), card(3)]);
    store.replaceBoard("other", [card(1, { repoId: "other" })]);
    const before = store.readVersion();
    expect(store.replaceBoard("r", [card(1), card(2, { title: "new" })])).toBe(true);
    const after = store.readVersion();
    expect(Number(after.split(":")[0]) - Number(before.split(":")[0])).toBe(2); // one update, one delete
    expect(store.board("r").map((c) => [c.issueNumber, c.title])).toEqual([
      [1, "t1"],
      [2, "new"],
    ]);
    expect(store.board("other")).toHaveLength(1);
  });

  it("still marks FLIGHT's pointer when a card moves", () => {
    store.replaceBoard("r", [card(1)]);
    const mark = vi.spyOn(store, "markFlightPointers");
    store.replaceBoard("r", [card(1, { status: "Done", closed: true })]);
    expect(mark).toHaveBeenCalledWith("ticket", "r#1", "closed", expect.any(Number));
  });
});

describe("rows load without a query per row", () => {
  it("reads mentions and reactions for a whole list in a fixed number of queries", () => {
    for (let i = 0; i < 30; i++) {
      const row = store.addComms({
        at: 100 + i,
        from: "CAPCOM",
        to: "flight",
        ticket: "r#1",
        text: `m${i}`,
        mentions: ["CAPCOM"],
      });
      if (row === null) throw new Error("not stored");
      store.addCommsReaction(row.id, "flight", "seen", undefined, 200 + i);
    }
    const probe = new DatabaseSync(":memory:").prepare("SELECT 1");
    const statement = Object.getPrototypeOf(probe) as { all: (...a: unknown[]) => unknown };
    const all = vi.spyOn(statement, "all");
    const get = vi.spyOn(statement as unknown as { get: () => unknown }, "get");
    const rows = store.commsMentions("CAPCOM");
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.mentions.length === 1)).toBe(true);
    const reactions = store.commsReactionsFor(rows.map((r) => r.id));
    expect(reactions.size).toBe(30);
    expect(all.mock.calls.length + get.mock.calls.length).toBeLessThanOrEqual(4);
    all.mockRestore();
    get.mockRestore();
  });

  it("counts a crew's refusals per run in one query, through the run index", () => {
    store.addGuardHit({ agentId: "a", runId: "r1", rule: "read-only", text: "t", at: 1 });
    store.addGuardHit({ agentId: "a", runId: "r1", rule: "read-only", text: "t", at: 2 });
    store.addGuardHit({ agentId: "b", runId: "r2", rule: "read-only", text: "t", at: 3 });
    expect(store.guardHitCountsByRun(["r1", "r2", "r3"])).toEqual(
      new Map([
        ["r1", 2],
        ["r2", 1],
      ]),
    );
    const raw = new DatabaseSync(dbPath);
    const plan = raw
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM guard_hits WHERE run_id = ?")
      .all("r1")
      .map((r) => String(r.detail))
      .join(" ");
    raw.close();
    expect(plan).toContain("guard_hits_run");
  });
});

describe("a restart does not repeat what already ran", () => {
  it("does not rebuild the audit history of merged PRs on a second open", () => {
    store.upsertPullRequests("r", [pr(5, { state: "merged", mergedAt: 50 })], 1);
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM pr_history");
    raw.close();
    store = new Store(dbPath);
    const left = new DatabaseSync(dbPath);
    expect(left.prepare("SELECT COUNT(*) AS n FROM pr_history").get()?.n).toBe(0);
    left.close();
  });

  it("reads runs for a branch ticket only past the last start's watermark", () => {
    store.close();
    const raw = new DatabaseSync(dbPath);
    const insert = raw.prepare(
      "INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, branch, transcript_path) VALUES (?, 'a', 'shop-app', ?, 1, 'done', ?, '/x')",
    );
    insert.run("old", 1, "docs/123-x");
    raw.close();
    store = new Store(dbPath); // reads "old" (rowid 1), sets the watermark
    store.close();
    const again = new DatabaseSync(dbPath);
    again.exec("UPDATE runs SET ticket = NULL");
    again.close();
    store = new Store(dbPath);
    expect(store.run("old")?.ticket).toBeNull();
  });

  it("starts the jobs nobody waits on later, one after another", () => {
    const delays = Object.values(STAGGERED_FIRST_DELAY_MS) as number[];
    expect(delays.length).toBeGreaterThan(1);
    expect(delays.every((d) => d > 0)).toBe(true);
    expect(new Set(delays).size).toBe(delays.length);
  });
});

describe("the GitHub token", () => {
  let bin: string;
  let count: string;
  const oldPath = process.env.PATH;
  beforeEach(() => {
    bin = join(dir, "bin");
    count = join(dir, "gh-calls");
    mkdirSync(bin);
    writeFileSync(count, "");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh\necho x >> "${count}"\necho tok-$(wc -l < "${count}" | tr -d ' ')\n`,
    );
    chmodSync(gh, 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    forgetGithubToken();
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    forgetGithubToken();
    vi.useRealTimers();
  });
  const spawns = () => readFileSync(count, "utf8").split("\n").filter(Boolean).length;

  it("spawns gh once for many requests, and again after the token's time is up", async () => {
    const first = await githubToken();
    expect(await githubToken()).toBe(first);
    expect(await Promise.all([githubToken(), githubToken()])).toEqual([first, first]);
    expect(spawns()).toBe(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + GITHUB_TOKEN_TTL_MS + 1);
    expect(await githubToken()).not.toBe(first);
    expect(spawns()).toBe(2);
  });

  it("does not keep a failed read", async () => {
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    await expect(githubToken()).rejects.toThrow("could not read a GitHub token");
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho good\n");
    expect(await githubToken()).toBe("good");
  });
});
