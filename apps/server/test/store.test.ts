import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditRunKind,
  AuditView,
  BoardItem,
  Escalation,
  FlightDecision,
  GuardHit,
  GuardRule,
  LoopKind,
  MachineSample,
  Profile,
  ReviewFinding,
  ReviewRequest,
  Run,
  RunDigest,
  SeatSessionRow,
  UsageSample,
} from "@mc/core";
import {
  COMMS_CAPCOM,
  COMMS_TEXT_MAX,
  commsCutMarker,
  DEFAULT_PROFILES,
  FLIGHT_SIGNALS_SETTING,
  NEW_LOOP,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK_ABSENT_MS,
  type AgentEvent,
  crewPromptPath,
  crewTranscriptPath,
  MACHINE_RETENTION_MS,
  MAX_OPEN_RUN_AGE_MS,
  Store,
} from "../src/store.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-store-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  agentId: "a1",
  repoId: "repo",
  seq: 1,
  startedAt: 1000,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x/y.log",
  prs: [],
  summary: null,
  reviewId: null,
  ...over,
});

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 3,
  turns: 2,
  lastEventAt: 5000,
  model: "claude-opus-5-5",
  contextTokens: 1234,
  contextWindow: 1_000_000,
  liveTool: { name: "Bash", since: 4000, detail: "pnpm test" },
  lastText: "Running the tests.",
  tools: { Bash: { calls: 3, failed: 1, durationsMs: [10, 20] } },
  subagents: [
    {
      taskId: "t1",
      type: "Explore",
      description: "look",
      status: "completed",
      tokens: 10,
      toolUses: 2,
      durationMs: 300,
    },
  ],
  minuteTokens: [[60_000, 42]],
  turnUsage: [{ input: 1, output: 2, cacheRead: 3 }],
  background: [{ taskId: "b1", description: "suite", type: "local_bash" }],
  compactions: 2,
  ...over,
});

