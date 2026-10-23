import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BoardItem,
  Escalation,
  FlightDecision,
  GuardHit,
  MachineSample,
  Profile,
  ReviewFinding,
  ReviewRequest,
  Run,
  RunDigest,
  SeatSessionRow,
  UsageSample,
} from "@mc/core";
import { COMMS_CAPCOM, COMMS_TEXT_MAX, DEFAULT_PROFILES, NEW_LOOP } from "@mc/core";
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

  it("upsertRun keeps one row with the latest fields", () => {
    store.upsertRun(run());
    store.upsertRun(
      run({
        status: "ok",
        endedAt: 2000,
        costUsd: 1.5,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
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
      mergeable: "MERGEABLE" as const,
      author: "octo",
      assignees: ["a", "b"],
      checks: [],
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

  it("keeps lastOkAt: set on ok, unchanged on failure, null before any success", () => {
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
      });
      now.mockReturnValue(2000);
      store.setStatus("gh", true, null);
      expect(store.status()[0]).toMatchObject({ ok: true, at: 2000, lastOkAt: 2000 });
      now.mockReturnValue(3000);
      store.setStatus("gh", false, "HTTP 502");
      expect(store.status()[0]).toMatchObject({ ok: false, at: 3000, lastOkAt: 2000 });
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

  it("replaces flow rows per repo, skips undone issues and filters on doneAt / mergedAt", () => {
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
      ["r1", 1],
      ["r2", 1],
      ["r1", 2],
    ]);
    expect(store.flowIssues(150).map((i) => [i.repoId, i.number])).toEqual([
      ["r2", 1],
      ["r1", 2],
    ]);
    expect(store.flowIssues(0)[0]).toEqual({
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
    expect(store.guardHitCounts(now - 7 * DAY)).toEqual({
      "git-write": 2,
      "github-write": 0,
      "merge-push": 0,
      "full-suite": 0,
      "read-only": 0,
      network: 1,
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
    expect(tables).toEqual(expect.arrayContaining(["reviews", "review_findings"]));
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

  it("cuts a longer text to that length, ending with an ellipsis", () => {
    store.addComms(row("y".repeat(COMMS_TEXT_MAX + 50)));
    const text = store.comms(0)[0]?.text ?? "";
    expect(Array.from(text)).toHaveLength(COMMS_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
  });

  it("makes whitespace runs one space and trims", () => {
    store.addComms(row("  a \n\n b\t\tc  "));
    expect(store.comms(0)[0]?.text).toBe("a b c");
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

  it("prunes history strictly older than eight days on the next insert", () => {
    const h = { runId: "old", seatId: "a1", command: "test", toolUseId: "one", since: 1000 };
    store.addLockHold(h);
    store.deleteLockHolds("old", 2000);
    store.addLockHold({ ...h, runId: "edge", since: 1001 });
    store.addLockHold({ ...h, runId: "new", since: 1001 + 8 * 86400000 });
    expect(store.lockRuns(0).map((r) => r.runId)).toEqual(["new", "edge"]);
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
  it("prunes past each window, keeping boundary and newer rows and review history", () => {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    const now = 40 * 86_400_000;
    const week = now - 7 * 86_400_000;
    const month = now - 30 * 86_400_000;
    store.upsertRun(run());
    for (const [i, offset] of [-1, 0, 1].entries()) {
      db.prepare("INSERT INTO seat_lines VALUES (?, 'r1', 'seat', 'sys', 'text', ?)").run(
        String(i),
        week + offset,
      );
      db.prepare("INSERT INTO loop_events VALUES (?, 'r1', 'text', ?)").run(
        String(i),
        month + offset,
      );
      db.prepare("INSERT INTO run_evidence (run_id, note, at) VALUES ('r1', 'note', ?)").run(
        month + offset,
      );
      db.prepare(`INSERT INTO reviews
        (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, created_at)
        VALUES (?, 'r1', 'repo', 'seat', 1, ?, 1, 1, 1, 'reported', ?)`).run(
        i + 1,
        String(i),
        month + offset,
      );
      db.prepare(`INSERT INTO review_findings
        (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
        VALUES (?, 'r1', 0, 'minor', 'file.ts', 1, 'summary', 'scenario', 'fix', 'open')`).run(
        i + 1,
      );
    }
    db.exec(`INSERT INTO flight_decisions (at, kind, about, decision, basis)
      VALUES (0, 'end', 'run', 'ended', 'done')`);
    try {
      store.pruneHistory(now);
      for (const table of ["seat_lines", "loop_events", "run_evidence", "review_findings"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 2 });
      }
      expect(db.prepare("SELECT key FROM seat_lines ORDER BY key").all()).toEqual([
        { key: "1" },
        { key: "2" },
      ]);
      expect(db.prepare("SELECT review_id FROM review_findings ORDER BY review_id").all()).toEqual([
        { review_id: 2 },
        { review_id: 3 },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 3 });
      expect(store.run("r1")).not.toBeNull();
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
