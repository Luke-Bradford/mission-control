import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PullRequestView, Run } from "@mc/core";
import { COMMS_CAPCOM, NEW_LOOP } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attentionChatter } from "../src/comms/index.ts";
import { overviewSummary } from "../src/hud/overview.ts";
import { Store } from "../src/store.ts";

/** #2219: the reads each page makes on opening, after the hub's next write, stay small. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-24T12:00:30Z");

let dir: string;
let store: Store;
const db = () => (store as unknown as { db: DatabaseSync }).db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-page-reads-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const pr = (number: number, patch: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "repo",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}`,
  ticket: null,
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
  headSha: `head-${number}`,
  mergeable: null,
  checks: [],
  ...patch,
});
const run = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: "repo#1",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...patch,
});

describe("the kept pull requests", () => {
  it("survive a write to another table, and a pull request write by another connection drops them", () => {
    store.upsertPullRequests("repo", [pr(1), pr(2)], 1);
    const kept = store.pullRequests("repo")[0];
    // the hub writes runs, digests and status every second or so: none of them is a PR row
    store.upsertRun(run("r1"));
    store.setStatus("pulls", true, null);
    expect(store.pullRequests("repo")[0]).toBe(kept);

    const other = new Store(join(dir, "mc.sqlite"));
    other.upsertPullRequests("repo", [pr(2, { title: "Renamed" })], 2);
    other.close();
    expect(store.pullRequests("repo").map((p) => p.title)).toEqual(["Renamed", "PR 1"]);
    db().exec("DELETE FROM pull_requests WHERE number = 2");
    expect(store.pullRequests("repo").map((p) => p.number)).toEqual([1]);
  });

  it("answer a ticket's closing PRs from the kept list, not a scan of every row", () => {
    store.upsertPullRequests(
      "repo",
      [pr(1, { ticket: "repo#5" }), pr(2, { closingIssues: [5] }), pr(3, { ticket: "repo#6" })],
      1,
    );
    const kept = store.pullRequests("repo");
    const closing = store.pullRequestsClosingTicket("repo", 5);
    expect(closing.map((p) => p.number)).toEqual([2, 1]);
    expect(closing[0]).toBe(kept[1]);
    expect(store.pullRequestsClosingTicket("other", 5)).toEqual([]);
  });
});

describe("Needs you's read of each seat's Comms", () => {
  const send = (from: string, to: string, text: string, at: number) =>
    store.addComms({ from, to, text, at, ticket: null });

  it("reads only the lines the seat wrote that tag or answer CAPCOM, and raises the same items", () => {
    send(COMMS_CAPCOM, "guido-1", "Go ahead", NOW - 50 * MIN);
    for (let i = 0; i < 40; i++) send("flight-1", "guido-1", `note ${i} @CAPCOM?`, NOW - 40 * MIN);
    send("guido-1", "flight-1", "routine handoff", NOW - 30 * MIN);
    send("guido-1", COMMS_CAPCOM, "Which option do you want?", NOW - 20 * MIN);
    send("guido-1", "flight-1", "@capcom should I merge?", NOW - 10 * MIN);
    const thread = vi.spyOn(store, "threadComms");
    const lines = attentionChatter(store, "guido-1", true, false);
    expect(thread).not.toHaveBeenCalled();
    expect(lines.message.map((m) => m.text)).toEqual(["Which option do you want?"]);
    expect(lines.tag.map((m) => m.text)).toEqual(["@capcom should I merge?"]);
    expect(store.attentionComms("guido-1").map((m) => m.text)).toEqual([
      "Which option do you want?",
      "@capcom should I merge?",
    ]);
  });

  it("keeps to the thread's newest 500 lines, as the whole read did", () => {
    send("guido-1", COMMS_CAPCOM, "old question?", NOW - DAY);
    for (let i = 0; i < 500; i++) send("flight-1", "guido-1", `line ${i}`, NOW - HOUR);
    expect(store.attentionComms("guido-1")).toEqual([]);
    send("guido-1", COMMS_CAPCOM, "new question?", NOW);
    expect(store.attentionComms("guido-1").map((m) => m.text)).toEqual(["new question?"]);
  });

  it("finds the operator's last prompt to a seat through an index", () => {
    const plan = db()
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, at FROM comms WHERE from_id = ? AND to_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .all(COMMS_CAPCOM, "guido-1") as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toMatch(/comms_from_to_at/);
    expect(plan.map((p) => p.detail).join("\n")).not.toMatch(/TEMP B-TREE/);
  });
});

describe("the away digest's run read", () => {
  it("reads a few fields of the runs, not whole rows", () => {
    store.upsertRun(
      run("ready", {
        endedAt: NOW,
        loop: { ...NEW_LOOP, prNumber: 4, merging: { sha: "head-4", done: ["ready"] } },
      }),
    );
    expect(store.awayDigestRuns().ready).toEqual([{ repoId: "repo", prNumber: 4, sha: "head-4" }]);
  });
});

describe("the Overview's CI rate", () => {
  const check = (conclusion: string, state: "passing" | "failing", name = "check") => ({
    name,
    kind: "check" as const,
    state,
    conclusion,
    attempt: 1,
    url: null,
  });

  it("reads only the heads first seen in its window, though a sweep re-read every old one", () => {
    // an old head, first read two days ago and re-read by this morning's sweep
    store.upsertPullRequests(
      "repo",
      [pr(1, { headSha: "old", checks: [check("FAILURE", "failing")] })],
      NOW - 2 * DAY,
    );
    store.upsertPullRequests(
      "repo",
      [pr(1, { headSha: "old", checks: [check("FAILURE", "failing")] })],
      NOW - HOUR,
    );
    // a head first seen today
    store.upsertPullRequests(
      "repo",
      [pr(2, { headSha: "new", checks: [check("SUCCESS", "passing")] })],
      NOW - HOUR,
    );
    // an old head with a re-run first seen today: the head is still the old one
    store.upsertPullRequests(
      "repo",
      [pr(3, { headSha: "rerun", checks: [check("SUCCESS", "passing", "a")] })],
      NOW - 2 * DAY,
    );
    store.upsertPullRequests(
      "repo",
      [
        pr(3, {
          headSha: "rerun",
          checks: [check("SUCCESS", "passing", "a"), check("SUCCESS", "passing", "b")],
        }),
      ],
      NOW - HOUR,
    );
    const since = NOW - DAY - HOUR;
    expect(store.ciRunsOfNewHeads(since).map((r) => r.sha)).toEqual(["new"]);
    const all = vi.spyOn(store, "ciRuns");
    const ci = overviewSummary(store, NOW, {
      repoIds: ["repo"],
      timezone: "UTC",
      attention: [],
    }).kpis.ciPassRate24h;
    expect(all).not.toHaveBeenCalled();
    expect(ci).toMatchObject({ runs: 1, pct: 100 });
  });
});

describe("the Audit's past-changes metrics", () => {
  type Reader = {
    (from: number, to: number): unknown;
    many(windows: readonly (readonly [number, number])[]): unknown[];
  };
  const reader = (low: number, high: number) =>
    (
      store as unknown as { auditMetricsReader(low: number, high: number): Reader }
    ).auditMetricsReader(low, high);

  it("works out every window in one pass, with the same figures as one window at a time", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const start = NOW - 40 * DAY;
    const addPr = db().prepare(
      "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('repo', ?, ?, ?)",
    );
    for (let i = 0; i < 400; i++)
      addPr.run(
        i,
        start + next(40 * DAY),
        JSON.stringify({ number: i, ticket: next(5) === 0 ? null : `repo#${next(60)}` }),
      );
    const addRun = db().prepare(
      `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, ticket, transcript_path, cost_usd)
       VALUES (?, 'seat', 'repo', ?, ?, 'done', ?, '/x', ?)`,
    );
    for (let i = 0; i < 60; i++)
      if (next(4) !== 0) addRun.run(`r${i}`, i, start, `repo#${i}`, 1 + next(9) + next(100) / 7);
    const addReview = db().prepare(
      `INSERT INTO reviews (id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state,
         author_run_id, blocking, created_at, ended_at)
       VALUES (?1, 'repo', 'retro-1', 1, 'sha', 1, ?1, ?2, 'reported', ?3, ?4, ?5, ?5)`,
    );
    for (let i = 0; i < 300; i++) {
      const at = start + next(40 * DAY);
      addReview.run(i, 1 + next(4), `a${next(30)}`, next(3), at);
    }
    const read = reader(start, NOW);
    const windows: [number, number][] = [];
    for (let i = 0; i < 500; i++) {
      const at = start + next(40 * DAY);
      const w = Math.min(7 * DAY, at - start, NOW - at);
      windows.push([at - w, at - 1], [at, at + w - 1]);
    }
    // windows whose ends move back too, and empty ones
    windows.push([start, NOW], [start + DAY, start + DAY - 1], [start + 2 * DAY, start + 3 * DAY]);
    expect(read.many(windows)).toEqual(windows.map(([from, to]) => read(from, to)));
  });
});