describe("Store", () => {
  it("batches recent runs by agent without dropping empty agents", () => {
    store.upsertRun(run({ id: "a-old", agentId: "a", seq: 1, startedAt: 1 }));
    store.upsertRun(run({ id: "a-new", agentId: "a", seq: 2, startedAt: 2 }));
    store.upsertRun(run({ id: "b", agentId: "b", seq: 1, startedAt: 3 }));
    const rows = store.runsForAgents(["a", "b", "empty"], 1);
    expect(rows.get("a")).toEqual(store.runs("a", 1));
    expect(rows.get("b")).toEqual(store.runs("b", 1));
    expect(rows.get("empty")).toEqual([]);
  });

  it("partitions batched pull requests and reuses a prepared statement", () => {
    const pr = (repoId: string, number: number) => ({
      repoId,
      number,
      title: `PR ${number}`,
      url: "u",
      branch: "branch",
      ticket: null,
      state: "open" as const,
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
    });
    store.upsertPullRequests("one", [pr("one", 1)], 1);
    store.upsertPullRequests("two", [pr("two", 2)], 1);
    const batches = store.pullRequestsForRepos(["one", "two"]);
    expect(batches.get("one")).toEqual(store.pullRequests("one"));
    expect(batches.get("two")).toEqual(store.pullRequests("two"));

    const raw = (store as unknown as { rawDb: DatabaseSync }).rawDb;
    const prepare = vi.spyOn(raw, "prepare");
    store.runs("prepared", 1);
    store.runs("prepared", 1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps map cache rows by kind, scope and key, and an exclusive put drops the others", () => {
    const s = new Store(":memory:");
    s.mapCachePut("tree", "checkout", "a", "1", true);
    s.mapCachePut("tree", "other", "z", "9", true);
    s.mapCachePut("merge", "", "m", "[]", false);
    expect(s.mapCacheGet("tree", "checkout", "a")).toBe("1");
    s.mapCachePut("tree", "checkout", "b", "2", true);
    expect(s.mapCacheGet("tree", "checkout", "a")).toBeNull();
    expect(s.mapCacheGet("tree", "checkout", "b")).toBe("2");
    expect(s.mapCacheGet("tree", "other", "z")).toBe("9");
    expect(s.mapCacheGet("merge", "", "m")).toBe("[]");
    s.mapCachePut("tree", "checkout", "b", "3", true);
    expect(s.mapCacheGet("tree", "checkout", "b")).toBe("3");
  });

  it("close releases the database: the store cannot be used after", () => {
    const s = new Store(":memory:");
    s.upsertRun(run());
    s.close();
    expect(() => s.runs("a1", 10)).toThrow();
  });

  it("close twice is harmless", () => {
    const s = new Store(":memory:");
    s.close();
    expect(() => s.close()).not.toThrow();
  });

  it("reads all runs on a repo's ticket, including ended runs but not reviews", () => {
    store.upsertRun(run({ id: "live", ticket: "repo#7" }));
    store.upsertRun(run({ id: "ended", ticket: "repo#7", endedAt: 2000 }));
    store.upsertRun(run({ id: "review", ticket: "repo#7", reviewId: 1 }));
    store.upsertRun(run({ id: "other-ticket", ticket: "repo#8" }));
    store.upsertRun(run({ id: "other-repo", repoId: "other", ticket: "repo#7" }));
    expect(
      store
        .runsOnTicket("repo", "repo#7")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["ended", "live"]);
  });

  it("upsertRun keeps one row with the latest fields", () => {
    store.upsertRun(run());
    store.upsertRun(
      run({
        status: "ok",
        endedAt: 2000,
        costUsd: 1.5,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        accountId: "account-a",
        effort: "high",
        promptHash: "prompt-hash",
      }),
    );
    const rows = store.runs("a1", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      run({
        status: "ok",
        endedAt: 2000,
        costUsd: 1.5,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        accountId: "account-a",
        effort: "high",
        promptHash: "prompt-hash",
      }),
    );
  });

  it("round-trips a run's PRs and summary", () => {
    const r = run({
      prs: [
        { repo: "o/r", number: 7 },
        { repo: "o/r", number: 9 },
      ],
      summary: "Merged PR #7.",
    });
    store.upsertRun(r);
    expect(store.runs("a1", 1)[0]).toEqual(r);
  });

  it("upsertRun sets folded only for a folded ended run, and never clears it", () => {
    const folded = (id: string) =>
      (
        new DatabaseSync(join(dir, "mc.sqlite"))
          .prepare("SELECT folded FROM runs WHERE id = ?")
          .get(id) as { folded: number }
      ).folded;
    store.upsertRun(run({ id: "a" }), true); // running: not yet
    expect(folded("a")).toBe(0);
    store.upsertRun(run({ id: "a", endedAt: 2000, status: "ok" })); // ended, not folded
    expect(folded("a")).toBe(0);
    store.upsertRun(run({ id: "a", endedAt: 2000, status: "ok" }), true);
    expect(folded("a")).toBe(1);
    store.upsertRun(run({ id: "a", endedAt: 2000, status: "blocked" }));
    expect(folded("a")).toBe(1);
  });

  it("runsToFold lists unfolded ended runs started before the cut-off, newest first; countToFold counts them", () => {
    const ended = { endedAt: 5000, status: "ok" } as const;
    store.upsertRun(run({ id: "old", seq: 1, startedAt: 1000, ...ended }));
    store.upsertRun(run({ id: "mid", seq: 2, startedAt: 2000, ...ended }));
    store.upsertRun(run({ id: "other", agentId: "a2", seq: 1, startedAt: 2500, ...ended }));
    store.upsertRun(run({ id: "done", seq: 3, startedAt: 3000, ...ended }), true); // folded
    store.upsertRun(run({ id: "live", seq: 4, startedAt: 3500 })); // still running
    store.upsertRun(run({ id: "new", seq: 5, startedAt: 4000, ...ended })); // not before the cut-off
    expect(store.runsToFold(10, 4000).map((r) => r.id)).toEqual(["other", "mid", "old"]);
    expect(store.runsToFold(2, 4000).map((r) => r.id)).toEqual(["other", "mid"]);
    expect(store.runsToFold(10, 4000)[0]).toEqual(
      run({ id: "other", agentId: "a2", seq: 1, startedAt: 2500, ...ended }),
    );
    expect(store.countToFold(4000)).toBe(3);
    expect(store.countToFold(4001)).toBe(4);
    store.upsertRun(run({ id: "mid", seq: 2, startedAt: 2000, ...ended }), true);
    expect(store.runsToFold(10, 4000).map((r) => r.id)).toEqual(["other", "old"]);
    expect(store.countToFold(4000)).toBe(2);
  });

  it("re-derives a missing ticket from the branch on open (docs/ rows stored before docs/ was known)", () => {
    store.upsertRun(run({ id: "d", repoId: "shop-app", branch: "docs/123-x", ticket: null }));
    store.upsertRun(run({ id: "m", branch: "main", ticket: null }));
    store.upsertRun(run({ id: "k", repoId: "shop-app", branch: "docs/5-y", ticket: "shop-app#9" }));
    const reopened = new Store(join(dir, "mc.sqlite"));
    const byId = new Map(reopened.runs("a1", 10).map((r) => [r.id, r.ticket]));
    expect(byId).toEqual(
      new Map([
        ["d", "shop-app#123"],
        ["m", null],
        ["k", "shop-app#9"],
      ]),
    );
  });

  it("migrates an old runs table, defaulting prs, summary and folded", () => {
    const old = join(dir, "old-runs.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repo_id TEXT NOT NULL, seq INTEGER NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, session_id TEXT,
      model TEXT, branch TEXT, ticket TEXT, cost_usd REAL, tokens TEXT, transcript_path TEXT NOT NULL)`);
    db.exec(`INSERT INTO runs VALUES ('r1', 'a1', 'repo', 1, 1000, NULL, 'running', NULL, NULL,
      'docs/77-x', NULL, NULL, NULL, '/x/y.log')`);
    db.close();
    const migrated = new Store(old);
    expect(migrated.runs("a1", 1)[0]).toEqual(
      run({ branch: "docs/77-x", ticket: "repo#77", prs: [], summary: null }),
    );
    const row = new DatabaseSync(old).prepare("SELECT folded FROM runs").get() as {
      folded: number;
    };
    expect(row.folded).toBe(0);
    new Store(old); // re-opening is a no-op
  });

  it("runs returns newest first and respects the limit", () => {
    store.upsertRun(run({ id: "a", seq: 1, startedAt: 1 }));
    store.upsertRun(run({ id: "b", seq: 2, startedAt: 2 }));
    store.upsertRun(run({ id: "c", agentId: "other", startedAt: 3 }));
    expect(store.runs("a1", 1).map((r) => r.id)).toEqual(["b"]);
    expect(store.runs("a1", 10).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("runsOverlapping returns every agent's runs overlapping [since, until), newest first", () => {
    store.upsertRun(run({ id: "ended-at-since", startedAt: 10, endedAt: 100 }));
    store.upsertRun(run({ id: "spans-since", startedAt: 50, endedAt: 150 }));
    store.upsertRun(run({ id: "still-running", agentId: "a2", startedAt: 20, endedAt: null }));
    store.upsertRun(run({ id: "inside", startedAt: 120, endedAt: 130 }));
    store.upsertRun(run({ id: "starts-at-until", startedAt: 200, endedAt: null }));
    expect(store.runsOverlapping(100, 200).map((r) => r.id)).toEqual([
      "inside",
      "spans-since",
      "still-running",
    ]);
  });

  it("runsOverlapping bounds open runs: unknown ones by start, running ones by MAX_OPEN_RUN_AGE_MS", () => {
    const until = 10 * MAX_OPEN_RUN_AGE_MS;
    const since = until - 1000;
    store.upsertRun(
      run({ id: "unknown-old", status: "unknown", startedAt: since - 5, endedAt: null }),
    );
    store.upsertRun(run({ id: "unknown-in", status: "unknown", startedAt: since, endedAt: null }));
    store.upsertRun(
      run({
        id: "running-old",
        status: "running",
        startedAt: until - MAX_OPEN_RUN_AGE_MS,
        endedAt: null,
      }),
    );
    store.upsertRun(
      run({
        id: "running-aged",
        status: "running",
        startedAt: until - MAX_OPEN_RUN_AGE_MS + 1,
        endedAt: null,
      }),
    );
    expect(store.runsOverlapping(since, until).map((r) => r.id)).toEqual([
      "unknown-in",
      "running-aged",
    ]);
  });

  it("usage returns samples ordered by at, filtered by account, window and since", () => {
    const s = (at: number, over: Partial<UsageSample> = {}): UsageSample => ({
      accountId: "acc",
      window: "5h",
      at,
      pct: at / 10,
      resetAt: 9999,
      source: "t",
      ...over,
    });
    store.addUsage(s(300));
    store.addUsage(s(100));
    store.addUsage(s(200));
    store.addUsage(s(150, { window: "7d" }));
    store.addUsage(s(160, { accountId: "other" }));
    expect(store.usage("acc", "5h", 0).map((x) => x.at)).toEqual([100, 200, 300]);
    expect(store.usage("acc", "5h", 200).map((x) => x.at)).toEqual([200, 300]);
    expect(store.usage("acc", "7d", 0)).toHaveLength(1);
  });

  it("latestUsage returns the newest sample for an account and window, or null", () => {
    const s = (at: number, over: Partial<UsageSample> = {}): UsageSample => ({
      accountId: "acc",
      window: "5h",
      at,
      pct: at / 10,
      resetAt: 9999,
      source: "t",
      ...over,
    });
    expect(store.latestUsage("acc", "5h")).toBeNull();
    store.addUsage(s(300));
    store.addUsage(s(100));
    store.addUsage(s(400, { window: "7d" }));
    store.addUsage(s(500, { accountId: "other" }));
    expect(store.latestUsage("acc", "5h")).toEqual(s(300));
    expect(store.latestUsage("acc", "7d")?.at).toBe(400);
  });

  it("addUsage ignores a repeat of the same (account, window, at, source) reading", () => {
    const s: UsageSample = {
      accountId: "acc",
      window: "7d",
      at: 100,
      pct: 5,
      resetAt: 9999,
      source: "transcript",
    };
    store.addUsage(s);
    store.addUsage({ ...s, pct: 6 }); // same key: ignored
    store.addUsage({ ...s, source: "oauth-usage" }); // a different source is a different reading
    expect(store.usage("acc", "7d", 0).map((x) => [x.source, x.pct])).toEqual([
      ["transcript", 5],
      ["oauth-usage", 5],
    ]);
  });

  it("opening a pre-index database drops duplicate usage rows and then enforces uniqueness", () => {
    const path = join(dir, "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE usage_samples (account_id TEXT NOT NULL, window TEXT NOT NULL,
      at INTEGER NOT NULL, pct REAL NOT NULL, reset_at INTEGER NOT NULL, source TEXT NOT NULL)`);
    const ins = old.prepare("INSERT INTO usage_samples VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 3; i++) ins.run("acc", "5h", 100, 5, 9999, "transcript");
    ins.run("acc", "5h", 200, 6, 9999, "transcript");
    old.close();
    const s = new Store(path);
    expect(s.usage("acc", "5h", 0).map((x) => x.at)).toEqual([100, 200]);
    s.addUsage({
      accountId: "acc",
      window: "5h",
      at: 200,
      pct: 9,
      resetAt: 9999,
      source: "transcript",
    });
    expect(s.usage("acc", "5h", 0)).toHaveLength(2);
  });

  it("invalidates legacy cycle starts once, preserving PR flow and recollected rows", () => {
    const path = join(dir, "flow.sqlite");
    const old = new Store(path);
    old.deleteSetting("flow-ready-start-v1");
    const issue = { repoId: "r", number: 1, size: null, startAt: 10, doneAt: 20 };
    const pr = { repoId: "r", number: 2, mergedAt: 20, firstPushCi: null };
    old.replaceFlow("r", [issue], [pr]);
    old.close();
    const migrated = new Store(path);
    expect(migrated.flowIssues(0)).toEqual([]);
    expect(migrated.flowPrs(0)).toEqual([pr]);
    migrated.replaceFlow("r", [issue], [pr]);
    migrated.close();
    const reopened = new Store(path);
    expect(reopened.flowIssues(0)).toEqual([issue]);
    reopened.close();
  });

  it("runs the usage dedupe on the first open only, gated on PRAGMA user_version", () => {
    const path = join(dir, "once.sqlite");
    const userVersion = (db: DatabaseSync) =>
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    new Store(path).close();
    const raw = new DatabaseSync(path);
    expect(userVersion(raw)).toBeGreaterThan(0);
    // Put the pre-index shape back: duplicates and no unique index.
    raw.exec("DROP INDEX usage_unique");
    const ins = raw.prepare("INSERT INTO usage_samples VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 3; i++) ins.run("acc", "5h", 100, 5, 9999, "transcript");
    raw.close();

    const second = new Store(path);
    expect(second.usage("acc", "5h", 0)).toHaveLength(3); // the dedupe did not run again
    second.close();

    const reset = new DatabaseSync(path);
    reset.exec("PRAGMA user_version = 0");
    reset.close();
    const third = new Store(path);
    expect(third.usage("acc", "5h", 0)).toHaveLength(1); // a version-0 database is deduped
    third.close();
  });

  it("opens an up-to-date database without waiting for another connection's write lock", () => {
    const path = join(dir, "locked.sqlite");
    new Store(path).close();
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      new Store(path).close();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("round-trips quotes and semicolons unchanged", () => {
    const nasty = `O'Brien"; DROP TABLE runs; --`;
    store.upsertRun(run({ branch: nasty, ticket: nasty }));
    const r = store.runs("a1", 1)[0];
    expect(r?.branch).toBe(nasty);
    expect(r?.ticket).toBe(nasty);
    const esc: Escalation = {
      id: "e1",
      repoId: "repo",
      issueNumber: 7,
      title: nasty,
      kind: "autonomy-question",
      source: "label",
      openedAt: 5,
      url: "u",
      question: {
        question: nasty,
        recommendation: "r",
        reasoning_quote: "q",
        effort_sunk: "e",
        default_if_ignored: "d",
        answers: [nasty, "b"],
      },
    };
    store.replaceEscalations("repo", [esc]);
    expect(store.escalations()).toEqual([esc]);
    expect(store.runs("a1", 1)).toHaveLength(1);
  });

  it("replaceEscalations only replaces that repo", () => {
    const e = (id: string, repoId: string): Escalation => ({
      id,
      repoId,
      issueNumber: 1,
      title: id,
      kind: "operator-decision",
      source: "title",
      openedAt: 1,
      url: "u",
      question: null,
    });
    store.replaceEscalations("r1", [e("a", "r1"), e("b", "r1")]);
    store.replaceEscalations("r2", [e("c", "r2")]);
    store.replaceEscalations("r1", [e("d", "r1")]);
    expect(
      store
        .escalations()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["c", "d"]);
  });

  it("round-trips an escalation's source", () => {
    const e = (id: string, source: Escalation["source"]): Escalation => ({
      id,
      repoId: "r",
      issueNumber: 1,
      title: id,
      kind: "operator-decision",
      source,
      openedAt: 1,
      url: "u",
      question: null,
    });
    store.replaceEscalations("r", [e("a", "title"), e("b", "label")]);
    expect(store.escalations().map((x) => [x.id, x.source])).toEqual([
      ["a", "title"],
      ["b", "label"],
    ]);
  });

  it("adds escalations.source to an older database, inferring it from the title marker", () => {
    const old = join(dir, "old.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE escalations (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, opened_at INTEGER NOT NULL, url TEXT NOT NULL, question TEXT)`);
    const ins = db.prepare("INSERT INTO escalations VALUES (?, 'r', ?, ?, ?, 1, 'u', NULL)");
    ins.run("r#1", 1, "  [loop-blocked] CI red", "loop-blocked");
    ins.run("r#2", 2, "needs a design", "operator-decision");
    ins.run("r#3", 3, "[mvp-ready] ship", "mvp-ready");
    db.close();
    const migrated = new Store(old);
    expect(migrated.escalations().map((x) => [x.id, x.source])).toEqual([
      ["r#1", "title"],
      ["r#2", "label"],
      ["r#3", "title"],
    ]);
    new Store(old); // re-opening an already-migrated database is a no-op
  });

  it("replaceBoard round-trips labels and scopes to the repo", () => {
    const item = (n: number, repoId: string): BoardItem => ({
      repoId,
      issueNumber: n,
      title: `t'${n}`,
      status: "Todo",
      state: "planned",
      labels: ["a", "b;c"],
      priority: null,
      updatedAt: n,
      url: "u",
      stage: "Needs detail",
      owner: "CTO",
      parent: n + 100,
      subIssues: { done: 1, total: n + 1 },
      assignees: ["luke"],
      blockedBy: [
        { ref: "other#12", closed: false },
        { ref: `${repoId}#3`, closed: true },
      ],
      milestone: `m'${n}`,
      size: `S${n}`,
      closed: n % 2 === 0,
      prioritySource: n % 2 === 0 ? "label" : "field",
      createdAt: n,
      itemId: `item${n}`,
      projectId: `project-${repoId}`,
    });
    store.replaceBoard("r1", [item(1, "r1"), item(2, "r1")]);
    store.replaceBoard("r2", [item(3, "r2")]);
    store.replaceBoard("r1", [item(4, "r1")]);
    expect(store.board("r1")).toEqual([item(4, "r1")]);
    expect(store.board("r2")).toEqual([item(3, "r2")]);
  });

  it("migrates an old board_items table, defaulting the new columns", () => {
    const old = join(dir, "old-board.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE board_items (
      repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
      url TEXT NOT NULL, PRIMARY KEY (repo_id, issue_number))`);
    db.exec(`INSERT INTO board_items VALUES ('r', 1, 't', 'Todo', 'planned', '[]', NULL, 5, 'u')`);
    db.close();
    const migrated = new Store(old);
    expect(migrated.board("r")).toEqual([
      {
        repoId: "r",
        issueNumber: 1,
        title: "t",
        status: "Todo",
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: 5,
        url: "u",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        assignees: [],
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: 0,
        itemId: null,
        projectId: null,
      },
    ]);
    new Store(old); // re-opening is a no-op
  });

  it("migrates a board_items table without size and replaceBoard then succeeds", () => {
    const old = join(dir, "no-size.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE board_items (
      repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
      url TEXT NOT NULL, stage TEXT, owner TEXT, parent INTEGER, sub_done INTEGER, sub_total INTEGER,
      blocked_by TEXT NOT NULL DEFAULT '[]', milestone TEXT, PRIMARY KEY (repo_id, issue_number))`);
    db.close();
    const migrated = new Store(old);
    migrated.replaceBoard("r", [
      {
        repoId: "r",
        issueNumber: 1,
        title: "t",
        status: "Todo",
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: 5,
        url: "u",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        assignees: [],
        blockedBy: [],
        milestone: null,
        size: "L",
        closed: false,
        prioritySource: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      },
    ]);
    expect(migrated.board("r")[0]?.size).toBe("L");
  });

  it("pull request checks round-trip; a row without them reads []", () => {
    const base = {
      repoId: "r1",
      number: 1,
      title: "t",
      url: "u",
      branch: "fix/1-x",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: "failing" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: null,
      mergeable: null,
    };
    const checks = [
      {
        name: "check",
        kind: "check" as const,
        state: "failing" as const,
        conclusion: "FAILURE",
        attempt: 2,
        url: "https://example.test/job/2",
      },
    ];
    store.upsertPullRequests(
      "r1",
      [
        { ...base, checks },
        { ...base, number: 2 },
      ],
      0,
    );
    const by = new Map(store.pullRequests("r1").map((p) => [p.number, p.checks]));
    expect(by.get(1)).toEqual(checks);
    expect(by.get(2)).toEqual([]);
    const passed = [{ ...checks[0], state: "passing" as const, conclusion: "SUCCESS" }];
    store.upsertPullRequests("r1", [{ ...base, checks: passed }], 0);
    expect(store.pullRequests("r1").find((p) => p.number === 1)?.checks).toEqual(passed);
  });

  it("appends each polled check run to ci_runs and updates it in place when it concludes", () => {
    const pr = {
      repoId: "r1",
      number: 5,
      title: "t",
      url: "u",
      branch: "fix/1-x",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: "pending" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: "sha1",
      mergeable: null,
    };
    const check = (over: object = {}) => ({
      workflow: "CI",
      name: "test",
      kind: "check" as const,
      state: "pending" as const,
      conclusion: "IN_PROGRESS",
      attempt: 1,
      url: "https://example.test/1",
      ...over,
    });
    store.upsertPullRequests("r1", [{ ...pr, checks: [check()] }], 1000);
    store.upsertPullRequests(
      "r1",
      [{ ...pr, checks: [check({ state: "failing", conclusion: "FAILURE" })] }],
      2000,
    );
    store.upsertPullRequests(
      "r1",
      [
        {
          ...pr,
          checks: [
            check({ state: "passing", conclusion: "SUCCESS", attempt: 2 }),
            {
              name: "lint",
              kind: "status" as const,
              state: "passing" as const,
              conclusion: "success",
              attempt: null,
              url: null,
            },
          ],
        },
      ],
      3000,
    );
    expect(store.ciRuns(0)).toEqual([
      expect.objectContaining({
        name: "lint",
        attempt: 0,
        workflow: null,
        firstSeenAt: 3000,
        at: 3000,
      }),
      expect.objectContaining({
        name: "test",
        attempt: 2,
        conclusion: "SUCCESS",
        firstSeenAt: 3000,
      }),
      expect.objectContaining({
        name: "test",
        attempt: 1,
        state: "failing",
        conclusion: "FAILURE",
        prNumber: 5,
        sha: "sha1",
        firstSeenAt: 1000,
        at: 2000,
      }),
    ]);
    expect(store.ciRuns(2500).map((r) => r.name)).toEqual(["lint", "test"]);
  });

  it("keeps two same-name, same-attempt check runs of different workflows apart", () => {
    const check = (id: string | undefined, workflow: string, over: object = {}) => ({
      ...(id === undefined ? {} : { id }),
      workflow,
      name: "test",
      kind: "check" as const,
      state: "passing" as const,
      conclusion: "SUCCESS",
      attempt: 1,
      url: `https://example.test/${workflow}`,
      ...over,
    });
    const pr = {
      repoId: "r1",
      number: 5,
      title: "t",
      url: "u",
      branch: "b",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: "passing" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: "sha1",
      mergeable: null,
    };
    // same id-less shape, different workflow; and same workflow under two ids
    store.upsertPullRequests(
      "r1",
      [
        {
          ...pr,
          checks: [
            check("A", "CI"),
            check("B", "CI", { state: "failing", conclusion: "FAILURE" }),
            check(undefined, "Docs"),
          ],
        },
      ],
      1000,
    );
    store.upsertPullRequests(
      "r1",
      [
        {
          ...pr,
          checks: [
            check("A", "CI"),
            check("B", "CI", { state: "failing", conclusion: "FAILURE" }),
            check(undefined, "Docs"),
          ],
        },
      ],
      2000,
    );
    const rows = store.ciRuns(0);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.workflow, r.state]).sort()).toEqual([
      ["CI", "failing"],
      ["CI", "passing"],
      ["Docs", "passing"],
    ]);
  });

  it("keeps ci_runs ninety days", async () => {
    const pr = {
      repoId: "r1",
      number: 5,
      title: "t",
      url: "u",
      branch: "b",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: "passing" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: "sha1",
      mergeable: null,
      checks: [
        {
          name: "test",
          kind: "check" as const,
          state: "passing" as const,
          conclusion: "SUCCESS",
          attempt: 1,
          url: null,
        },
      ],
    };
    const day = 86_400_000;
    store.upsertPullRequests("r1", [pr], 10 * day);
    await store.pruneHistory(10 * day + 90 * day);
    expect(store.ciRuns(0)).toHaveLength(1);
    await store.pruneHistory(10 * day + 90 * day + 1);
    expect(store.ciRuns(0)).toEqual([]);
  });

  it("replaces a repo's milestones, scoped to the repo", () => {
    const goal = (over: object = {}) => ({
      repoId: "r1",
      number: 1,
      title: "MVP",
      state: "open" as const,
      dueOn: 5000,
      open: 3,
      closed: 7,
      ...over,
    });
    store.replaceMilestones("r1", [goal(), goal({ number: 2, title: "Later", dueOn: null })]);
    store.replaceMilestones("r2", [goal({ repoId: "r2", title: "Other" })]);
    expect(store.milestones().map((m) => [m.repoId, m.title, m.dueOn, m.open, m.closed])).toEqual([
      ["r1", "MVP", 5000, 3, 7],
      ["r1", "Later", null, 3, 7],
      ["r2", "Other", 5000, 3, 7],
    ]);
    store.replaceMilestones("r1", [goal({ state: "closed", open: 0, closed: 10 })]);
    expect(store.milestones("r1")).toEqual([goal({ state: "closed", open: 0, closed: 10 })]);
    expect(store.milestones("r2")).toHaveLength(1);
  });

  it("pull requests upsert, replace, scope to the repo and round-trip every field", () => {
    const pr = (repoId: string, number: number, over: object = {}) => ({
      repoId,
      number,
      title: `t'${number}`,
      url: "u",
      branch: "fix/1-x",
      ticket: `${repoId}#1`,
      state: "open" as const,
      isDraft: true,
      review: "approved" as const,
      ci: "failing" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: 3,
      headSha: "0123abc",
      mergeCommitSha: "merge-sha",
      mergeable: "MERGEABLE" as const,
      author: "octo",
      assignees: ["a", "b"],
      checks: [],
      closingIssues: [1, 3],
      additions: 12,
      deletions: 4,
      changedFiles: 3,
      ...over,
    });
    store.upsertPullRequests(
      "r1",
      [
        pr("r1", 1),
        pr("r1", 2, { ticket: null, review: null, ci: null, mergedAt: null, isDraft: false }),
      ],
      0,
    );
    store.upsertPullRequests("r2", [pr("r2", 1)], 0);
    store.upsertPullRequests("r1", [pr("r1", 2, { title: "changed" })], 0);
    expect(store.pullRequests("r1").map((p) => [p.number, p.title])).toEqual([
      [2, "changed"],
      [1, "t'1"],
    ]);
    expect(store.pullRequests("r1")[1]).toEqual(pr("r1", 1));
    store.replacePullRequests("r1", [pr("r1", 5)], 0);
    expect(store.pullRequests("r1").map((p) => p.number)).toEqual([5]);
    expect(store.pullRequests("r2")).toHaveLength(1);
  });

  it("keeps an immutable merged PR snapshot after the live cache is replaced", () => {
    const merged = {
      repoId: "r1",
      number: 7,
      title: "merged",
      url: "u",
      branch: "fix/7",
      ticket: "r1#7",
      state: "merged" as const,
      isDraft: false,
      review: "approved" as const,
      ci: "passing" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: 3,
      headSha: "head",
      mergeable: "MERGEABLE" as const,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    };
    store.upsertPullRequests("r1", [merged], 4);
    store.replacePullRequests("r1", [], 5);
    expect(store.prHistory("r1")).toEqual([merged]);
  });

  it("fills missing merged PR sizes after migrating a legacy database", () => {
    const old = join(dir, "old-merged-pr.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE pull_requests (
      repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
      review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      merged_at INTEGER, PRIMARY KEY (repo_id, number))`);
    db.exec(`INSERT INTO pull_requests VALUES
      ('r1', 7, 'merged', 'u', 'fix/7', 'r1#7', 'merged', 0, 'approved', 'passing', 1, 2, 3)`);
    db.close();

    const migrated = new Store(old);
    const observed = {
      ...migrated.pullRequests("r1")[0],
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    };
    migrated.upsertPullRequests("r1", [observed], 4);
    expect(migrated.prHistory("r1")[0]).toMatchObject({
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    });
    migrated.upsertPullRequests(
      "r1",
      [{ ...observed, additions: 99, deletions: 98, changedFiles: 97 }],
      5,
    );
    migrated.replacePullRequests("r1", [], 6);
    expect(migrated.prHistory("r1")[0]).toMatchObject({
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    });
    migrated.close();
  });

  it("keeps each daily retrospective", () => {
    store.recordRetrospective("r1", "2026-10-27", 1, { merged: 2 });
    store.recordRetrospective("r1", "2026-10-28", 2, { merged: 3 });
    expect(store.retrospectives("r1")).toEqual([{ merged: 3 }, { merged: 2 }]);
  });

  it("aggregates durable audit data inside its requested range", () => {
    store.upsertRun(
      run({ ticket: "repo#1", startedAt: 100, endedAt: 200, status: "ok", costUsd: 1 }),
    );
    store.addGuardHit({ agentId: "a1", runId: "r1", rule: "read-only", text: "refused", at: 150 });
    store.addQuestion({ agentId: "a1", runId: "r1", text: "why?", at: 120 });
    store.answerQuestions("a1", 180);
    const audit = store.audit(100, 200);
    expect(audit.longRunners).toEqual([expect.objectContaining({ runId: "r1", durationMs: 100 })]);
    expect(audit.refusalsByRule).toEqual([{ rule: "read-only", count: 1 }]);
    expect(audit.questions).toEqual({ asked: 1, answered: 1, answerMs: 60 });
    expect(store.audit(201, 300).questions).toEqual({ asked: 0, answered: 0, answerMs: null });
  });

  describe("token overuse", () => {
    const DAY = 86_400_000;
    const until = 30 * DAY;
    const boardItem = (n: number, size: string | null): BoardItem => ({
      repoId: "repo",
      issueNumber: n,
      title: `t${n}`,
      status: "Todo",
      state: "planned",
      labels: [],
      priority: null,
      updatedAt: 1,
      url: "u",
      stage: null,
      owner: null,
      parent: null,
      subIssues: { done: 0, total: 0 },
      assignees: [],
      blockedBy: [],
      milestone: null,
      size,
      closed: false,
      prioritySource: null,
      createdAt: 1,
      itemId: `i${n}`,
      projectId: "p",
    });
    const tokens = (total: number) => ({
      input: total - 1000,
      output: 1000,
      cacheRead: 5_000_000,
      cacheCreate: 200,
    });
    const ended = (n: number, startedAt: number, total: number, over: Partial<Run> = {}) =>
      store.upsertRun(
        run({
          id: `m${n}`,
          ticket: `repo#${n}`,
          startedAt,
          endedAt: startedAt + 10,
          status: "ok",
          tokens: tokens(total),
          ...over,
        }),
      );
    const review = (author: string, round: number, findings: ReviewFinding[]) => {
      const id = store.requestReview({
        authorRunId: author,
        repoId: "repo",
        seatId: "retro",
        prNumber: 1,
        sha: `${author}-${round}`,
        epoch: 0,
        attempt: 1,
        round,
        at: 1,
      }) as number;
      store.setReviewState(id, ["queued"], "running", { at: 2, runId: `rv-${id}` });
      store.recordFindings(id, `rv-${id}`, {
        verdict: { spec: "pass", quality: findings.length > 0 ? "fail" : "pass" },
        summary: "s",
        findings,
        at: until - DAY,
      });
    };
    const finding = (
      category: ReviewFinding["category"],
      severity: "Critical" | "Minor" = "Critical",
    ) =>
      ({
        severity,
        file: "f",
        line: 1,
        summary: "s",
        scenario: "s",
        fix: "f",
        category,
      }) as ReviewFinding;

    const builders = new Map<string, AuditRunKind>([
      ["a1", "build"],
      ["guido", "build"],
      ["planner", "plan"],
      ["flight", "watch"],
      ["ebull", "observed"],
    ]);
    const overuse = () => {
      const t = store.audit(until - 7 * DAY, until, builders).tokenOveruse;
      if (t === undefined) throw new Error("audit has no tokenOveruse");
      return t;
    };

    beforeEach(() => {
      // five recent size M runs around 100k tokens: about 150k expected for size M
      store.replaceBoard(
        "repo",
        [1, 2, 3, 4, 5, 6, 7].map((n) => boardItem(n, "M")),
      );
      for (const [i, t] of [90_000, 95_000, 100_000, 105_000, 110_000].entries()) {
        ended(i + 1, until - 3 * DAY + i, t);
      }
    });

    it("raises one finding for a run past its size's expected use, with why", () => {
      ended(6, until - 2 * DAY, 300_000, { agentId: "guido" });
      store.setDigest("m6", digest({ turns: 77 }));
      review("m6", 1, [
        finding("scope"),
        finding("spec"),
        finding("scope"),
        finding("style", "Minor"),
      ]);
      review("m6", 2, [finding("scope")]);
      review("m6", 3, []);

      const t = overuse();
      expect(t.runs).toHaveLength(1);
      expect(t.runs[0]).toMatchObject({
        runId: "m6",
        agentId: "guido",
        ticket: "repo#6",
        size: "M",
        ended: true,
        tokens: 300_000,
        input: 299_000,
        output: 1000,
        cacheRead: 5_000_000,
        cacheCreate: 200,
        expected: 153_750,
        reviewRounds: 3,
        blocking: 4,
        blockingByCategory: { scope: 3, spec: 1 },
        turns: 77,
        cause: "plan-gap",
        prevention: { kind: "plan-rule" },
      });
      expect(t.groups).toEqual([expect.objectContaining({ cause: "plan-gap", runIds: ["m6"] })]);
      expect(t.expected).toContainEqual({ size: "M", tokens: 153_750, measured: true });
    });

    it("leaves a run within its expected use alone, and does not stop an open one", () => {
      ended(6, until - 2 * DAY, 140_000);
      store.upsertRun(
        run({
          id: "open",
          ticket: "repo#7",
          startedAt: until - DAY,
          tokens: tokens(500_000),
        }),
      );
      const t = overuse();
      expect(t.runs.map((r) => [r.runId, r.ended])).toEqual([["open", false]]);
      expect(store.run("open")?.status).toBe("running");
    });

    it("uses 400000 for a size with fewer than five recent runs, and counts only the last 14 days", () => {
      store.replaceBoard("repo", [boardItem(6, "L"), boardItem(7, "M")]);
      ended(6, until - 2 * DAY, 390_000);
      ended(8, until - 2 * DAY, 450_000, { ticket: "repo#6" });
      // size M runs older than two weeks do not count toward its baseline
      store.upsertRun(
        run({
          id: "old",
          ticket: "repo#1",
          startedAt: until - 20 * DAY,
          endedAt: until - 20 * DAY + 1,
          status: "ok",
          tokens: tokens(10),
        }),
      );
      const t = overuse();
      expect(t.runs.map((r) => [r.runId, r.expected, r.cause])).toEqual([
        ["m8", 400_000, "wide-ticket"],
      ]);
      expect(t.expected).toContainEqual({ size: "L", tokens: 400_000, measured: false });
    });

    it("counts only build runs, in the findings and in the baseline", () => {
      for (const [id, agentId, total] of [
        ["flight", "flight", 3_000_000],
        ["obs", "ebull", 900_000],
        ["unknown", "gone", 900_000],
      ] as const) {
        ended(0, until - DAY, total, { id, agentId, ticket: null });
      }
      // planner runs on size M tickets would drag its median down to 1k
      for (const n of [1, 2, 3, 4, 5, 6]) {
        ended(n, until - DAY + n, 1_000, { id: `plan${n}`, agentId: "planner" });
      }
      ended(6, until - 2 * DAY, 300_000);
      const t = overuse();
      expect(t.runs.map((r) => [r.runId, r.expected])).toEqual([["m6", 153_750]]);
    });

    it("groups repeat causes across runs", () => {
      ended(6, until - 2 * DAY, 300_000);
      ended(7, until - 2 * DAY, 320_000);
      review("m6", 1, [finding("correctness")]);
      review("m6", 2, [finding("correctness")]);
      review("m6", 3, [finding("correctness")]);
      review("m6", 4, [finding("correctness")]);
      review("m7", 1, [finding("correctness")]);
      review("m7", 2, [finding("correctness")]);
      review("m7", 3, [finding("correctness")]);
      review("m7", 4, [finding("correctness")]);
      const { groups } = overuse();
      expect(groups).toEqual([
        expect.objectContaining({
          cause: "rework-churn",
          runIds: ["m7", "m6"],
          prevention: expect.objectContaining({ kind: "lesson" }),
        }),
      ]);
    });
  });

  it("says whether each long runner ended, its kind, and whether the operator can act on it", () => {
    store.upsertRun(run({ id: "live", agentId: "guido", startedAt: 100 }));
    store.setSeatSession({
      seatId: "guido",
      runId: "live",
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: 150,
      lastTurnEndedAt: null,
      lastTurnStartedAt: null,
    });
    store.upsertRun(
      run({ id: "done", agentId: "inco", startedAt: 100, endedAt: 180, status: "ok" }),
    );
    store.upsertRun(run({ id: "stale", agentId: "inco", startedAt: 100 }));
    store.upsertRun(run({ id: "watch", agentId: "flight", startedAt: 100 }));
    store.upsertRun(run({ id: "loop", agentId: "studio", startedAt: 100 }));
    const kinds = new Map<string, LoopKind | "observed">([
      ["guido", "build"],
      ["inco", "build"],
      ["flight", "watch"],
      ["studio", "observed"],
    ]);
    const byId = Object.fromEntries(
      store.audit(100, 200, kinds).longRunners.map((r) => [r.runId, r]),
    );
    expect(byId.live).toMatchObject({ endedAt: null, kind: "build", actionable: true });
    expect(byId.done).toMatchObject({ endedAt: 180, kind: "build", actionable: true });
    expect(byId.stale).toMatchObject({ endedAt: null, kind: "build", actionable: false });
    expect(byId.watch).toMatchObject({ endedAt: null, kind: "watch", actionable: false });
    expect(byId.loop).toMatchObject({ endedAt: null, kind: "observed", actionable: false });
  });

  it("aggregates death loops and immutable model/prompt launch metadata", () => {
    store.upsertRun(
      run({
        id: "timeline",
        startedAt: 110,
        model: "opus",
        accountId: "account-a",
        effort: "high",
        promptHash: "prompt-a",
      }),
    );
    store.upsertRun(run({ id: "outside", startedAt: 99, model: "old", promptHash: "old" }));
    store.setRunLoop(
      "timeline",
      { ...NEW_LOOP, phase: "parked", parked: { kind: "ci", reason: "one", ended: false } },
      120,
    );
    store.setRunLoop("timeline", { ...NEW_LOOP, phase: "working" }, 130);
    store.setRunLoop(
      "timeline",
      { ...NEW_LOOP, phase: "parked", parked: { kind: "ci", reason: "two", ended: false } },
      140,
    );
    store.setRunLoop("timeline", { ...NEW_LOOP, phase: "working" }, 210);

    const audit = store.audit(100, 200);
    expect(audit.deathLoops).toEqual([{ runId: "timeline", agentId: "a1", parks: 2 }]);
    expect(audit.modelPromptTimeline).toEqual([
      {
        at: 110,
        model: "opus",
        accountId: "account-a",
        effort: "high",
        promptHash: "prompt-a",
      },
    ]);
  });

  it("counts completed rework rounds without inflating retries", () => {
    const review = (
      authorRunId: string,
      round: number,
      attempt: number,
      state: "reported" | "failed",
      at: number,
    ) => {
      const id = store.requestReview({
        authorRunId,
        repoId: "repo",
        seatId: "retro",
        prNumber: 7,
        sha: `${authorRunId}-${round}`,
        epoch: 0,
        attempt,
        round,
        at: at - 1,
      });
      expect(id).not.toBeNull();
      store.setReviewState(id as number, ["queued"], state, {
        at,
        ...(state === "failed" ? { failure: "retry" } : {}),
      });
    };
    review("first-pass", 1, 1, "reported", 110);
    review("reworked", 1, 1, "failed", 120);
    review("reworked", 1, 2, "reported", 130);
    review("reworked", 2, 1, "reported", 140);
    review("reworked", 2, 2, "reported", 150);
    review("reworked", 3, 1, "failed", 160);

    expect(store.audit(100, 200).reworkRounds).toEqual([
      { runId: "reworked", agentId: null, rounds: 1, maxRound: 2 },
      { runId: "first-pass", agentId: null, rounds: 0, maxRound: 1 },
    ]);
  });

  it("counts a merged ticket's cost once when it has multiple PRs", () => {
    store.upsertRun(run({ ticket: "repo#1", costUsd: 10 }));
    const pr = (number: number) => ({
      repoId: "repo",
      number,
      title: "t",
      url: "u",
      branch: `fix/${number}`,
      ticket: "repo#1",
      state: "merged" as const,
      isDraft: false,
      review: null,
      ci: null,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: 100,
      headSha: null,
      mergeable: null,
    });
    store.upsertPullRequests("repo", [pr(1), pr(2)], 101);
    expect(store.audit(0, 200).costPerMergedTicket).toEqual([{ ticket: "repo#1", costUsd: 10 }]);
  });

  describe("audit panels", () => {
    const mergedPr = (number: number, mergedAt: number, over: Record<string, unknown> = {}) => ({
      repoId: "repo",
      number,
      title: "t",
      url: "u",
      branch: `fix/${number}`,
      ticket: `repo#${number}`,
      state: "merged" as const,
      isDraft: false,
      review: null,
      ci: null,
      createdAt: 1,
      updatedAt: 2,
      mergedAt,
      headSha: null,
      mergeable: null,
      ...over,
    });

    it("lists each merged PR's size in range, with the outliers", () => {
      store.upsertPullRequests(
        "repo",
        [
          mergedPr(1, 150, { additions: 10, deletions: 5, changedFiles: 2 }),
          mergedPr(2, 160, { additions: 700, deletions: 100, changedFiles: 30 }),
          mergedPr(3, 170),
          mergedPr(4, 50, { additions: 900, deletions: 0, changedFiles: 4 }),
        ],
        200,
      );
      const { prSizes } = store.audit(100, 200) as unknown as AuditView;
      expect(prSizes.prs.map((p) => p.number)).toEqual([2, 1]);
      expect(prSizes.prs[1]).toEqual({
        repoId: "repo",
        number: 1,
        ticket: "repo#1",
        mergedAt: 150,
        additions: 10,
        deletions: 5,
        changedFiles: 2,
      });
      expect(prSizes.outliers.map((p) => p.number)).toEqual([2]);
      expect((store.audit(300, 400) as unknown as AuditView).prSizes).toEqual({
        prs: [],
        outliers: [],
      });
    });

    it("names the seat and run of each improvement candidate", () => {
      store.upsertRun(
        run({ id: "cheap1", agentId: "a1", startedAt: 110, ticket: "repo#1", costUsd: 1 }),
      );
      store.upsertRun(run({ id: "cheap2", agentId: "a2", startedAt: 120, costUsd: 1 }));
      store.upsertRun(run({ id: "cheap3", agentId: "a2", startedAt: 130, costUsd: 1 }));
      store.upsertRun(
        run({ id: "dear", agentId: "a3", startedAt: 140, ticket: "repo#9", costUsd: 9 }),
      );
      store.upsertRun(run({ id: "outside", agentId: "a3", startedAt: 20, costUsd: 99 }));
      store.setRunLoop(
        "cheap2",
        { ...NEW_LOOP, phase: "parked", parked: { kind: "ci", reason: "x", ended: false } },
        150,
      );
      store.addGuardHit({ agentId: "a2", runId: "cheap2", rule: "read-only", text: "t", at: 150 });
      store.addGuardHit({ agentId: "a2", runId: "cheap2", rule: "read-only", text: "t", at: 151 });
      store.addGuardHit({ agentId: "a2", runId: null, rule: "network", text: "t", at: 152 });
      const id = store.requestReview({
        authorRunId: "cheap1",
        repoId: "repo",
        seatId: "retro",
        prNumber: 1,
        sha: "s",
        epoch: 0,
        attempt: 1,
        round: 2,
        at: 160,
      }) as number;
      store.setReviewState(id, ["queued"], "reported", { at: 170 });

      const audit = store.audit(100, 200) as unknown as AuditView;
      expect(audit.longRunners).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: "dear", agentId: "a3" })]),
      );
      expect(audit.deathLoops).toEqual([{ runId: "cheap2", agentId: "a2", parks: 1 }]);
      expect(audit.reworkRounds).toEqual([
        { runId: "cheap1", agentId: "a1", rounds: 1, maxRound: 2 },
      ]);
      expect(audit.refusals).toEqual([
        { agentId: "a2", runId: "cheap2", rule: "read-only", count: 2 },
        { agentId: "a2", runId: null, rule: "network", count: 1 },
      ]);
      expect(audit.spendOutliers).toEqual([
        { runId: "dear", agentId: "a3", ticket: "repo#9", costUsd: 9 },
      ]);
    });

    it("counts a known zero-cost run in the spend median", () => {
      store.upsertRun(run({ id: "free", startedAt: 110, costUsd: 0 }));
      store.upsertRun(run({ id: "one", startedAt: 120, costUsd: 1 }));
      store.upsertRun(run({ id: "three", startedAt: 130, costUsd: 3 }));
      store.upsertRun(run({ id: "unknown", startedAt: 140 }));
      expect((store.audit(100, 200) as unknown as AuditView).spendOutliers).toEqual([
        { runId: "three", agentId: "a1", ticket: null, costUsd: 3 },
      ]);
    });

    it("keeps change metrics inside the selected range", () => {
      store.upsertRun(run({ id: "q1", startedAt: 100, promptHash: "h1" }));
      store.upsertRun(run({ id: "q2", startedAt: 300, promptHash: "h2" }));
      store.upsertPullRequests("repo", [mergedPr(1, 150), mergedPr(2, 270), mergedPr(3, 320)], 500);
      const { changes } = store.audit(250, 500) as unknown as AuditView;
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        windowMs: 50,
        before: { merged: 1 },
        after: { merged: 1 },
      });
    });

    it("finds chatter, refusal spikes and flakes in range only", () => {
      for (let i = 0; i < 7; i++) {
        store.addComms({ at: 110 + i, from: "alpha", to: "beta", ticket: "mc#1", text: "ping" });
        store.addComms({ at: 120 + i, from: "beta", to: "alpha", ticket: "mc#1", text: "pong" });
      }
      for (let i = 0; i < 10; i++) {
        store.addGuardHit({
          agentId: "spiky",
          runId: "r",
          rule: "network",
          text: "t",
          at: 100 + i,
        });
      }
      store.addGuardHit({ agentId: "calm", runId: "r", rule: "network", text: "t", at: 100 });
      store.setSetting(
        `${FLIGHT_SIGNALS_SETTING}:repo`,
        JSON.stringify({
          flakes: {
            a: { key: "repo:CI/unit", at: 150, evidence: "e" },
            b: { key: "repo:CI/unit", at: 160, evidence: "e" },
            c: { key: "repo:CI/e2e", at: 50, evidence: "e" },
          },
        }),
      );
      store.setSetting(`${FLIGHT_SIGNALS_SETTING}:broken`, "{");

      const audit = store.audit(100, 200) as unknown as AuditView;
      expect(audit.chatter).toEqual([
        {
          from: "alpha",
          to: "beta",
          ticket: "mc#1",
          rounds: 7,
          tokens: 0,
          flightSteppedInAt: null,
        },
      ]);
      expect(audit.refusalSpikes).toEqual([{ agentId: "spiky", day: 0, count: 10 }]);
      expect(audit.flakes).toEqual([{ key: "repo:CI/unit", count: 2, lastAt: 160 }]);

      const later = store.audit(1000, 2000) as unknown as AuditView;
      expect(later.chatter).toEqual([]);
      expect(later.refusalSpikes).toEqual([]);
      expect(later.flakes).toEqual([]);
    });

    it("measures equal windows before and after a prompt or model change", () => {
      store.upsertRun(
        run({
          id: "p1",
          startedAt: 100,
          promptHash: "h1",
          model: "m1",
          ticket: "repo#1",
          costUsd: 4,
        }),
      );
      store.upsertRun(
        run({
          id: "p2",
          startedAt: 300,
          promptHash: "h2",
          model: "m1",
          ticket: "repo#2",
          costUsd: 2,
        }),
      );
      store.upsertRun(
        run({
          id: "p3",
          startedAt: 350,
          promptHash: "h2",
          model: "m2",
          ticket: "repo#3",
          costUsd: 6,
        }),
      );
      store.upsertPullRequests(
        "repo",
        [mergedPr(1, 150), mergedPr(2, 310), mergedPr(3, 360), mergedPr(9, 450)],
        500,
      );
      const review = (author: string, round: number, at: number, blocking: boolean) => {
        const id = store.requestReview({
          authorRunId: author,
          repoId: "repo",
          seatId: "retro",
          prNumber: 1,
          sha: `${author}-${round}`,
          epoch: 0,
          attempt: 1,
          round,
          at: at - 1,
        }) as number;
        store.setReviewState(id, ["queued"], "running", { at, runId: `rv-${id}` });
        store.recordFindings(id, `rv-${id}`, {
          verdict: { spec: "pass", quality: blocking ? "fail" : "pass" },
          summary: "s",
          findings: blocking
            ? [{ severity: "Critical", file: "f", line: 1, summary: "s", scenario: "s", fix: "f" }]
            : [],
          at,
        });
      };
      review("p1", 1, 200, true);
      review("p1", 2, 250, false);
      review("p2", 1, 320, false);

      const { changes } = store.audit(0, 500) as unknown as AuditView;
      expect(changes).toEqual([
        {
          kind: "prompt",
          agentId: "a1",
          at: 300,
          from: "h1",
          to: "h2",
          windowMs: 200,
          before: { merged: 1, reviewFailRate: 0.5, medianCostPerMergedTicket: 4, reworkRounds: 1 },
          after: { merged: 3, reviewFailRate: 0, medianCostPerMergedTicket: 4, reworkRounds: 0 },
        },
        {
          kind: "model",
          agentId: "a1",
          at: 350,
          from: "m1",
          to: "m2",
          windowMs: 150,
          before: {
            merged: 1,
            reviewFailRate: 1 / 3,
            medianCostPerMergedTicket: 2,
            reworkRounds: 1,
          },
          after: { merged: 2, reviewFailRate: null, medianCostPerMergedTicket: 6, reworkRounds: 0 },
        },
      ]);
      expect((store.audit(600, 700) as unknown as AuditView).changes).toEqual([]);
    });
  });

  // #26 A1: the scheduler emits `boards` / `escalations` only when a write changed a row.
  it("the GitHub writers report whether any stored row changed", () => {
    const item = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
      repoId: "r1",
      issueNumber: n,
      title: `t${n}`,
      status: "Todo",
      state: "planned",
      labels: ["a"],
      priority: null,
      updatedAt: n,
      url: "u",
      stage: null,
      owner: null,
      parent: null,
      subIssues: null,
      assignees: [],
      blockedBy: [],
      milestone: null,
      size: null,
      closed: false,
      prioritySource: null,
      createdAt: 1,
      itemId: null,
      projectId: null,
      ...over,
    });
    expect(store.replaceBoard("r1", [item(1), item(2)])).toBe(true);
    expect(store.replaceBoard("r1", [item(1), item(2)])).toBe(false);
    expect(store.replaceBoard("r1", [item(2), item(1)])).toBe(false); // order is not a change
    expect(store.replaceBoard("r1", [item(1), item(2, { title: "changed" })])).toBe(true);
    expect(store.replaceBoard("r1", [item(1), item(2, { title: "changed" })])).toBe(false);
    expect(store.replaceBoard("r1", [item(1), item(2, { title: "changed", closed: true })])).toBe(
      true,
    );
    expect(
      store.replaceBoard("r1", [
        item(1),
        item(2, { title: "changed", closed: true, prioritySource: "label" }),
      ]),
    ).toBe(true);
    expect(store.replaceBoard("r1", [item(1)])).toBe(true);
    expect(store.replaceBoard("r2", [])).toBe(false);

    const pr = (number: number, over: object = {}) => ({
      repoId: "r1",
      number,
      title: `t${number}`,
      url: "u",
      branch: "fix/1-x",
      ticket: "r1#1",
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: null,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: null,
      mergeable: null,
      ...over,
    });
    expect(store.upsertPullRequests("r1", [pr(1), pr(2)], 0)).toBe(true);
    expect(store.upsertPullRequests("r1", [pr(1)], 0)).toBe(false);
    expect(store.upsertPullRequests("r1", [pr(1, { ci: "passing" })], 0)).toBe(true);
    expect(store.replacePullRequests("r1", [pr(1, { ci: "passing" }), pr(2)], 0)).toBe(false);
    expect(store.replacePullRequests("r1", [pr(1, { ci: "passing" })], 0)).toBe(true);
    expect(store.replacePullRequests("r1", [pr(1, { ci: "passing", title: "x" })], 0)).toBe(true);

    const esc = (id: string, title = id): Escalation => ({
      id,
      repoId: "r1",
      issueNumber: 1,
      title,
      kind: "operator-decision",
      source: "title",
      openedAt: 1,
      url: "u",
      question: null,
    });
    expect(store.replaceEscalations("r1", [esc("a"), esc("b")])).toBe(true);
    expect(store.replaceEscalations("r1", [esc("b"), esc("a")])).toBe(false);
    expect(store.replaceEscalations("r1", [esc("a", "renamed"), esc("b")])).toBe(true);
    expect(store.replaceEscalations("r1", [])).toBe(true);
    expect(store.replaceEscalations("r1", [])).toBe(false);
  });

  it("offsets default to 0 and persist across reopen", () => {
    expect(store.getOffset("/f")).toBe(0);
    store.setOffset("/f", 10);
    store.setOffset("/f", 25);
    expect(store.getOffset("/f")).toBe(25);
    const again = new Store(join(dir, "mc.sqlite"));
    expect(again.getOffset("/f")).toBe(25);
  });

  it("setStatus upserts collector status", () => {
    store.setStatus("gh", true, null);
    store.setStatus("gh", false, "boom'; x");
    store.setStatus("fs", true, null);
    const st = store.status();
    expect(st).toHaveLength(2);
    const gh = st.find((s) => s.collector === "gh");
    expect(gh?.ok).toBe(false);
    expect(gh?.error).toBe("boom'; x");
    expect(typeof gh?.at).toBe("number");
  });

  it("keeps lastOkAt and failingSince: a run of failures keeps its first time, ok clears it", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1000);
      store.setStatus("gh", false, "boom");
      expect(store.status()[0]).toEqual({
        collector: "gh",
        ok: false,
        error: "boom",
        at: 1000,
        lastOkAt: null,
        failingSince: 1000,
      });
      now.mockReturnValue(1500);
      store.setStatus("gh", false, "boom");
      expect(store.status()[0]).toMatchObject({ at: 1500, failingSince: 1000 });
      now.mockReturnValue(2000);
      store.setStatus("gh", true, null);
      expect(store.status()[0]).toMatchObject({
        ok: true,
        at: 2000,
        lastOkAt: 2000,
        failingSince: null,
      });
      now.mockReturnValue(3000);
      store.setStatus("gh", false, "HTTP 502");
      expect(store.status()[0]).toMatchObject({
        ok: false,
        at: 3000,
        lastOkAt: 2000,
        failingSince: 3000,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("adds collector_status.last_ok_at to an older database (ok rows: their own time)", () => {
    const old = join(dir, "old-status.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE collector_status (
      collector TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL)`);
    db.exec("INSERT INTO collector_status VALUES ('a', 1, NULL, 50), ('b', 0, 'x', 60)");
    db.close();
    expect(new Store(old).status().map((r) => [r.collector, r.lastOkAt])).toEqual([
      ["a", 50],
      ["b", null],
    ]);
  });
  it("persists task identities, measured zero and first-content timing", () => {
    const recorded = digest({
      tasks: [{ id: "1", text: "Verify changes", status: "done" }],
      attemptUsage: [{ id: "m", at: 1000, tokens: 0 }],
      speed: { tokensPerSec: null, turnMs: 4000, firstTokenMs: 1000 },
    });
    store.setDigest("measured", recorded);
    expect(store.digest("measured")).toEqual(recorded);
    expect(store.digests(["measured"]).get("measured")).toEqual(recorded);
  });

  it("round-trips run digests apart from the run rows", () => {
    store.upsertRun(run());
    store.upsertRun(run({ id: "r2" }));
    expect(store.digest("r1")).toBeNull();
    store.setDigest("r1", digest());
    store.setDigest("r2", digest({ liveTool: null }));
    store.setDigest("r1", digest({ toolCalls: 4 }));
    expect(store.digest("r1")).toEqual(digest({ toolCalls: 4 }));
    const both = store.digests(["r1", "r2", "missing"]);
    expect([...both.keys()].sort()).toEqual(["r1", "r2"]);
    expect(both.get("r2")?.liveTool).toBeNull();
    expect(store.digests([]).size).toBe(0);
    // Runs do not carry the digest.
    expect(store.runs("a1", 10)[0]).not.toHaveProperty("digest");
  });

  it("reads a digest persisted before `background` existed as none in flight", () => {
    store.upsertRun(run());
    const { background: _, ...old } = digest();
    store.setDigest("r1", old as RunDigest);
    expect(store.digest("r1")?.background).toEqual([]);
    expect(store.digests(["r1"]).get("r1")?.background).toEqual([]);
    expect(store.digest("r1")).toEqual(digest({ background: [] }));
  });

  it("reads a digest persisted before `compactions` existed as none", () => {
    store.upsertRun(run());
    const { compactions: _, ...old } = digest();
    store.setDigest("r1", old as RunDigest);
    expect(store.digest("r1")?.compactions).toBe(0);
    expect(store.digests(["r1"]).get("r1")?.compactions).toBe(0);
  });

  it("reads a digest persisted before `lastText` and the live tool's `detail` as having none", () => {
    store.upsertRun(run());
    const { lastText: _, ...old } = digest({ liveTool: { name: "Bash", since: 4000 } });
    store.setDigest("r1", old as RunDigest);
    expect(store.digest("r1")?.lastText).toBeNull();
    expect(store.digest("r1")?.liveTool).toEqual({ name: "Bash", since: 4000, detail: null });
    expect(store.digests(["r1"]).get("r1")?.lastText).toBeNull();
  });

  it("keeps the run's ticket title, and a rewrite without one does not clear it", () => {
    store.upsertRun(run({ ticketTitle: "Quote cache" }));
    expect(store.run("r1")?.ticketTitle).toBe("Quote cache");
    store.upsertRun(run({ summary: "Later." }));
    expect(store.run("r1")).toMatchObject({ ticketTitle: "Quote cache", summary: "Later." });
    store.upsertRun(run({ id: "r2", seq: 2 }));
    expect(store.run("r2")?.ticketTitle ?? null).toBeNull();
  });

  describe("agent events", () => {
    const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
      agentId: "a1",
      at: 1000,
      from: "running",
      to: "stalled",
      text: "Running → Stalled",
      ...over,
    });

    it("returns events since a time oldest first, and each agent's latest state", () => {
      store.addAgentEvent(ev({ at: 3000, from: "stalled", to: "running" }));
      store.addAgentEvent(ev({ at: 1000 }));
      store.addAgentEvent(ev({ agentId: "a2", at: 2000, to: "error" }));
      expect(store.agentEvents(2000).map((e) => [e.agentId, e.at])).toEqual([
        ["a2", 2000],
        ["a1", 3000],
      ]);
      expect([...store.latestAgentStates()].sort()).toEqual([
        ["a1", "running"],
        ["a2", "error"],
      ]);
    });

    it("keeps the first of two changes of one agent in the same millisecond", () => {
      store.addAgentEvent(ev());
      store.addAgentEvent(ev({ to: "error" }));
      expect(store.agentEvents(0)).toHaveLength(1);
    });

    it("pruneAgentEvents drops events before the cut-off", () => {
      store.addAgentEvent(ev({ at: 1000 }));
      store.addAgentEvent(ev({ at: 5000 }));
      store.pruneAgentEvents(2000);
      expect(store.agentEvents(0).map((e) => e.at)).toEqual([5000]);
    });
  });

  it("pruneDigests drops the digests of runs that started before the cut-off", () => {
    const DAY = 86_400_000;
    const now = 100 * DAY;
    store.upsertRun(run({ id: "old", startedAt: now - 31 * DAY }));
    store.upsertRun(run({ id: "new", startedAt: now - 29 * DAY }));
    store.setDigest("old", digest());
    store.setDigest("new", digest());
    store.pruneDigests(now - 30 * DAY);
    expect(store.digest("old")).toBeNull();
    expect(store.digest("new")).not.toBeNull();
    // The runs themselves stay.
    expect(
      store
        .runs("a1", 10)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["new", "old"]);
  });

  it("stores machine samples, returns those since a time oldest first, and prunes beyond 7 days", () => {
    const at = (t: number): MachineSample => ({
      at: t,
      cpuPct: 1,
      cores: 8,
      memUsedBytes: 2,
      memTotalBytes: 3,
      diskFreeBytes: null,
      diskTotalBytes: null,
      agents: null,
    });
    const base = 1_000 * 86_400_000;
    expect(store.machineSamples(0)).toEqual([]);
    store.addMachineSample(at(base));
    store.addMachineSample(at(base + 60_000));
    store.addMachineSample(at(base + 60_000)); // same minute re-added: one row
    expect(store.machineSamples(0).map((s) => s.at)).toEqual([base, base + 60_000]);
    expect(store.machineSamples(base + 1).map((s) => s.at)).toEqual([base + 60_000]);
    expect(store.machineSamples(0)[0]).toEqual(at(base));
    // 7 days later: the first two are older than the window, a sample exactly at the edge stays.
    store.addMachineSample(at(base + MACHINE_RETENTION_MS));
    expect(store.machineSamples(0).map((s) => s.at)).toEqual([
      base,
      base + 60_000,
      base + MACHINE_RETENTION_MS,
    ]);
    store.addMachineSample(at(base + MACHINE_RETENTION_MS + 120_000));
    expect(store.machineSamples(0).map((s) => s.at)).toEqual([
      base + MACHINE_RETENTION_MS,
      base + MACHINE_RETENTION_MS + 120_000,
    ]);
  });

  describe("machineBuckets", () => {
    const SINCE = 1_000_000;
    const BUCKET = 10_000;
    const sample = (
      t: number,
      cpuPct: number | null,
      memUsedBytes: number | null = null,
      memTotalBytes = 100,
    ): MachineSample => ({
      at: t,
      cpuPct,
      cores: 4,
      memUsedBytes,
      memTotalBytes,
      diskFreeBytes: null,
      diskTotalBytes: null,
      agents: null,
    });
    const buckets = () => store.machineBuckets(SINCE, SINCE + 5 * BUCKET, BUCKET, 5);

    it("averages per bucket, keeps the last sample's time, and nulls what nothing measured", () => {
      store.addMachineSample(sample(SINCE, 10, 20));
      store.addMachineSample(sample(SINCE + 5_000, 30, 40));
      store.addMachineSample(sample(SINCE + BUCKET, null, null));
      expect(buckets()).toEqual([
        { at: SINCE + 5_000, cpuPct: 20, memPct: 30 },
        { at: SINCE + BUCKET, cpuPct: null, memPct: null },
      ]);
    });

    it("includes samples at exactly since and until, and none outside them", () => {
      store.addMachineSample(sample(SINCE - 1, 1));
      store.addMachineSample(sample(SINCE, 2));
      store.addMachineSample(sample(SINCE + 5 * BUCKET, 3));
      store.addMachineSample(sample(SINCE + 5 * BUCKET + 1, 4));
      // The sample at `until` falls in the last bucket (the index is capped at points - 1).
      expect(buckets().map((b) => [b.at, b.cpuPct])).toEqual([
        [SINCE, 2],
        [SINCE + 5 * BUCKET, 3],
      ]);
    });

    it("ignores a sample with no memory total in the memory mean", () => {
      store.addMachineSample(sample(SINCE, 10, 50, 100));
      store.addMachineSample(sample(SINCE + 1, 10, 5, 0));
      expect(buckets()).toEqual([{ at: SINCE + 1, cpuPct: 10, memPct: 50 }]);
    });

    it("reads the pre-extracted columns, not the sample JSON", () => {
      store.addMachineSample(sample(SINCE, 10, 20));
      store.addMachineSample(sample(SINCE + BUCKET, 30, 60));
      const raw = new DatabaseSync(join(dir, "mc.sqlite"));
      raw.exec("UPDATE machine_samples SET sample = 'not json'"); // json_extract would throw
      raw.close();
      expect(buckets()).toEqual([
        { at: SINCE, cpuPct: 10, memPct: 20 },
        { at: SINCE + BUCKET, cpuPct: 30, memPct: 60 },
      ]);
    });

    it("backfills the columns of a database that stored samples before them", () => {
      const old = join(dir, "old.sqlite");
      const db = new DatabaseSync(old);
      db.exec("CREATE TABLE machine_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL)");
      const ins = db.prepare("INSERT INTO machine_samples VALUES (?, ?)");
      ins.run(SINCE, JSON.stringify(sample(SINCE, 10, 20)));
      ins.run(SINCE + 1, JSON.stringify(sample(SINCE + 1, null, 5, 0)));
      db.close();
      const migrated = new Store(old);
      expect(migrated.machineBuckets(SINCE, SINCE + BUCKET, BUCKET, 5)).toEqual([
        { at: SINCE + 1, cpuPct: 10, memPct: 20 },
      ]);
      expect(migrated.machineSamples(0)).toHaveLength(2);
      new Store(old); // re-opening an already-migrated database is a no-op
    });
  });

  describe("sweepPullRequests", () => {
    const pr = (number: number, over: object = {}) => ({
      repoId: "r1",
      number,
      title: `t${number}`,
      url: "u",
      branch: "b",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: null,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      headSha: null,
      mergeable: null,
      ...over,
    });
    const titles = () => store.pullRequests("r1").map((p) => [p.number, p.title]);

    it("keeps a row read after the sweep's read began, writes one read at the same instant", () => {
      store.upsertPullRequests("r1", [pr(1, { title: "polled" })], 100);
      expect(store.sweepPullRequests("r1", [pr(1, { title: "swept" })], 99)).toBe(false);
      expect(titles()).toEqual([[1, "polled"]]);
      expect(store.sweepPullRequests("r1", [pr(1, { title: "swept" })], 100)).toBe(true);
      expect(titles()).toEqual([[1, "swept"]]);
    });

    it("deletes an unseen row only when it was read before the sweep's read began", () => {
      store.upsertPullRequests("r1", [pr(1)], 100);
      store.sweepPullRequests("r1", [pr(2)], 100);
      expect(titles()).toEqual([
        [2, "t2"],
        [1, "t1"],
      ]);
      store.sweepPullRequests("r1", [pr(2)], 101);
      expect(titles()).toEqual([[2, "t2"]]);
    });

    it("is not a change when only the read time moves", () => {
      store.upsertPullRequests("r1", [pr(1)], 100);
      expect(store.upsertPullRequests("r1", [pr(1)], 200)).toBe(false);
      expect(store.sweepPullRequests("r1", [pr(1)], 300)).toBe(false);
    });

    it("adds read_at to an older pull_requests table, read at 0", () => {
      const old = join(dir, "old-prs.sqlite");
      const db = new DatabaseSync(old);
      db.exec(`CREATE TABLE pull_requests (
        repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
        review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        merged_at INTEGER, PRIMARY KEY (repo_id, number))`);
      db.exec(
        "INSERT INTO pull_requests VALUES ('r1', 1, 't', 'u', 'b', NULL, 'open', 0, NULL, NULL, 1, 2, NULL)",
      );
      db.close();
      const migrated = new Store(old);
      // A sweep at any time may replace a row stored before read_at existed.
      migrated.sweepPullRequests("r1", [pr(2)], 1);
      expect(migrated.pullRequests("r1").map((p) => p.number)).toEqual([2]);
    });
  });

  it("acks round-trip; re-acking a key moves its time", () => {
    expect(store.acks()).toEqual(new Map());
    store.ack(["esc:a", "stall:x:r1"], 1000);
    store.ack(["esc:a"], 2000);
    expect(store.acks()).toEqual(
      new Map([
        ["esc:a", 2000],
        ["stall:x:r1", 1000],
      ]),
    );
  });

  // Review Focus 5
  it("sweepAcks keeps an old ack whose key was absent for one poll and came back", () => {
    const DAY = 86_400_000;
    const t = 100 * DAY;
    store.ack(["esc:shop-app#9"], t - 10 * DAY);
    store.sweepAcks(new Set(["esc:shop-app#9"]), t - DAY);
    store.sweepAcks(new Set(), t); // a search that missed it
    store.sweepAcks(new Set(["esc:shop-app#9"]), t + 60_000); // back again
    // Absent again for longer than the window, measured from the new absence only.
    store.sweepAcks(new Set(), t + 2 * 60_000);
    store.sweepAcks(new Set(), t + 2 * 60_000 + ACK_ABSENT_MS);
    expect(store.acks().has("esc:shop-app#9")).toBe(true);
  });

  it("sweepAcks deletes an ack whose key has been absent for more than 7 days", () => {
    const t = 1_000_000_000;
    store.ack(["gone", "kept"], t);
    store.sweepAcks(new Set(["kept"]), t);
    store.sweepAcks(new Set(["kept"]), t + ACK_ABSENT_MS);
    expect([...store.acks().keys()].sort()).toEqual(["gone", "kept"]);
    store.sweepAcks(new Set(["kept"]), t + ACK_ABSENT_MS + 1);
    expect([...store.acks().keys()]).toEqual(["kept"]);
    expect(ACK_ABSENT_MS).toBe(7 * 86_400_000);
  });

  it("settings get and set", () => {
    expect(store.getSetting("away")).toBeNull();
    store.setSetting("away", '{"on":true}');
    store.setSetting("away", '{"on":false}');
    expect(store.getSetting("away")).toBe('{"on":false}');
    expect(store.getSetting("other")).toBeNull();
  });

  it("replaces flow rows per repo, retains open work and filters completed issues on doneAt", () => {
    store.replaceFlow(
      "r1",
      [
        { repoId: "r1", number: 1, size: "S", startAt: 10, doneAt: 100 },
        { repoId: "r1", number: 2, size: null, startAt: null, doneAt: 200 },
        { repoId: "r1", number: 3, size: null, startAt: 5, doneAt: null },
      ],
      [
        { repoId: "r1", number: 7, mergedAt: 100, firstPushCi: "passing" },
        { repoId: "r1", number: 8, mergedAt: 300, firstPushCi: null },
      ],
    );
    store.replaceFlow(
      "r2",
      [{ repoId: "r2", number: 1, size: null, startAt: 1, doneAt: 150 }],
      [{ repoId: "r2", number: 1, mergedAt: 150, firstPushCi: "failing" }],
    );
    expect(store.flowIssues(0).map((i) => [i.repoId, i.number])).toEqual([
      ["r1", 3],
      ["r1", 1],
      ["r2", 1],
      ["r1", 2],
    ]);
    expect(store.flowIssues(150).map((i) => [i.repoId, i.number])).toEqual([
      ["r1", 3],
      ["r2", 1],
      ["r1", 2],
    ]);
    expect(store.flowIssues(0).find((issue) => issue.number === 1)).toEqual({
      repoId: "r1",
      number: 1,
      size: "S",
      startAt: 10,
      doneAt: 100,
    });
    expect(store.flowPrs(200)).toEqual([
      { repoId: "r1", number: 8, mergedAt: 300, firstPushCi: null },
    ]);
    store.replaceFlow("r1", [], []);
    expect(store.flowIssues(0).map((i) => i.repoId)).toEqual(["r2"]);
    expect(store.flowPrs(0).map((p) => p.repoId)).toEqual(["r2"]);
  });
});

describe("FLIGHT's brief", () => {
  it("keeps the FLIGHT brief across a reopen", () => {
    const path = join(dir, "brief.sqlite");
    const first = new Store(path);
    const r = {
      sessionId: "s1",
      section: "lessons" as const,
      text: "Read the log.",
      updatedAt: 1,
      updatedBy: "flight-1",
    };
    first.setFlightBriefSection(r);
    first.setFlightBriefSection({ ...r, text: "Read the log first.", updatedAt: 2 });
    first.close();
    const again = new Store(path);
    expect(again.flightBrief("s1")).toEqual([{ ...r, text: "Read the log first.", updatedAt: 2 }]);
    expect(again.flightBrief("s2")).toEqual([]);
    again.close();
  });
});

describe("seat sessions", () => {
  const seat = (over: Partial<SeatSessionRow> = {}): SeatSessionRow => ({
    seatId: "guido",
    runId: "guido:20261020T101500Z",
    cliSessionId: "cli-1",
    state: "running",
    reason: null,
    worktree: "/w/guido",
    updatedAt: 5,
    lastTurnEndedAt: null,
    lastTurnStartedAt: null,
    ...over,
  });

  it("keeps when the last turn ended apart from the row's other writes", () => {
    store.setSeatSession(seat());
    store.setSeatTurnEnded("guido", 77);
    expect(store.seatSession("guido")).toEqual(seat({ lastTurnEndedAt: 77 }));
    store.setSeatSession(seat({ state: "idle", updatedAt: 9 }));
    expect(store.seatSession("guido")?.lastTurnEndedAt).toBe(77);
  });

  it("clears when the last turn ended with null", () => {
    store.setSeatSession(seat());
    store.setSeatTurnEnded("guido", 77);
    store.setSeatTurnEnded("guido", null);
    expect(store.seatSession("guido")?.lastTurnEndedAt).toBeNull();
  });

  it("asideRuns: unended runs with an aside, oldest first", () => {
    const aside = { worktree: "/w/x", wake: false };
    store.upsertRun(run({ id: "b", seq: 2, startedAt: 2000, loop: { ...NEW_LOOP, aside } }));
    store.upsertRun(run({ id: "a", seq: 1, startedAt: 1000, loop: { ...NEW_LOOP, aside } }));
    store.upsertRun(run({ id: "none", seq: 3, startedAt: 3000, loop: NEW_LOOP }));
    store.upsertRun(run({ id: "plain", seq: 4, startedAt: 4000 }));
    store.upsertRun(
      run({ id: "ended", seq: 5, startedAt: 500, endedAt: 600, loop: { ...NEW_LOOP, aside } }),
    );
    expect(store.asideRuns().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("round-trips a row and upserts on the seat id", () => {
    expect(store.seatSession("guido")).toBeNull();
    store.setSeatSession(seat());
    expect(store.seatSession("guido")).toEqual(seat());
    store.setSeatSession(seat({ state: "parked", reason: "rate limit", updatedAt: 9 }));
    expect(store.seatSession("guido")).toEqual(
      seat({ state: "parked", reason: "rate limit", updatedAt: 9 }),
    );
  });

  it("batches named seat sessions", () => {
    store.setSeatSession(seat());
    const rows = store.seatSessions(["guido", "missing"]);
    expect(rows.get("guido")).toEqual(store.seatSession("guido"));
    expect(rows.has("missing")).toBe(false);
  });

  it("keeps null run, session, reason and worktree", () => {
    const row = seat({ runId: null, cliSessionId: null, state: "idle", worktree: null });
    store.setSeatSession(row);
    expect(store.seatSession("guido")).toEqual(row);
  });

  it("lists active sessions only: a run, and idle/starting/running/parked", () => {
    store.setSeatSession(seat({ seatId: "a", state: "idle" }));
    store.setSeatSession(seat({ seatId: "b", state: "starting" }));
    store.setSeatSession(seat({ seatId: "c", state: "running" }));
    store.setSeatSession(seat({ seatId: "d", state: "parked" }));
    store.setSeatSession(seat({ seatId: "e", state: "stopped" }));
    store.setSeatSession(seat({ seatId: "f", state: "error" }));
    store.setSeatSession(seat({ seatId: "g", state: "running", runId: null }));
    expect(
      store
        .activeSeatSessions()
        .map((r) => r.seatId)
        .sort(),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("adds the table to a database made before it", () => {
    const path = join(dir, "old.sqlite");
    const old = new Store(path);
    old.setSeatSession(seat());
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE seat_sessions");
    raw.close();
    const migrated = new Store(path);
    expect(migrated.seatSession("guido")).toBeNull();
    migrated.setSeatSession(seat());
    expect(migrated.seatSession("guido")).toEqual(seat());
  });
});

describe("guard hits", () => {
  const DAY = 24 * 3600e3;
  const hit = (over: Partial<Omit<GuardHit, "id">> = {}): Omit<GuardHit, "id"> => ({
    agentId: "guido-1",
    runId: "run-1",
    rule: "git-write",
    text: "git writes only through the mc commit, push and draft-PR tools: git push",
    at: 10 * DAY,
    ...over,
  });

  it("records a hit with its id and lists hits since a time, newest first", () => {
    const a = store.addGuardHit(hit({ at: 10 * DAY }));
    const b = store.addGuardHit(
      hit({ at: 11 * DAY, rule: "network", text: "x: curl", runId: null }),
    );
    store.addGuardHit(hit({ at: 2 * DAY }));
    expect(b).toBeGreaterThan(a);
    expect(store.guardHits(4 * DAY)).toEqual([
      { id: b, ...hit({ at: 11 * DAY, rule: "network", text: "x: curl", runId: null }) },
      { id: a, ...hit({ at: 10 * DAY }) },
    ]);
  });

  it("counts hits by rule over a window, every rule present", () => {
    const now = 20 * DAY;
    store.addGuardHit(hit({ at: now - DAY }));
    store.addGuardHit(hit({ at: now - 2 * DAY }));
    store.addGuardHit(hit({ at: now - 3 * DAY, rule: "network" }));
    store.addGuardHit(hit({ at: now - 8 * DAY, rule: "read-only" }));
    // a hit stored under a rule since retired (github-write) is listed but not counted
    store.addGuardHit(hit({ at: now - DAY, rule: "github-write" as GuardRule }));
    expect(store.guardHitCounts(now - 7 * DAY)).toEqual({
      background: 0,
      "git-write": 2,
      "git-env": 0,
      "codex-allowlist": 0,
      "gh-cli": 0,
      "merge-push": 0,
      "flight-powers": 0,
      "full-suite": 0,
      "read-only": 0,
      network: 1,
      unreadable: 0,
      secret: 0,
    });
  });

  it("counts only the given run's hits", () => {
    store.addGuardHit(hit({ runId: "run-a" }));
    store.addGuardHit(hit({ runId: "run-a", rule: "network" }));
    store.addGuardHit(hit({ runId: "run-b" }));
    store.addGuardHit(hit({ runId: null }));
    expect(store.guardHitCount("run-a")).toBe(2);
    expect(store.guardHitCount("run-b")).toBe(1);
    expect(store.guardHitCount("run-c")).toBe(0);
  });

  it("adds the table and its index to a database made before it", () => {
    const path = join(dir, "old.sqlite");
    new Store(path).addGuardHit(hit());
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE guard_hits");
    raw.close();
    const migrated = new Store(path);
    expect(migrated.guardHits(0)).toEqual([]);
    const check = new DatabaseSync(path);
    const idx = check.prepare("PRAGMA index_list(guard_hits)").all() as { name: string }[];
    check.close();
    expect(idx.map((i) => i.name)).toContain("guard_hits_at");
  });
});

describe("crewTranscriptPath", () => {
  it("is {db dir}/crew/{runId}.jsonl and creates the directory with mode 0700", () => {
    const path = crewTranscriptPath(join(dir, "mc.sqlite"), "guido:20261020T101500Z");
    expect(path).toBe(join(dir, "crew", "guido:20261020T101500Z.jsonl"));
    expect(statSync(join(dir, "crew")).mode & 0o777).toBe(0o700);
  });

  it("is idempotent", () => {
    crewTranscriptPath(join(dir, "mc.sqlite"), "r1");
    expect(crewTranscriptPath(join(dir, "mc.sqlite"), "r2")).toBe(join(dir, "crew", "r2.jsonl"));
  });
});

describe("crewPromptPath", () => {
  it("is {db dir}/crew/{runId}.prompt.md, beside the transcript", () => {
    const path = crewPromptPath(join(dir, "mc.sqlite"), "guido:20261020T101500Z");
    expect(path).toBe(join(dir, "crew", "guido:20261020T101500Z.prompt.md"));
    expect(statSync(join(dir, "crew")).mode & 0o777).toBe(0o700);
  });
});

describe("run", () => {
  it("reads one run by id, or null", () => {
    store.upsertRun(run());
    expect(store.run("r1")).toEqual(run());
    expect(store.run("nope")).toBeNull();
  });
});

describe("reviews", () => {
  const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
    authorRunId: "author",
    repoId: "repo",
    seatId: "retro",
    prNumber: 7,
    sha: "a".repeat(40),
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 100,
    ...over,
  });
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    severity: "Critical",
    file: "a.ts",
    line: 3,
    summary: "s",
    scenario: "sc",
    fix: "f",
    ...over,
  });
  const verdict = { spec: "fail", quality: "pass" } as const;
  const running = (): number => {
    const id = store.requestReview(request());
    if (id === null) throw new Error("no id");
    store.setReviewState(id, ["queued"], "starting", { at: 110 });
    store.setReviewState(id, ["starting"], "running", { at: 120, runId: "rev-run" });
    return id;
  };

  it("migrates twice", () => {
    const path = join(dir, "twice.sqlite");
    new Store(path).close();
    new Store(path).close();
    const db = new DatabaseSync(path);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["reviews", "review_findings", "run_attempts"]));
    const cols = db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("review_id");
    db.close();
  });

  it("requestReview is keyed", () => {
    const id = store.requestReview(request());
    expect(id).toEqual(expect.any(Number));
    expect(store.requestReview(request())).toBeNull();
    const other = store.requestReview(request({ attempt: 2 }));
    expect(other).not.toBeNull();
    expect(other).not.toBe(id);
    expect(store.review(id as number)).toMatchObject({
      state: "queued",
      createdAt: 100,
      runId: null,
      verdict: null,
      blocking: 0,
      minor: 0,
    });
    expect(store.reviewsOfRun("author").map((r) => r.id)).toEqual([id, other]);
  });

  it("setReviewState is a CAS", () => {
    const id = store.requestReview(request()) as number;
    expect(store.setReviewState(id, ["queued"], "starting", { at: 110 })).toBe(true);
    expect(store.setReviewState(id, ["queued"], "starting", { at: 111 })).toBe(false);
    expect(store.review(id)?.startedAt).toBe(110);
    expect(store.setReviewState(id, ["starting"], "running", { at: 120, runId: "rev-run" })).toBe(
      true,
    );
    expect(store.review(id)).toMatchObject({ runId: "rev-run", startedAt: 110, state: "running" });
    expect(store.reviewOfRun("rev-run")?.id).toBe(id);
    expect(store.setReviewState(id, ["running"], "failed", { at: 130, failure: "boom" })).toBe(
      true,
    );
    expect(store.review(id)).toMatchObject({ endedAt: 130, failure: "boom", state: "failed" });
    expect(store.setReviewState(id, ["starting"], "queued", { at: 140 })).toBe(false);
    expect(store.reviewsIn(["failed"]).map((r) => r.id)).toEqual([id]);
    expect(store.reviewsIn([])).toEqual([]);
  });

  it("requeueing clears started_at", () => {
    const id = store.requestReview(request()) as number;
    store.setReviewState(id, ["queued"], "starting", { at: 110 });
    expect(store.setReviewState(id, ["starting"], "queued", { at: 111 })).toBe(true);
    expect(store.review(id)?.startedAt).toBeNull();
  });

  it("recordFindings once", () => {
    const id = running();
    const findings = [
      finding(),
      finding({ severity: "Important", line: 0 }),
      finding({ severity: "Minor", file: "b/c.ts" }),
    ];
    expect(store.recordFindings(id, "rev-run", { verdict, summary: "ok", findings, at: 200 })).toBe(
      true,
    );
    expect(store.review(id)).toMatchObject({
      state: "reported",
      blocking: 2,
      minor: 1,
      summary: "ok",
      verdict,
      endedAt: 200,
    });
    expect(store.findingsOf(id).map((f) => [f.pos, f.state, f.severity])).toEqual([
      [0, "open", "Critical"],
      [1, "open", "Important"],
      [2, "logged", "Minor"],
    ]);
    expect(store.findingsOf(id)[1]).toMatchObject({ line: 0, file: "a.ts", fix: "f" });
    expect(store.recordFindings(id, "rev-run", { verdict, summary: "ok", findings, at: 210 })).toBe(
      false,
    );
    expect(store.findingsOf(id)).toHaveLength(3);

    const other = store.requestReview(request({ attempt: 2 })) as number;
    store.setReviewState(other, ["queued"], "starting", { at: 1 });
    store.setReviewState(other, ["starting"], "running", { at: 2, runId: "r2" });
    store.setReviewState(other, ["running"], "superseded", { at: 3 });
    expect(store.recordFindings(other, "r2", { verdict, summary: "x", findings, at: 4 })).toBe(
      false,
    );
    expect(store.findingsOf(other)).toEqual([]);
    // another run's id does not record either
    const third = store.requestReview(request({ attempt: 3 })) as number;
    store.setReviewState(third, ["queued"], "running", { at: 1, runId: "r3" });
    expect(store.recordFindings(third, "r2", { verdict, summary: "x", findings, at: 4 })).toBe(
      false,
    );
  });

  describe("finding resolutions", () => {
    const round = (n: number, runId: string, findings: ReviewFinding[], resolutions = []) => {
      const id = store.requestReview(request({ round: n, attempt: n, sha: String(n).repeat(40) }));
      if (id === null) throw new Error("no id");
      store.setReviewState(id, ["queued"], "starting", { at: 110 * n });
      store.setReviewState(id, ["starting"], "running", { at: 120 * n, runId });
      const blocking = findings.some((f) => f.severity !== "Minor");
      store.recordFindings(id, runId, {
        verdict: blocking ? verdict : { spec: "pass", quality: "pass" },
        summary: "ok",
        findings,
        resolutions,
        at: 200 * n,
      });
      return id;
    };

    it("stores the category, and no resolution until a later round reports", () => {
      const first = round(1, "rev-1", [finding({ category: "test-missing" }), finding()]);
      expect(store.findingsOf(first)).toMatchObject([
        { pos: 0, category: "test-missing" },
        { pos: 1 },
      ]);
      expect(store.findingsOf(first).map((f) => f.resolution)).toEqual([undefined, undefined]);
    });

    it("sets RETRO's outcome on each finding it names, and the engine's fixed on the rest when the round accepts", () => {
      const first = round(1, "rev-1", [
        finding(),
        finding({ severity: "Important" }),
        finding({ severity: "Important", file: "c.ts" }),
        finding({ severity: "Minor" }),
      ]);
      const second = round(2, "rev-2", [], [
        { findingRef: { reviewId: first, pos: 0 }, outcome: "reply-accepted" },
        { findingRef: { reviewId: first, pos: 1 }, outcome: "held" },
      ] as never);
      expect(store.findingsOf(first).map((f) => [f.pos, f.resolution, f.resolvedReviewId])).toEqual(
        [
          [0, "reply-accepted", second],
          [1, "held", second],
          [2, "fixed", second],
          [3, undefined, undefined],
        ],
      );
    });

    it("leaves unnamed findings open while the later round still blocks", () => {
      const first = round(1, "rev-1", [finding(), finding({ file: "b.ts" })]);
      const second = round(2, "rev-2", [finding({ file: "b.ts" })], [
        { findingRef: { reviewId: first, pos: 0 }, outcome: "fixed" },
      ] as never);
      expect(store.findingsOf(first).map((f) => f.resolution)).toEqual(["fixed", undefined]);
      expect(store.findingsOf(second).map((f) => f.resolution)).toEqual([undefined]);
    });

    it("lists findings with their review for the QA board", () => {
      const first = round(1, "rev-1", [finding({ category: "security" })]);
      round(2, "rev-2", []);
      expect(store.qaFindings(0)).toEqual([
        expect.objectContaining({
          reviewId: first,
          prNumber: 7,
          round: 1,
          category: "security",
          resolution: "fixed",
        }),
      ]);
      expect(store.qaFindings(10_000)).toEqual([]);
    });
  });

  it("review runs are not ticket runs", () => {
    store.upsertRun(run({ id: "author", ticket: "repo#5", startedAt: 1000 }));
    store.upsertRun(run({ id: "rev-run", ticket: "repo#5", startedAt: 2000, reviewId: 1 }));
    expect(store.activeTickets()).toEqual(new Set(["repo#5"]));
    store.upsertRun(run({ id: "author", ticket: "repo#5", startedAt: 1000, endedAt: 1500 }));
    expect(store.activeTickets()).toEqual(new Set());
    expect(
      store.hasNewerRunOnTicket(run({ id: "author", ticket: "repo#5", startedAt: 1000 })),
    ).toBe(false);
  });

  it("reviewsWithLiveRun", () => {
    const id = running();
    store.upsertRun(run({ id: "rev-run", reviewId: id }));
    expect(store.reviewsWithLiveRun()).toEqual([]);
    expect(store.runOfReview(id)?.id).toBe("rev-run");
    store.recordFindings(id, "rev-run", {
      verdict: { spec: "pass", quality: "pass" },
      summary: "ok",
      findings: [],
      at: 300,
    });
    expect(store.reviewsWithLiveRun().map((r) => r.id)).toEqual([id]);
    store.upsertRun(run({ id: "rev-run", reviewId: id, endedAt: 400 }));
    expect(store.reviewsWithLiveRun()).toEqual([]);
  });

  it("upsertRun keeps review_id", () => {
    store.upsertRun(run({ id: "rev-run", reviewId: 1 }));
    store.upsertRun(run({ id: "rev-run", summary: "later" }));
    expect(store.run("rev-run")).toMatchObject({ reviewId: 1, summary: "later" });
    store.upsertRun(run({ id: "plain" }));
    expect(store.run("plain")?.reviewId).toBeNull();
  });

  it("upsertRun stores a new row's profile and hash and never rewrites them", () => {
    const profile = { ...DEFAULT_PROFILES[0], tries: 3 } as Profile;
    const chosen = { profile, route: { by: "size", size: "M" } as const, hash: "h1" };
    store.upsertRun(run({ id: "p1", profile: chosen }));
    store.upsertRun(run({ id: "p1", summary: "later", profile: { ...chosen, hash: "h2" } }));
    store.upsertRun(run({ id: "p1", summary: "again" }));
    const got = store.run("p1");
    expect(got?.profile).toEqual(chosen);
    expect(got?.summary).toBe("again");
    store.upsertRun(run({ id: "p2" }));
    expect(store.run("p2")).not.toHaveProperty("profile");
  });

  it("keeps one override per ticket, the latest winning", () => {
    expect(store.profileOverride("r", 7)).toBeNull();
    store.setProfileOverride("r", 7, { profile: "feature", reason: "a", by: "planner" }, 10);
    store.setProfileOverride("r", 7, { profile: "bugfix", reason: "b", by: "FLIGHT" }, 20);
    store.setProfileOverride("r", 8, { profile: "research", reason: "c", by: "FLIGHT" }, 30);
    expect(store.profileOverride("r", 7)).toEqual({
      profile: "bugfix",
      reason: "b",
      by: "FLIGHT",
    });
    expect(store.profileOverride("r", 8)?.profile).toBe("research");
  });

  it("evidenceNotes lists a run's notes in order", () => {
    store.addEvidence("r1", "one", 1);
    store.addEvidence("r1", "two", 2);
    store.addEvidence("r2", "other", 3);
    expect(store.evidenceNotes("r1").map((e) => e.note)).toEqual(["one", "two"]);
  });
});

describe("queues across seats", () => {
  const items = (...issues: number[]) => issues.map((issue) => ({ repoId: "repo", issue }));
  const issuesOf = (seatId: string) => store.queue(seatId).map((q) => q.issue);

  it("replaceQueues clears every listed seat's untaken rows first", () => {
    store.replaceQueue("s1", items(3, 4));
    store.replaceQueues([
      { seatId: "s1", items: items(4) },
      { seatId: "s2", items: items(3) },
    ]);
    expect(issuesOf("s1")).toEqual([4]);
    expect(issuesOf("s2")).toEqual([3]);
  });

  it("replaceQueues skips an issue another seat holds taken", () => {
    store.replaceQueue("s1", items(3));
    store.takeQueued("s1", 5);
    store.replaceQueues([
      { seatId: "s1", items: [] },
      { seatId: "s2", items: items(3) },
    ]);
    expect(issuesOf("s2")).toEqual([]);
    expect(store.queue("s1").map((q) => [q.issue, q.takenAt])).toEqual([[3, 5]]);
  });
});

describe("liveSeatRuns and branchCommitSpan", () => {
  const row = (over: Partial<SeatSessionRow>): SeatSessionRow => ({
    seatId: "a",
    runId: null,
    cliSessionId: null,
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: 5,
    lastTurnEndedAt: null,
    lastTurnStartedAt: null,
    ...over,
  });

  it("liveSeatRuns lists unended runs a seat row names, whatever the seat state", () => {
    store.upsertRun(run({ id: "ra" }));
    store.upsertRun(run({ id: "rb", endedAt: 2000 }));
    store.upsertRun(run({ id: "rc" }));
    store.setSeatSession(row({ seatId: "a", runId: "ra", worktree: "/w/a" }));
    store.setSeatSession(row({ seatId: "b", runId: "rb", state: "idle" }));
    store.setSeatSession(row({ seatId: "c", runId: "rc", state: "stopped", worktree: "/w/c" }));
    store.setSeatSession(row({ seatId: "d", state: "idle" }));
    expect(store.liveSeatRuns()).toEqual([
      { seatId: "a", worktree: "/w/a", run: run({ id: "ra" }) },
      { seatId: "c", worktree: "/w/c", run: run({ id: "rc" }) },
    ]);
  });

  it("branchCommitSpan gives the first and last recorded commit of a branch", () => {
    store.upsertRun(run({ id: "r1" }));
    store.upsertRun(run({ id: "r2" }));
    const c = (runId: string, sha: string) =>
      store.addRunCommit({ runId, repoId: "repo", branch: "feature/1-x", sha, at: 1 });
    c("r1", "sha1");
    c("r1", "sha2");
    c("r2", "sha3");
    expect(store.branchCommitSpan("repo", "feature/1-x")).toEqual({ first: "sha1", last: "sha3" });
    expect(store.branchCommitSpan("repo", "feature/2-y")).toBeNull();
  });
});

describe("passQuestion", () => {
  it("is true once, and false after the question is answered", () => {
    const id = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "q?", at: 1 });
    expect(store.question(id)).toMatchObject({ passedAt: null, answeredAt: null });
    expect(store.passQuestion(id, 5)).toBe(true);
    expect(store.passQuestion(id, 6)).toBe(false);
    expect(store.question(id)).toMatchObject({ passedAt: 5 });
    expect(store.openQuestions()).toMatchObject([{ id, passedAt: 5 }]);
    const other = store.addQuestion({ agentId: "guido-2", runId: "r2", text: "q?", at: 1 });
    store.answerQuestions("guido-2", 7);
    expect(store.passQuestion(other, 8)).toBe(false);
    expect(store.question(other)?.answeredAt).toBe(7);
    expect(store.question(999)).toBeNull();
  });
});

describe("answerQuestions", () => {
  it("with unpassedOnly leaves a passed question open", () => {
    const passed = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "a?", at: 1 });
    const open = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "b?", at: 1 });
    store.passQuestion(passed, 2);
    store.answerQuestions("guido-1", 5, true);
    expect(store.question(passed)?.answeredAt).toBeNull();
    expect(store.question(open)?.answeredAt).toBe(5);
    store.answerQuestions("guido-1", 6);
    expect(store.question(passed)?.answeredAt).toBe(6);
  });
});

describe("questionsOverlapping", () => {
  it("returns the seat's questions open in the window", () => {
    const ask = (agentId: string, at: number) =>
      store.addQuestion({ agentId, runId: "r1", text: "q?", at });
    ask("guido-1", 10);
    store.answerQuestions("guido-1", 50); // answered before the window
    ask("guido-1", 60);
    store.answerQuestions("guido-1", 120); // open across `from`, answered inside
    ask("guido-1", 130);
    store.answerQuestions("guido-1", 160);
    ask("guido-1", 200); // at `to`: not in [from, to)
    ask("guido-2", 120);
    expect(store.questionsOverlapping("guido-1", 100, 200)).toEqual([
      { at: 60, answeredAt: 120 },
      { at: 130, answeredAt: 160 },
    ]);
    expect(store.questionsOverlapping("guido-1", 100, 250)).toHaveLength(3);
  });
});

describe("flight decisions", () => {
  const dec = (over: Partial<FlightDecision> = {}): Omit<FlightDecision, "id"> => ({
    at: 1000,
    kind: "note",
    seatId: null,
    targetRunId: null,
    ref: null,
    questionId: null,
    about: "a",
    decision: "d",
    basis: "b",
    ...over,
  });

  it("lists newest first from `since`, up to the limit", () => {
    const a = store.addFlightDecision(dec({ at: 1000, about: "a" }));
    store.addFlightDecision(dec({ at: 3000, about: "c" }));
    store.addFlightDecision(dec({ at: 2000, about: "b", seatId: "guido-1", ref: "mc#5" }));
    expect(a).toBe(1);
    expect(store.flightDecisions(0, 10).map((d) => d.about)).toEqual(["c", "b", "a"]);
    expect(store.flightDecisions(2000, 10).map((d) => d.about)).toEqual(["c", "b"]);
    expect(store.flightDecisions(0, 1).map((d) => d.about)).toEqual(["c"]);
    expect(store.flightDecisions(0, 10)[1]).toEqual({
      id: 3,
      ...dec({ at: 2000, about: "b", seatId: "guido-1", ref: "mc#5" }),
    });
  });

  it("counts by kind, seat, ref and run", () => {
    store.addFlightDecision(dec({ kind: "note" }));
    store.addFlightDecision(dec({ kind: "answer", seatId: "guido-1", targetRunId: "r1" }));
    store.addFlightDecision(dec({ kind: "start", seatId: "guido-1", ref: "mc#5", at: 500 }));
    store.addFlightDecision(dec({ kind: "start", seatId: "inco-1", ref: "mc#6" }));
    const count = (q: Partial<Parameters<Store["countFlightDecisions"]>[0]>) =>
      store.countFlightDecisions({ kinds: ["note", "answer", "start"], since: 0, ...q });
    expect(count({})).toBe(4);
    expect(count({ kinds: ["start"] })).toBe(2);
    expect(count({ kinds: ["start"], since: 600 })).toBe(1);
    expect(count({ seatId: "guido-1" })).toBe(2);
    expect(count({ ref: "mc#6" })).toBe(1);
    expect(count({ targetRunId: "r1" })).toBe(1);
    expect(count({ kinds: [] })).toBe(0);
  });
});

describe("comms", () => {
  const row = (text: string, at = 100) => ({
    at,
    from: "CAPCOM",
    to: "guido-1",
    ticket: null,
    text,
  });

  it("keeps a text of COMMS_TEXT_MAX characters whole", () => {
    const text = "x".repeat(COMMS_TEXT_MAX);
    store.addComms(row(text));
    expect(store.comms(0)[0]?.text).toBe(text);
  });

  it("marks an oversized stored copy without throwing or splitting code points", () => {
    const text = "🚀".repeat(COMMS_TEXT_MAX + 1);
    store.addComms(row(text));
    expect(store.comms(0)[0]?.text).toBe(
      `${"🚀".repeat(COMMS_TEXT_MAX)}${commsCutMarker(COMMS_TEXT_MAX, COMMS_TEXT_MAX + 1)}`,
    );
  });

  it("preserves whitespace as typed", () => {
    const text = "  a \n\n b\t\tc  ";
    store.addComms(row(text));
    expect(store.comms(0)[0]?.text).toBe(text);
  });

  it("returns the rows at or after since, oldest first", () => {
    store.addComms({ ...row("late"), at: 300, ticket: "mc#1" });
    store.addComms(row("early", 100));
    expect(store.comms(100).map((c) => c.text)).toEqual(["early", "late"]);
    expect(store.comms(101).map((c) => c.text)).toEqual(["late"]);
    expect(store.comms(300)[0]).toEqual({
      at: 300,
      from: "CAPCOM",
      to: "guido-1",
      ticket: "mc#1",
      text: "late",
    });
  });

  it.each([undefined, "run-1"])("keeps the newest Comms window for target %s", (targetRunId) => {
    for (let i = 1; i <= 5_001; i++)
      store.addComms({ ...row(String(i), i), ...(targetRunId ? { targetRunId } : {}) });
    const rows = store.comms(0, targetRunId);
    expect(rows).toHaveLength(5_000);
    expect(rows[0]?.text).toBe("2");
    expect(rows.at(-1)?.text).toBe("5001");
  });

  it("keeps a run-targeted message out of another run's pending Comms", () => {
    store.addComms({ ...row("rework"), targetRunId: "r1" });
    store.addComms({ ...row("general"), at: 101 });
    expect(store.comms(0, "r1").map((message) => message.text)).toEqual(["rework", "general"]);
    expect(store.comms(0, "r2").map((message) => message.text)).toEqual(["general"]);
  });

  it("counts chatter rounds only when both sides exchanged messages", () => {
    for (let index = 0; index < 14; index++) {
      store.addComms({ at: index, from: "alpha", to: "beta", ticket: "mc#one-way", text: "ping" });
    }
    for (let index = 0; index < 8; index++) {
      store.addComms({
        at: 100 + index,
        from: "alpha",
        to: "beta",
        ticket: "mc#exchange",
        text: "ping",
      });
    }
    for (let index = 0; index < 7; index++) {
      store.addComms({
        at: 200 + index,
        from: "beta",
        to: "alpha",
        ticket: "mc#exchange",
        text: "pong",
      });
    }

    expect(store.commsChatter(0)).toEqual([
      {
        from: "alpha",
        to: "beta",
        ticket: "mc#exchange",
        rounds: 7,
        tokens: 0,
        flightSteppedInAt: null,
      },
    ]);
  });

  it("migrates a retained legacy comms table additively", () => {
    const legacyPath = join(dir, "legacy-comms.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE comms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
      to_id TEXT NOT NULL, ticket TEXT, text TEXT NOT NULL
    ); INSERT INTO comms(at,from_id,to_id,ticket,text) VALUES(1,'a','b',NULL,'legacy')`);
    legacy.close();
    const migrated = new Store(legacyPath);
    try {
      expect(migrated.commsMessage("comms:1")).toMatchObject({ text: "legacy", label: null });
      expect(migrated.addComms({ ...row("new"), label: "question", ref: "#7" })).toMatchObject({
        label: "question",
        ref: "#7",
      });
    } finally {
      migrated.close();
    }
  });

  it("stores complete rows, related facts and monotonic scoped cursors", () => {
    const first = store.addComms({
      ...row("@b first"),
      label: "handoff",
      ref: "#7",
      mentions: ["b"],
    });
    const second = store.addComms({ ...row("second", 101), replyTo: first?.id });
    if (first === null || second === null) throw new Error("Comms rows were not stored");
    expect(store.addCommsReaction(first.id, "b", "cant", "blocked", 102)).toMatchObject({
      messageId: first.id,
      reaction: "cant",
    });
    expect(store.setCommsPinned(second.id, true, "CAPCOM", 103)).toBe(true);
    expect(store.commsForAgent("guido-1")[0]).toMatchObject({
      id: first.id,
      label: "handoff",
      ref: "#7",
      mentions: ["b"],
    });
    expect(store.commsReactions(first.id)).toHaveLength(1);
    expect(store.commsPins().map((m) => m.id)).toEqual([second.id]);
    expect(store.commsMentions("b").map((m) => m.id)).toEqual([first.id]);
    store.markCommsScopeRead("crew", second.id);
    store.markCommsScopeRead("crew", first.id);
    expect(store.commsScopeCursor("crew")).toBe(second.id);
  });

  it("accepts only prefixed Comms IDs for reads and related writes", () => {
    const message = store.addComms(row("stored"));
    if (message === null) throw new Error("Comms row was not stored");
    expect(store.commsMessage("1")).toBeNull();
    expect(store.addCommsReaction("1", "b", "seen", undefined, 1)).toBeNull();
    expect(store.setCommsPinned("1", true, "CAPCOM", 1)).toBe(false);
    expect(store.commsReactions(message.id)).toEqual([]);
    expect(store.commsPins()).toEqual([]);
  });

  it("enforces SQL reaction and label constraints", () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    const inserted = db
      .prepare("INSERT INTO comms(at,from_id,to_id,ticket,text) VALUES(1,'a','b',NULL,'x')")
      .run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO comms_reactions(message_id,actor_id,reaction,reason,at) VALUES(?,?,?,?,?)",
        )
        .run(inserted.lastInsertRowid, "a", "cant", null, 1),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO comms(at,from_id,to_id,ticket,text,label) VALUES(1,'a','b',NULL,'x','nope')",
        )
        .run(),
    ).toThrow();
  });

  it("rate limits atomically and hydrates only ticket candidates with no linked PR", () => {
    const first = store.addComms({ ...row("first") }, { since: 0, limit: 1 });
    expect(first).not.toBeNull();
    expect(store.addComms({ ...row("second", 101) }, { since: 0, limit: 1 })).toBeNull();
    for (let i = 0; i < 40; i++) store.addComms({ ...row(`unrelated ${i}`, 200 + i) });
    const ref = store.addComms({ ...row("mentions #703", 300) });
    const direct = store.addComms({ ...row("ref", 301), ref: "#703" });
    const hydrate = vi.spyOn(store as never, "commsRow" as never);
    expect(store.commsForTicket("#703").rows.map((m) => m.id)).toEqual([ref?.id, direct?.id]);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("prunes dependent Comms rows with their retained message", async () => {
    const old = store.addComms({ ...row("old", 0), mentions: ["b"] });
    if (old === null) throw new Error("Comms row was not stored");
    store.addCommsReaction(old.id, "b", "seen", undefined, 1);
    store.setCommsPinned(old.id, true, "CAPCOM", 1);
    await store.pruneHistory(91 * 86_400_000);
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM comms_mentions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM comms_reactions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM comms_pins").get()).toEqual({ n: 0 });
  });
});

describe("test lock history", () => {
  it("keeps one row per hold, closes the last call with the supplied clock, and frees runs", () => {
    store.upsertRun(run({ ticket: "MC-1" }));
    const h = { runId: "r1", seatId: "a1", command: "pnpm test", toolUseId: "one", since: 1000 };
    store.addLockHold(h);
    store.addLockHold({ ...h, toolUseId: "two", since: 2000 });
    expect(store.lockRuns(0)).toEqual([
      {
        runId: "r1",
        seatId: "a1",
        command: "pnpm test",
        queuedAt: 1000,
        startedAt: 1000,
        endedAt: null,
        outcome: null,
        ticket: "MC-1",
      },
    ]);
    store.deleteLockHold("r1", "one", 3000);
    expect(store.lockRuns(0)[0]?.endedAt).toBeNull();
    store.deleteLockHold("r1", "two", 4000);
    expect(store.lockRuns(0)[0]).toMatchObject({ endedAt: 4000, outcome: "done" });
    store.addLockHold({ ...h, since: 5000, queuedAt: 4500 });
    store.deleteLockHolds("r1", 6000);
    expect(store.lockRuns(0)[0]).toMatchObject({ queuedAt: 4500, endedAt: 6000, outcome: "freed" });
  });

  it("records the Post hook event as pass or fail, and a failed call fails the whole hold", () => {
    const h = { runId: "r1", seatId: "a1", command: "pnpm test", toolUseId: "one", since: 1000 };
    store.addLockHold(h);
    store.deleteLockHold("r1", "one", 2000, false);
    expect(store.lockRuns(0)[0]).toMatchObject({ endedAt: 2000, outcome: "pass" });
    store.addLockHold({ ...h, runId: "r2", since: 3000 });
    store.deleteLockHold("r2", "one", 4000, true);
    expect(store.lockRuns(0)[0]).toMatchObject({ runId: "r2", endedAt: 4000, outcome: "fail" });
    store.addLockHold({ ...h, runId: "r3", since: 5000 });
    store.addLockHold({ ...h, runId: "r3", toolUseId: "two", since: 5001 });
    store.deleteLockHold("r3", "one", 6000, true);
    expect(store.lockRuns(0)[0]).toMatchObject({ runId: "r3", endedAt: null, outcome: "fail" });
    store.deleteLockHold("r3", "two", 7000, false);
    expect(store.lockRuns(0)[0]).toMatchObject({ runId: "r3", endedAt: 7000, outcome: "fail" });
  });

  it("keeps a recorded failure when the run ends before its other call posts", () => {
    const h = { runId: "r1", seatId: "a1", command: "pnpm test", toolUseId: "one", since: 1000 };
    store.addLockHold(h);
    store.addLockHold({ ...h, toolUseId: "two", since: 1001 });
    store.deleteLockHold("r1", "one", 2000, true);
    store.deleteLockHolds("r1", 3000);
    expect(store.lockRuns(0)[0]).toMatchObject({ endedAt: 3000, outcome: "fail" });
  });

  it("prunes history strictly older than ninety days on the next insert", () => {
    const day = 86400000;
    const h = { runId: "old", seatId: "a1", command: "test", toolUseId: "one", since: 1000 };
    store.addLockHold(h);
    store.deleteLockHolds("old", 2000);
    store.addLockHold({ ...h, runId: "edge", since: 1001 });
    store.addLockHold({ ...h, runId: "eight", since: 1001 + 8 * day });
    expect(store.lockRuns(0).map((r) => r.runId)).toEqual(["eight", "edge", "old"]);
    store.addLockHold({ ...h, runId: "new", since: 1001 + 90 * day });
    expect(store.lockRuns(0).map((r) => r.runId)).toEqual(["new", "eight", "edge"]);
  });
});

describe("telemetry store aggregates", () => {
  it("counts commits since the boundary joined to their run's agent", () => {
    store.upsertRun(run());
    store.upsertRun(run({ id: "r2", agentId: "a2" }));
    for (const [runId, sha, at] of [
      ["r1", "old", 99],
      ["r1", "one", 100],
      ["r1", "two", 101],
      ["r2", "three", 102],
      ["missing", "orphan", 103],
    ] as const) {
      store.addRunCommit({ runId, sha, at, repoId: "repo", branch: "b" });
    }
    expect(store.commitsSince(100)).toEqual([
      { agentId: "a1", n: 2 },
      { agentId: "a2", n: 1 },
    ]);
  });

  it("returns cleared note waits for the requested kinds raised since the boundary", () => {
    for (const [key, kind, at, cleared] of [
      ["old", "ready", 99, 200],
      ["ready", "ready", 100, 200],
      ["review", "review", 110, 400],
      ["open", "ready", 120, null],
      ["blocked", "blocked", 130, 500],
    ] as const) {
      store.raiseNote({ key, kind, at, text: key, runId: null, seatId: null, repoId: null });
      if (cleared !== null) store.clearNote(key, cleared);
    }
    expect(store.noteWaits(["ready", "review"], 100)).toEqual([100, 290]);
    expect(store.noteWaits([], 0)).toEqual([]);
  });

  it("counts only answers accompanied by CAPCOM to that seat within five seconds", () => {
    for (const [agentId, answeredAt, from, delay] of [
      ["a", 100, COMMS_CAPCOM, 1000],
      ["b", 110, "flight", 0],
      ["c", 120, null, 0],
      ["d", 130, COMMS_CAPCOM, 5001],
      ["e", 140, COMMS_CAPCOM, -1],
      ["f", 99, COMMS_CAPCOM, 0],
      ["g", 150, COMMS_CAPCOM, 5000],
    ] as const) {
      store.addQuestion({ agentId, runId: "r", text: "?", at: 10 });
      store.answerQuestions(agentId, answeredAt);
      if (from)
        store.addComms({ from, to: agentId, at: answeredAt + delay, text: "answer", ticket: null });
    }
    store.addComms({ from: COMMS_CAPCOM, to: "a", at: 1101, text: "duplicate", ticket: null });
    expect(store.operatorAnswers(100)).toEqual([
      { agentId: "a", at: 10, answeredAt: 100 },
      { agentId: "g", at: 10, answeredAt: 150 },
    ]);
  });

  it("counts operator stops since the boundary, excluding FLIGHT end decisions", () => {
    for (const [id, endedAt, endedBy] of [
      ["one", 100, "operator"],
      ["flight", 101, "operator"],
      ["old", 99, "operator"],
      ["agent", 102, "exit"],
    ] as const) {
      store.upsertRun(run({ id }));
      store.setRunEnded(id, endedAt, "ok", endedBy);
    }
    store.addFlightDecision({
      at: 101,
      kind: "end",
      seatId: null,
      targetRunId: "flight",
      ref: null,
      questionId: null,
      about: "stop",
      decision: "stop",
      basis: "test",
    });
    expect(store.operatorStops(100)).toBe(1);
  });
});

describe("item discussions", () => {
  it("keeps interleaved versions, retries and late replies across restart", () => {
    const a = store.ensureDiscussion("note:a", "v1");
    const b = store.ensureDiscussion("note:b", "v1");
    store.askDiscussion(a.id, "ask-a", "Why?", 1);
    store.askDiscussion(b.id, "ask-b", "Which?", 2);
    store.markDiscussionSent(b.id, "ask-b");
    store.askDiscussion(a.id, "ask-a", "Why?", 1);
    store.addComms({ at: 3, from: "flight", to: "operator", ticket: null, text: "Global" });
    const next = store.ensureDiscussion("note:a", "v2");
    expect(next.messages).toEqual([]);
    expect(store.replyDiscussion(a.id, "ask-a", "reply-a", "Evidence", 4)).toBe(true);
    expect(store.replyDiscussion(b.id, "ask-a", "wrong", "Wrong", 5)).toBe(false);
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    expect(store.discussion("note:a", a.id)?.messages.map((m) => m.text)).toEqual([
      "Why?",
      "Evidence",
    ]);
    expect(store.discussion("note:b", b.id)?.messages.map((m) => m.text)).toEqual(["Which?"]);
    expect(store.discussion("note:a", b.id)).toBeNull();
    expect(store.discussionSent(b.id, "ask-b")).toBe(true);
    expect(store.replyDiscussion(a.id, "ask-a", "reply-a", "Evidence", 4)).toBe(true);
    expect(store.discussion("note:a", a.id)?.messages).toHaveLength(2);
    expect(() => store.askDiscussion(a.id, "ask-a", "Changed", 6)).toThrow();
  });

  it("bounds a thread without moving messages to another item", () => {
    const a = store.ensureDiscussion("note:a", "v1");
    for (let n = 0; n < 150; n++) store.askDiscussion(a.id, `ask-${n}`, "Question", n);
    expect(store.discussion("note:a", a.id)?.messages).toHaveLength(100);
  });
});

it("retains complete and legacy briefs across restart without inventing checked sources", () => {
  const legacy = {
    key: "note:legacy",
    context: "Choose a scope",
    recommendation: "Use scoped rules",
    options: [
      { label: "Scoped", answer: "scope" },
      { label: "Shared", answer: "shared" },
    ],
    basis: "## Code\nRules have a scope key",
    at: 1,
  };
  const complete = {
    ...legacy,
    key: "note:complete",
    for: "flight" as const,
    original: "original".repeat(1500),
    assessment: "a".repeat(8000),
    did: [{ action: "d".repeat(8000), refs: ["mc#466"] }],
    ask: "q".repeat(8000),
    recommendation: "r".repeat(8000),
    catchUp: {
      kind: "follow-up" as const,
      line: "Scope is undecided",
      story: ["Rules were checked"],
      aware: ["No change approved"],
    },
    checked: [{ source: "Code", finding: "Rules have a scope key" }],
    options: [
      { id: "scope", label: "Scoped", description: "Reuse the key", answer: "scope" },
      { id: "shared", label: "Shared", answer: "shared" },
    ],
    recommendedOptionId: "scope",
  };
  store.addBrief(legacy);
  store.addBrief(complete);
  store.close();
  store = new Store(join(dir, "mc.sqlite"));
  const { key: _legacyKey, ...legacyBrief } = legacy;
  const { key: _completeKey, ...completeBrief } = complete;
  expect(store.briefs().get(legacy.key)).toEqual(legacyBrief);
  expect(store.briefs().get(complete.key)).toEqual(completeBrief);
  expect(store.briefs().get(legacy.key)?.checked).toBeUndefined();
});

it("deduplicates a large history with an indexed first-commit lookup", () => {
  for (let i = 0; i < 500; i++) {
    for (const [runId, at] of [
      ["first", i],
      ["retry", i + 1000],
    ] as const)
      store.addRunCommit({ runId, repoId: "repo", branch: "b", sha: String(i), at });
  }
  expect(store.telemetryCommits(0, 2000)).toHaveLength(500);
  expect(store.telemetryCommits(0, 2000).every((c) => c.runId === "first")).toBe(true);
  expect(store.telemetryCommits(1000, 2000)).toEqual([]);
  const db = new DatabaseSync(join(dir, "mc.sqlite"));
  try {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM run_commits WHERE repo_id = ? AND sha = ? ORDER BY at, id LIMIT 1",
      )
      .all("repo", "1");
    expect(plan.map((r) => r.detail).join(" ")).toContain("USING COVERING INDEX run_commits_first");
  } finally {
    db.close();
  }
});

it("retains each reopened attention episode and closes notes by run", () => {
  const note = {
    key: "review",
    kind: "review" as const,
    runId: "r",
    seatId: "seat",
    repoId: "repo",
    text: "review",
    at: 10,
  };
  store.raiseNote(note);
  store.raiseNote({ ...note, at: 15 });
  store.clearNote(note.key, 20);
  store.raiseNote({ ...note, at: 30 });
  store.clearNotesFor("r", 40);
  expect(store.telemetryNoteIntervals("seat", 0, 50, ["review"])).toEqual([
    [10, 20],
    [30, 40],
  ]);
});

describe("hub retention", () => {
  it("keeps unresolved findings and review rounds for an open PR", async () => {
    const day = 86_400_000;
    store.upsertRun(run({ id: "author", endedAt: 1, status: "ok" }));
    store.upsertRun(run({ id: "review", endedAt: 1, status: "ok", reviewId: 1 }));
    store.upsertPullRequests(
      "repo",
      [
        {
          repoId: "repo",
          number: 7,
          title: "Open PR",
          url: "https://example.test/7",
          branch: "feature/7",
          ticket: null,
          state: "open",
          isDraft: false,
          review: null,
          ci: "passing",
          createdAt: 0,
          updatedAt: 1,
          mergedAt: null,
          headSha: "a".repeat(40),
          mergeable: null,
          checks: [],
        },
      ],
      1,
    );
    const reviewId = store.requestReview({
      authorRunId: "author",
      repoId: "repo",
      seatId: "retro",
      prNumber: 7,
      sha: "a".repeat(40),
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 0,
    });
    if (reviewId === null) throw new Error("fixture review missing");
    store.setReviewState(reviewId, ["queued"], "running", { at: 0, runId: "review" });
    store.recordFindings(reviewId, "review", {
      verdict: { spec: "fail", quality: "pass" },
      summary: "Old review",
      findings: [
        { severity: "Important", file: "a.ts", line: 1, summary: "Open", scenario: "s", fix: "f" },
        {
          severity: "Important",
          file: "b.ts",
          line: 1,
          summary: "Resolved",
          scenario: "s",
          fix: "f",
        },
      ],
      at: 1,
    });
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    try {
      db.prepare(
        "UPDATE review_findings SET resolution = 'fixed' WHERE review_id = ? AND pos = 1",
      ).run(reviewId);
      for (let i = 0; i < 12; i++) await store.pruneHistory(366 * day);
      expect(store.findingsOf(reviewId).map((finding) => finding.summary)).toEqual(["Open"]);
      expect(store.qaReviewRounds(366 * day).map((review) => review.reviewId)).toContain(reviewId);
    } finally {
      db.close();
    }
  });

  it("keeps an old current brief only while its attention item remains open", async () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    try {
      db.exec(`INSERT INTO attention_notes (key,kind,text,at,cleared_at) VALUES
        ('brief:open','test','open',0,NULL), ('brief:cleared','test','cleared',0,1);
        INSERT INTO briefs (key,context,recommendation,options,basis,at) VALUES
        ('brief:open','context','recommendation','[]','basis',0),
        ('brief:cleared','context','recommendation','[]','basis',0);`);
      for (let i = 0; i < 12; i++) await store.pruneHistory(91 * 86_400_000);
      expect(db.prepare("SELECT key FROM briefs ORDER BY key").all()).toEqual([
        { key: "brief:open" },
      ]);
    } finally {
      db.close();
    }
  });

  it("expires settled operational history while retaining open attention", async () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    try {
      db.exec(`INSERT INTO attention_notes (key,kind,text,at,cleared_at) VALUES
        ('old-cleared','test','old',0,1), ('open','test','open',0,NULL);
        INSERT INTO attention_episodes VALUES ('old-cleared','test',NULL,0,1);
        INSERT INTO runs (id,agent_id,repo_id,seq,started_at,ended_at,status,transcript_path)
          VALUES ('done-run','seat','repo',1,0,1,'done','/done'),
          ('open-run','seat','repo',2,0,NULL,'running','/open');
        INSERT INTO board_moves (id,run_id,repo_id,issue,board_column,state,at) VALUES
          (1,'done-run','repo',1,'Done','done',0),
          (2,'open-run','repo',2,'In progress','pending',0);
        INSERT INTO seat_questions (agent_id,run_id,text,at,answered_at) VALUES
          ('seat','done-run','answered',0,1), ('seat','open-run','open',0,NULL);
        INSERT INTO guard_hits (agent_id,rule,text,at) VALUES ('seat','rule','old',0);
        INSERT INTO hub_events (at,text) VALUES (0,'old');
        INSERT INTO drafts (target,kind,text,created_at,state) VALUES
          ('old','plan','old',0,'done'), ('pending','plan','pending',0,'pending');
        INSERT INTO crew_errors (agent_id,text,at,acked) VALUES
          ('seat','old',0,1), ('seat','unacked',0,0);`);
      for (let i = 0; i < 12; i++) await store.pruneHistory(91 * 86_400_000);
      expect(db.prepare("SELECT key FROM attention_notes ORDER BY key").all()).toEqual([
        { key: "open" },
      ]);
      for (const table of ["guard_hits", "hub_events", "drafts", "crew_errors"])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual(
          table === "drafts" || table === "crew_errors" ? { n: 1 } : { n: 0 },
        );
      expect(db.prepare("SELECT state FROM board_moves").all()).toEqual([{ state: "pending" }]);
      expect(db.prepare("SELECT answered_at FROM seat_questions").all()).toEqual([
        { answered_at: null },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM attention_episodes").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("expires every settled audit child with its completed owner", async () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    try {
      db.exec(`INSERT INTO runs (id,agent_id,repo_id,seq,started_at,ended_at,status,transcript_path)
        VALUES ('old-run','seat','repo',1,0,1,'done','/old');
        INSERT INTO reviews (id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)
        VALUES (1,'old-run','repo','seat',1,'sha',1,1,1,'reported',0,1);
        INSERT INTO review_checks VALUES (1,'check','pass',NULL);
        INSERT INTO review_tests (review_id,command,passed,failed,skipped,duration) VALUES (1,'test',1,0,0,1);
        INSERT INTO review_resolutions VALUES (1,1,1,'fixed');
        INSERT INTO review_findings (review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,state)
        VALUES (1,'old-run',1,'minor','f',1,'s','s','f','open');
        INSERT INTO run_commits (run_id,repo_id,branch,sha,at) VALUES ('old-run','repo','b','sha',0);
        INSERT INTO run_pushes VALUES ('old-run','sha',0);
        INSERT INTO run_attempts (run_id,kind,at,data) VALUES ('old-run','ci',0,'{}');
        INSERT INTO pr_history VALUES ('repo',1,0,'{}');`);
      for (let i = 0; i < 12; i++) await store.pruneHistory(366 * 86_400_000);
      for (const table of [
        "runs",
        "reviews",
        "review_checks",
        "review_tests",
        "review_resolutions",
        "review_findings",
        "run_commits",
        "run_pushes",
        "run_attempts",
        "pr_history",
      ])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("retains the latest plan while a newer run on the same ticket is kept", async () => {
    const old = run({ id: "planner", ticket: "repo#494", endedAt: 1 });
    const newer = run({ id: "worker", ticket: old.ticket });
    store.upsertRun(old);
    store.upsertRun(newer);
    store.addLoopEvent("planner:plan", old.id, "Plan landed", 1);
    await store.pruneHistory(100 * 86_400_000);
    expect(store.planLanded(newer)).toBe(true);
    expect(store.loopEventsOfRun(old.id)).toHaveLength(1);
    expect(store.run(old.id)).not.toBeNull();
  });

  it("keeps claim keys after their run has expired", async () => {
    store.upsertRun(run({ endedAt: 1 }));
    store.claimLine("fix:r1:0:1", {
      runId: "r1",
      seatId: "seat",
      origin: "engine",
      text: "fix",
      at: 1,
    });
    await store.pruneHistory(100 * 86_400_000);
    expect(store.claimedKeys("r1")).toEqual({ "fix:r1:0:1": 1 });
    expect(store.run("r1")).not.toBeNull();
  });

  it.each(["seat_lines", "loop_events", "run_evidence", "review_findings"])(
    "protects live owners and measures expiry from completion: %s",
    async (table) => {
      const db = new DatabaseSync(join(dir, "mc.sqlite"));
      const now = 100 * 86_400_000;
      const owners = [
        "open",
        "parked",
        "aside",
        "review",
        "recent",
        "question",
        "draft",
        "attention",
        "expired",
      ];
      if (table === "review_findings") owners.push("recentReview", "recentAuthor");
      try {
        for (const [i, id] of owners.entries()) {
          store.upsertRun(
            run({
              id,
              ticket: `repo#${i}`,
              endedAt:
                id === "open" ? null : id === "recent" || id === "recentAuthor" ? now - 1 : 1,
              loop:
                id === "parked"
                  ? { ...NEW_LOOP, phase: "parked" }
                  : id === "aside"
                    ? { ...NEW_LOOP, aside: { worktree: "x", wake: false } }
                    : null,
            }),
          );
          db.prepare(`INSERT INTO reviews
            (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, created_at, ended_at)
            VALUES (?, ?, 'repo', 'seat', 1, ?, 1, 1, 1, ?, 0, ?)`).run(
            i + 1,
            id,
            id,
            id === "review" ? "running" : "reported",
            id === "review" ? null : id === "recent" || id === "recentReview" ? now - 1 : 1,
          );
          if (table === "seat_lines")
            db.prepare("INSERT INTO seat_lines VALUES (?, ?, 'seat', 'sys', 'text', 0)").run(
              id,
              id,
            );
          if (table === "loop_events")
            db.prepare("INSERT INTO loop_events VALUES (?, ?, 'text', 0)").run(id, id);
          if (table === "run_evidence")
            db.prepare("INSERT INTO run_evidence (run_id, note, at) VALUES (?, 'note', 0)").run(id);
          if (table === "review_findings")
            db.prepare(`INSERT INTO review_findings
            (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
            VALUES (?, ?, 0, 'minor', 'f', 1, 's', 's', 'f', 'open')`).run(i + 1, id);
        }
        db.exec(
          "INSERT INTO seat_questions (agent_id, run_id, text, at) VALUES ('a1', 'question', 'q', 0)",
        );
        store.addDraft("repo#6", "issue", "pending", 0);
        db.exec(
          "INSERT INTO attention_notes (key, kind, run_id, text, at) VALUES ('n', 'test', 'attention', 'note', 0)",
        );
        await store.pruneHistory(now);
        const owner = table === "review_findings" ? "author_run_id" : "run_id";
        expect(db.prepare(`SELECT ${owner} AS owner FROM ${table} ORDER BY owner`).all()).toEqual(
          owners
            .filter((id) => !["expired", "question", "draft", "attention"].includes(id))
            .sort()
            .map((owner) => ({ owner })),
        );
      } finally {
        db.close();
      }
    },
  );

  it("bounds batches, yields between them, and caps each sweep", async () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO loop_events VALUES (?, ?, 'text', 0)");
      store.upsertRun(run({ id: "blocked" }));
      insert.run("blocked", "blocked");
      store.upsertRun(run({ endedAt: 1 }));
      for (let i = 0; i < 5501; i++) {
        const id = String(i);
        insert.run(id, "r1");
      }
      let during = -1;
      const observe = setImmediate(() => {
        during = Number(db.prepare("SELECT COUNT(*) AS n FROM loop_events").get()?.n);
      });
      try {
        await store.pruneHistory(100 * 86_400_000);
        expect(during).toBe(5002);
        expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events").get()).toEqual({ n: 502 });
        await store.pruneHistory(100 * 86_400_000);
        expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events").get()).toEqual({ n: 1 });
      } finally {
        clearImmediate(observe);
      }
    } finally {
      db.close();
    }
  });

  it("prunes past each window, keeping boundary and newer rows and review history", async () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    const now = 100 * 86_400_000;
    const seatCutoff = now - 7 * 86_400_000;
    const month = now - 30 * 86_400_000;
    const quarter = now - 90 * 86_400_000;
    store.upsertRun(run());
    for (const [i, offset] of [-1, 0, 1].entries()) {
      store.upsertRun(run({ id: `seat${i}`, endedAt: seatCutoff + offset }));
      store.upsertRun(run({ id: `owner${i}`, endedAt: month + offset }));
      store.upsertRun(run({ id: `quarter${i}`, endedAt: quarter + offset }));
      db.prepare("INSERT INTO seat_lines VALUES (?, ?, 'seat', 'sys', 'text', ?)").run(
        String(i),
        `seat${i}`,
        seatCutoff + offset,
      );
      db.prepare("INSERT INTO loop_events VALUES (?, ?, 'text', ?)").run(
        String(i),
        `owner${i}`,
        month + offset,
      );
      db.prepare("INSERT INTO run_evidence (run_id, note, at) VALUES (?, 'note', ?)").run(
        `owner${i}`,
        month + offset,
      );
      db.prepare(`INSERT INTO reviews
        (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, created_at, ended_at)
        VALUES (?, ?, 'repo', 'seat', 1, ?, 1, 1, 1, 'reported', ?, ?)`).run(
        i + 1,
        `quarter${i}`,
        String(i),
        0,
        quarter + offset,
      );
      db.prepare(`INSERT INTO review_findings
        (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
        VALUES (?, ?, 0, 'minor', 'file.ts', 1, 'summary', 'scenario', 'fix', 'open')`).run(
        i + 1,
        `quarter${i}`,
      );
    }
    db.exec(`INSERT INTO flight_decisions (at, kind, about, decision, basis)
      VALUES (${now - 1}, 'end', 'run', 'ended', 'done')`);
    try {
      await store.pruneHistory(now);
      for (const table of ["seat_lines", "loop_events", "run_evidence", "review_findings"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 2 });
      }
      // a finding lives ninety days, not thirty
      expect(db.prepare("SELECT COUNT(*) AS n FROM review_findings").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT key FROM seat_lines ORDER BY key").all()).toEqual([
        { key: "1" },
        { key: "2" },
      ]);
      expect(db.prepare("SELECT review_id FROM review_findings ORDER BY review_id").all()).toEqual([
        { review_id: 2 },
        { review_id: 3 },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 3 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 10 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM flight_decisions").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

it.each([
  "SELECT * FROM loop_events WHERE run_id = 'r1'",
  "SELECT * FROM reviews WHERE run_id = 'r1'",
  "SELECT * FROM reviews WHERE repo_id = 'repo' AND pr_number = 1 AND state = 'reported'",
  "SELECT * FROM board_moves WHERE run_id = 'r1'",
  "SELECT * FROM flight_decisions WHERE target_run_id = 'r1' AND kind = 'end'",
  "SELECT * FROM runs WHERE review_id = 1",
  "SELECT * FROM runs WHERE repo_id = 'repo' AND branch = 'branch'",
  "SELECT * FROM runs WHERE repo_id = 'repo' AND ticket = 'ticket'",
  "SELECT * FROM runs WHERE ended_at IS NULL",
  "SELECT * FROM runs WHERE folded = 0",
  "SELECT * FROM seat_questions WHERE answered_at IS NULL",
])("uses an index: %s", (query) => {
  const db = new DatabaseSync(join(dir, "mc.sqlite"));
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    expect(plan.map((row) => row.detail).join("\n")).toMatch(/USING (?:COVERING )?INDEX/);
    if (query.includes("pr_number")) {
      expect(plan.map((row) => row.detail).join("\n")).toContain("reviews_repo_pr");
    }
  } finally {
    db.close();
  }
});

describe("Codex lifecycle storage", () => {
  it("defaults old callers to Claude and persists Codex vendor, thread and latest plan", () => {
    store.upsertRun(run());
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    expect(db.prepare("SELECT vendor FROM runs WHERE id = 'r1'").get()?.vendor).toBe("claude");
    store.upsertRun(
      run({
        id: "codex",
        vendor: "codex",
        sessionId: "thread",
        latestPlan: "first",
        plan: { skipped: "Size S" },
      }),
    );
    store.upsertRun(
      run({ id: "codex", vendor: "codex", sessionId: "thread", latestPlan: "second" }),
    );
    expect(store.run("codex")).toMatchObject({
      vendor: "codex",
      sessionId: "thread",
      latestPlan: "second",
      plan: { skipped: "Size S" },
    });
    store.setSeatSession({
      seatId: "a1",
      runId: "codex",
      vendor: "codex",
      cliSessionId: "thread",
      state: "idle",
      reason: null,
      worktree: "/work",
      updatedAt: 1000,
    });
    expect(store.seatSession("a1")).toMatchObject({ vendor: "codex", cliSessionId: "thread" });
    store.setSeatSession({
      seatId: "legacy",
      runId: null,
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1000,
    });
    expect(
      db.prepare("SELECT vendor FROM seat_sessions WHERE seat_id = 'legacy'").get()?.vendor,
    ).toBe("claude");
    db.close();
  });
});

it("migrates existing run and seat rows to the Claude vendor", () => {
  store.upsertRun(run());
  store.setSeatSession({
    seatId: "a1",
    runId: "r1",
    cliSessionId: "claude-id",
    state: "idle",
    reason: null,
    worktree: "/work",
    updatedAt: 1000,
  });
  store.close();
  const db = new DatabaseSync(join(dir, "mc.sqlite"));
  db.exec(
    "ALTER TABLE runs DROP COLUMN vendor; ALTER TABLE runs DROP COLUMN latest_plan; ALTER TABLE seat_sessions DROP COLUMN vendor",
  );
  store = new Store(join(dir, "mc.sqlite"));
  expect(db.prepare("SELECT vendor FROM runs WHERE id = 'r1'").get()?.vendor).toBe("claude");
  expect(db.prepare("SELECT vendor FROM seat_sessions WHERE seat_id = 'a1'").get()?.vendor).toBe(
    "claude",
  );
  expect(store.seatSession("a1")?.cliSessionId).toBe("claude-id");
  db.close();
});

it("retains two CI failures, review and main merge after counters reset", () => {
  store.upsertRun(run());
  store.setRunPush({ runId: "r1", sha: "head-1", at: 1100 });
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "ci", ciFails: 1, ciFailedSha: "head-1" }, 1200);
  store.setRunPush({ runId: "r1", sha: "head-2", at: 1300 });
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "ci", ciFails: 2, ciFailedSha: "head-2" }, 1400);
  const id = store.requestReview({
    authorRunId: "r1",
    repoId: "repo",
    seatId: "reviewer",
    prNumber: 1,
    sha: "head-2",
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 1500,
  });
  expect(id).not.toBeNull();
  store.setRunLoop("r1", { ...NEW_LOOP, carry: { from: "head-2", to: "head-3" } }, 1600);
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "done" }, 1700);
  const history = store.runAttempts("r1");
  expect(history.filter((a) => a.kind === "push").map((a) => a.data.sha)).toEqual([
    "head-1",
    "head-2",
  ]);
  expect(history.filter((a) => a.kind === "loop").map((a) => a.data.ciFails)).toEqual([1, 2, 0, 0]);
  expect(history.find((a) => a.kind === "review")?.data).toMatchObject({ sha: "head-2", round: 1 });
  expect(history.filter((a) => a.kind === "loop")[2]?.data.carry).toEqual({
    from: "head-2",
    to: "head-3",
  });
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "done" }, 1800);
  expect(store.runAttempts("r1")).toEqual(history);
  expect(store.runAttempts("other")).toEqual([]);
});

it("retains distinct wait completions with the same target and duration", () => {
  store.upsertRun(run());
  for (const at of [1600, 1800]) {
    store.setRunLoop("r1", { ...NEW_LOOP, phase: "ci" }, at);
    store.setRunLoop("r1", { ...NEW_LOOP, phase: "working" }, at + 100);
    store.setRunLoop("r1", { ...NEW_LOOP, phase: "working" }, at + 100);
  }
  expect(
    store
      .runAttempts("r1")
      .filter((a) => a.kind === "wait-end")
      .map(({ at, data }) => ({ at, data })),
  ).toEqual([
    { at: 1700, data: { on: "ci", durationMs: 100 } },
    { at: 1900, data: { on: "ci", durationMs: 100 } },
  ]);
});

it("retains named CI attempts, findings, parks, waits and linked reviewer usage", () => {
  store.upsertRun(run({ model: "model-v1", loop: { ...NEW_LOOP, prNumber: 1 } }));
  const pr = {
    repoId: "repo",
    number: 1,
    title: "change",
    url: "https://example.test/pr/1",
    branch: "fix/1-change",
    ticket: null,
    state: "open" as const,
    isDraft: false,
    review: null,
    ci: "failing" as const,
    createdAt: 1000,
    updatedAt: 1100,
    mergedAt: null,
    headSha: "head",
    mergeable: null,
  };
  const check = {
    name: "verify",
    kind: "check" as const,
    state: "failing" as const,
    conclusion: "FAILURE",
    attempt: 1,
    url: "https://example.test/job/1",
  };
  store.upsertPullRequests("repo", [{ ...pr, checks: [check] }], 1100);
  store.upsertPullRequests("repo", [{ ...pr, checks: [{ ...check, attempt: 2 }] }], 1200);
  store.upsertPullRequests("repo", [{ ...pr, checks: [{ ...check, attempt: 2 }] }], 1250);
  const id = store.requestReview({
    authorRunId: "r1",
    repoId: "repo",
    seatId: "reviewer",
    prNumber: 1,
    sha: "head",
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 1300,
  }) as number;
  store.setReviewState(id, ["queued"], "running", { at: 1400, runId: "review-run" });
  const tokens = { input: 10, output: 20, cacheRead: 30, cacheCreate: 0 };
  store.upsertRun(run({ id: "review-run", reviewId: id, tokens }));
  const findings: ReviewFinding[] = [
    {
      severity: "Minor",
      file: "a.ts",
      line: 1,
      summary: "finding",
      scenario: "scenario",
      fix: "fix",
    },
  ];
  store.recordFindings(id, "review-run", {
    verdict: { spec: "pass", quality: "pass" },
    summary: "reviewed",
    findings,
    at: 1500,
  });
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "ci" }, 1600);
  store.setRunLoop(
    "r1",
    { ...NEW_LOOP, phase: "parked", parked: { kind: "ci", reason: "verify failed", ended: false } },
    1700,
  );
  store.setRunLoop("r1", { ...NEW_LOOP, phase: "done" }, 1800);
  store.upsertPullRequests(
    "repo",
    [{ ...pr, state: "merged", mergedAt: 1900, ci: "passing" }],
    1900,
  );
  const history = store.runAttempts("r1");
  expect(
    history
      .filter((a) => a.kind === "ci")
      .slice(0, 2)
      .map((a) => a.data.checks),
  ).toEqual([[check], [{ ...check, attempt: 2 }]]);
  expect(history.filter((a) => a.kind === "ci")).toHaveLength(3);
  expect(history.find((a) => a.kind === "merge")?.data.sha).toBe("head");
  expect(history.find((a) => a.runId === "review-run")?.data.tokens).toEqual(tokens);
  expect(history.find((a) => a.data.findings)?.data.findings).toEqual(findings);
  expect(history.find((a) => a.kind === "wait-end")?.data).toEqual({ on: "ci", durationMs: 100 });
  expect(history.find((a) => a.data.parked)?.data.parked).toMatchObject({
    reason: "verify failed",
  });
});

it("prunes old comms and flight decisions at the retention boundary in bounded sweeps", async () => {
  const now = 100 * 86_400_000;
  const cutoff = now - 90 * 86_400_000;
  for (const at of [cutoff - 1, cutoff, now]) {
    store.addComms({ at, from: "a", to: "b", ticket: null, text: String(at) });
    store.addFlightDecision({
      at,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "note",
      decision: String(at),
      basis: "evidence",
    });
  }
  await store.pruneHistory(now);
  expect(
    store
      .comms(0)
      .map((c) => c.at)
      .sort((a, b) => a - b),
  ).toEqual([cutoff, now]);
  expect(store.flightDecisions(0, 10).map((d) => d.at)).toEqual([now, cutoff]);
});

describe("check runs", () => {
  const sha = (c: string) => c.repeat(40);

  it("answers the newest row for a run, command and head, and nothing for another", () => {
    store.addCheckRun({
      runId: "r1",
      command: "pnpm -s lint",
      headSha: sha("a"),
      ok: false,
      at: 1,
    });
    store.addCheckRun({ runId: "r1", command: "pnpm -s lint", headSha: sha("a"), ok: true, at: 2 });
    expect(store.latestCheckRun("r1", "pnpm -s lint", sha("a"))).toEqual({
      headSha: sha("a"),
      invokedCommand: "pnpm -s lint",
      ok: true,
      exitCode: null,
      at: 2,
    });
    // a later failure on the same head wins
    store.addCheckRun({
      runId: "r1",
      command: "pnpm -s lint",
      headSha: sha("a"),
      ok: false,
      at: 3,
    });
    expect(store.latestCheckRun("r1", "pnpm -s lint", sha("a"))).toEqual({
      headSha: sha("a"),
      invokedCommand: "pnpm -s lint",
      ok: false,
      exitCode: null,
      at: 3,
    });
    expect(store.latestCheckRun("r1", "pnpm -s lint", sha("b"))).toBeNull();
    expect(store.latestCheckRun("r1", "pnpm -s typecheck", sha("a"))).toBeNull();
    expect(store.latestCheckRun("r2", "pnpm -s lint", sha("a"))).toBeNull();
    expect(store.newestCheckRun("r1", "pnpm -s lint")).toEqual({
      headSha: sha("a"),
      invokedCommand: "pnpm -s lint",
      ok: false,
      exitCode: null,
      at: 3,
    });
  });

  it("breaks a tie on the clock by insertion order", () => {
    store.addCheckRun({ runId: "r1", command: "c", headSha: sha("a"), ok: true, at: 5 });
    store.addCheckRun({ runId: "r1", command: "c", headSha: sha("a"), ok: false, at: 5 });
    expect(store.latestCheckRun("r1", "c", sha("a"))).toEqual({
      headSha: sha("a"),
      invokedCommand: "c",
      ok: false,
      exitCode: null,
      at: 5,
    });
  });

  it("binds a command with quotes and percent signs as a value, never as SQL", () => {
    const command = "x'); DROP TABLE check_runs; -- %";
    store.addCheckRun({ runId: "r1", command, headSha: sha("a"), ok: true, at: 1 });
    expect(store.latestCheckRun("r1", command, sha("a"))).toEqual({
      headSha: sha("a"),
      invokedCommand: command,
      ok: true,
      exitCode: null,
      at: 1,
    });
  });
});
