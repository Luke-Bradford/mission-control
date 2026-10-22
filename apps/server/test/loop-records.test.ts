import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardItem, PullRequestView, Run, RunLoop } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NoteInput, type QueueRow, type SeatLine, Store } from "../src/store.ts";

let dir: string;
let store: Store;
const dbPath = () => join(dir, "mc.sqlite");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-loop-records-"));
  store = new Store(dbPath());
});
afterEach(() => {
  store.close();
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
  ...over,
});

const loop = (over: Partial<RunLoop> = {}): RunLoop => ({
  phase: "ci",
  reportedEvidenceId: 4,
  prNumber: 12,
  pushStartedAt: 5000,
  pushFor: null,
  unparkedAt: null,
  ciFails: 1,
  ciFailedSha: "abc1234",
  relayedSha: null,
  transient: 0,
  lastRefusal: "no",
  epoch: 2,
  budgetExtra: 3,
  parked: { kind: "stall", reason: "idle", ended: false },
  touches: { sha: "abc1234", paths: ["a/b.ts"] },
  cardFor: "ci:2",
  ...over,
});

describe("runs: loop and endedBy", () => {
  it("opening the database again changes nothing and loses no rows", () => {
    store.upsertRun(run());
    store.setRunLoop("r1", loop());
    store.addEvidence("r1", "n", 1);
    store.close();
    store = new Store(dbPath());
    const second = new Store(dbPath());
    expect(second.run("r1")?.loop).toEqual(loop());
    expect(second.evidenceCount("r1")).toBe(1);
    second.close();
  });

  it("adds the columns to a runs table from before them", () => {
    const old = join(dir, "old-runs.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repo_id TEXT NOT NULL, seq INTEGER NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, session_id TEXT,
      model TEXT, branch TEXT, ticket TEXT, cost_usd REAL, tokens TEXT, transcript_path TEXT NOT NULL)`);
    db.exec(`INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, transcript_path)
      VALUES ('r1', 'a1', 'repo', 1, 1000, 'running', '/x')`);
    db.close();
    const migrated = new Store(old);
    expect(migrated.run("r1")?.loop ?? null).toBeNull();
    migrated.setRunLoop("r1", loop());
    expect(migrated.run("r1")?.loop).toEqual(loop());
    migrated.close();
    new Store(old).close();
  });

  it("round-trips a run's loop and keeps it through upsertRun", () => {
    store.upsertRun(run());
    expect(store.run("r1")?.loop ?? null).toBeNull();
    store.setRunLoop("r1", loop());
    expect(store.run("r1")?.loop).toEqual(loop());
    store.upsertRun(run({ summary: "later", branch: "fix/1-x" }));
    expect(store.run("r1")?.loop).toEqual(loop());
    expect(store.run("r1")?.summary).toBe("later");
    store.setRunLoop("r1", null);
    expect(store.run("r1")?.loop ?? null).toBeNull();
  });

  it("setRunEnded records the end, the status and who ended it; upsertRun keeps endedBy", () => {
    store.upsertRun(run());
    expect(store.run("r1")?.endedBy ?? null).toBeNull();
    store.setRunEnded("r1", 9000, "failed", "engine");
    expect(store.run("r1")).toMatchObject({ endedAt: 9000, status: "failed", endedBy: "engine" });
    store.upsertRun(run({ endedAt: 9000, status: "failed" }));
    expect(store.run("r1")?.endedBy).toBe("engine");
  });
});

describe("evidence", () => {
  it("is append-only: ids rise, the latest and the count follow", () => {
    expect(store.latestEvidence("r1")).toBeNull();
    expect(store.evidenceCount("r1")).toBe(0);
    const a = store.addEvidence("r1", "first", 10);
    const b = store.addEvidence("r1", "second", 20);
    store.addEvidence("r2", "other run", 30);
    expect(b).toBeGreaterThan(a);
    expect(store.latestEvidence("r1")).toEqual({ id: b, runId: "r1", note: "second", at: 20 });
    expect(store.evidenceCount("r1")).toBe(2);
  });
});

describe("seat lines", () => {
  const line = (over: Partial<SeatLine> = {}): SeatLine => ({
    runId: "r1",
    seatId: "guido-1",
    origin: "engine",
    text: "push it",
    at: 100,
    ...over,
  });

  it("claimLine inserts once: true, then false for the same key", () => {
    expect(store.claimLine("k1", line())).toBe(true);
    expect(store.claimLine("k1", line({ text: "changed", at: 200 }))).toBe(false);
    expect(store.claimedKeys("r1")).toEqual({ k1: 100 });
  });

  it("dropLine frees the key to be claimed again", () => {
    store.claimLine("k1", line());
    store.dropLine("k1");
    expect(store.claimedKeys("r1")).toEqual({});
    expect(store.claimLine("k1", line({ at: 300 }))).toBe(true);
  });

  it("claimedKeys is per run", () => {
    store.claimLine("k1", line());
    store.claimLine("k2", line({ runId: "r2", at: 5 }));
    expect(store.claimedKeys("r1")).toEqual({ k1: 100 });
    expect(store.claimedKeys("r2")).toEqual({ k2: 5 });
  });

  it("lastEngineLineAt is the newest engine line of the run, not an operator's", () => {
    expect(store.lastEngineLineAt("r1")).toBeNull();
    store.claimLine("k1", line({ at: 100 }));
    store.claimLine("k2", line({ at: 300 }));
    store.claimLine("k3", line({ at: 200 }));
    store.claimLine("k4", line({ origin: "operator", at: 900 }));
    store.claimLine("k5", line({ runId: "r2", at: 950 }));
    expect(store.lastEngineLineAt("r1")).toBe(300);
  });
});

describe("loop events", () => {
  it("a repeated key is recorded once", () => {
    expect(store.addLoopEvent("r1:0:1:pushed abc1234", "r1", "pushed abc1234", 10)).toBe(true);
    expect(store.addLoopEvent("r1:0:1:pushed abc1234", "r1", "pushed abc1234", 99)).toBe(false);
    store.addLoopEvent("r1:0:2:ci failed", "r1", "ci failed", 20);
    expect(store.loopEvents(0)).toEqual([
      { key: "r1:0:1:pushed abc1234", runId: "r1", text: "pushed abc1234", at: 10 },
      { key: "r1:0:2:ci failed", runId: "r1", text: "ci failed", at: 20 },
    ]);
    expect(store.loopEvents(15).map((e) => e.text)).toEqual(["ci failed"]);
  });
});

describe("queues", () => {
  const rows = (seatId: string) =>
    store.queue(seatId).map((q) => [q.repoId, q.issue, q.takenAt] as const);

  it("replaceQueue stores the items in order and replaces what was untaken", () => {
    store.replaceQueue("s1", [
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 1 },
    ]);
    expect(rows("s1")).toEqual([
      ["r", 3, null],
      ["r", 1, null],
    ]);
    store.replaceQueue("s1", [{ repoId: "r", issue: 7 }]);
    expect(rows("s1")).toEqual([["r", 7, null]]);
  });

  it("replaceQueue keeps a taken row, once, and queues the rest after it", () => {
    store.replaceQueue("s1", [
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 1 },
    ]);
    expect(store.takeQueued("s1", 50)).toMatchObject({ issue: 3, takenAt: 50 });
    store.replaceQueue("s1", [
      { repoId: "r", issue: 1 },
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 9 },
    ]);
    expect(rows("s1")).toEqual([
      ["r", 3, 50],
      ["r", 1, null],
      ["r", 9, null],
    ]);
  });

  it("replaceQueue skips an issue queued for another seat", () => {
    store.replaceQueue("s1", [{ repoId: "r", issue: 3 }]);
    store.replaceQueue("s2", [
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 4 },
      { repoId: "other", issue: 3 },
    ]);
    expect(rows("s2")).toEqual([
      ["r", 4, null],
      ["other", 3, null],
    ]);
    expect(rows("s1")).toEqual([["r", 3, null]]);
  });

  it("takeQueued hands out the head, then nothing while one is taken", () => {
    expect(store.takeQueued("s1", 1)).toBeNull();
    store.replaceQueue("s1", [
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 1 },
    ]);
    expect(store.takeQueued("s1", 10)).toMatchObject({ repoId: "r", issue: 3, takenAt: 10 });
    expect(store.takeQueued("s1", 11)).toBeNull();
  });

  // `DatabaseSync` is synchronous, so two plain calls never interleave. The seam runs a competing
  // take on a second store over the same file after the head is read and before it is stamped,
  // the only point at which the write lock matters. A short busy timeout stands in for "blocked".
  it("a competing take between the read and the stamp is refused, so only one is granted", () => {
    const other = new Store(dbPath(), 50);
    store.replaceQueue("s1", [
      { repoId: "r", issue: 3 },
      { repoId: "r", issue: 1 },
    ]);
    const grants: (QueueRow | null)[] = [];
    grants.push(
      store.takeQueued("s1", 10, () => {
        try {
          grants.push(other.takeQueued("s1", 11));
        } catch {
          grants.push(null); // the lock is held: the competitor could not take
        }
      }),
    );
    expect(grants.filter((g) => g !== null)).toHaveLength(1);
    expect(rows("s1")).toEqual([
      ["r", 3, 10],
      ["r", 1, null],
    ]);
    other.close();
  });

  it("untake returns the row to the queue; dropQueued removes it", () => {
    store.replaceQueue("s1", [{ repoId: "r", issue: 3 }]);
    store.takeQueued("s1", 10);
    store.untake("s1", "r", 3);
    expect(rows("s1")).toEqual([["r", 3, null]]);
    store.dropQueued("s1", "r", 3);
    expect(rows("s1")).toEqual([]);
  });

  it("untake and dropQueued touch only the named repo's issue", () => {
    store.replaceQueue("s1", [
      { repoId: "a", issue: 3 },
      { repoId: "b", issue: 3 },
    ]);
    store.takeQueued("s1", 10); // a#3
    store.untake("s1", "b", 3); // b#3 was not taken: a#3 stays taken
    expect(rows("s1")).toEqual([
      ["a", 3, 10],
      ["b", 3, null],
    ]);
    store.untake("s1", "a", 3);
    expect(rows("s1")).toEqual([
      ["a", 3, null],
      ["b", 3, null],
    ]);
    store.dropQueued("s1", "b", 3);
    expect(rows("s1")).toEqual([["a", 3, null]]);
  });

  it("staleTakes lists takes older than the cutoff, across seats", () => {
    store.replaceQueue("s1", [{ repoId: "r", issue: 3 }]);
    store.replaceQueue("s2", [{ repoId: "r", issue: 4 }]);
    store.replaceQueue("s3", [{ repoId: "r", issue: 5 }]);
    store.takeQueued("s1", 10);
    store.takeQueued("s2", 100);
    expect(store.staleTakes(50).map((q) => [q.seatId, q.issue])).toEqual([["s1", 3]]);
    expect(store.staleTakes(10)).toEqual([]);
  });
});

describe("attention notes", () => {
  const note = (over: Partial<NoteInput> = {}): NoteInput => ({
    key: "blocked:r1:0",
    kind: "blocked",
    runId: "r1",
    seatId: "guido-1",
    repoId: "repo",
    text: "stuck",
    at: 10,
    ...over,
  });

  it("raiseNote opens a note; raising it again leaves it as it was", () => {
    store.raiseNote(note());
    store.raiseNote(note({ text: "still stuck", at: 20 }));
    expect(store.notes()).toEqual([{ ...note(), clearedAt: null, dismissedAt: null }]);
  });

  it("clearNote closes it; raiseNote then re-opens it with the new text", () => {
    store.raiseNote(note());
    store.clearNote("blocked:r1:0", 15);
    expect(store.notes()).toEqual([]);
    expect(store.openNoteKeys("r1")).toEqual([]);
    store.raiseNote(note({ text: "stuck again", at: 30 }));
    expect(store.notes()).toEqual([
      { ...note({ text: "stuck again", at: 30 }), clearedAt: null, dismissedAt: null },
    ]);
  });

  it("dismissNote marks an open blocked note, which stays dismissed until it is re-raised after a clear", () => {
    store.raiseNote(note());
    expect(store.dismissNote("blocked:r1:0", 50)).toBe(true);
    expect(store.notes()).toEqual([{ ...note(), clearedAt: null, dismissedAt: 50 }]);
    expect(store.openNoteKeys("r1")).toEqual(["blocked:r1:0"]);
    store.raiseNote(note({ text: "x", at: 60 }));
    expect(store.notes()).toEqual([{ ...note(), clearedAt: null, dismissedAt: 50 }]);
    store.clearNote("blocked:r1:0", 70);
    store.raiseNote(note({ text: "parked again", at: 80 }));
    expect(store.notes()).toEqual([
      { ...note({ text: "parked again", at: 80 }), clearedAt: null, dismissedAt: null },
    ]);
  });

  it("dismissNote refuses a note that is not an open blocked note", () => {
    store.raiseNote(note({ key: "review:r1:abc", kind: "review" }));
    expect(store.dismissNote("review:r1:abc", 5)).toBe(false);
    expect(store.dismissNote("nope", 5)).toBe(false);
    store.raiseNote(note());
    store.clearNote("blocked:r1:0", 6);
    expect(store.dismissNote("blocked:r1:0", 7)).toBe(false);
  });

  it("clearNotesFor closes every open note of the run and no other", () => {
    store.raiseNote(note());
    store.raiseNote(note({ key: "review:r1:abc", kind: "review" }));
    store.raiseNote(note({ key: "flag:r1:hard-rules", kind: "flag" }));
    store.raiseNote(note({ key: "blocked:r2:0", runId: "r2" }));
    store.raiseNote(
      note({ key: "question:two-areas:repo#4", kind: "question", runId: null, seatId: null }),
    );
    expect(store.openNoteKeys("r1").sort()).toEqual([
      "blocked:r1:0",
      "flag:r1:hard-rules",
      "review:r1:abc",
    ]);
    store.clearNotesFor("r1", 40);
    expect(store.openNoteKeys("r1")).toEqual([]);
    expect(store.notes().map((n) => n.key)).toEqual(["blocked:r2:0", "question:two-areas:repo#4"]);
  });
});

describe("board item ids", () => {
  const item = (over: Partial<BoardItem> = {}): BoardItem => ({
    repoId: "r1",
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
    blockedBy: [],
    milestone: null,
    size: null,
    closed: false,
    prioritySource: null,
    createdAt: 77,
    itemId: "PVTI_1",
    projectId: "PVT_1",
    ...over,
  });

  it("stores created_at, item id and project id, and a change in any is a change", () => {
    store.replaceBoard("r1", [item()]);
    expect(store.board("r1")).toEqual([item()]);
    expect(store.replaceBoard("r1", [item({ itemId: "PVTI_2" })])).toBe(true);
    expect(store.replaceBoard("r1", [item({ itemId: "PVTI_2", projectId: "PVT_2" })])).toBe(true);
    expect(
      store.replaceBoard("r1", [item({ itemId: "PVTI_2", projectId: "PVT_2", createdAt: 1 })]),
    ).toBe(true);
  });

  it("adds the columns to a board_items table from before them", () => {
    const old = join(dir, "old-board.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE board_items (
      repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
      url TEXT NOT NULL, PRIMARY KEY (repo_id, issue_number))`);
    db.exec("INSERT INTO board_items VALUES ('r', 1, 't', 'Todo', 'planned', '[]', NULL, 5, 'u')");
    db.close();
    const migrated = new Store(old);
    expect(migrated.board("r")[0]).toMatchObject({ createdAt: 0, itemId: null, projectId: null });
    migrated.close();
  });
});

describe("opening a database made by the previous schema", () => {
  it("keeps its rows, leaves the new columns null, and opens again", () => {
    const old = join(dir, "previous.sqlite");
    const db = new DatabaseSync(old);
    // main's tables as store.ts created and migrated them before the loop records
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repo_id TEXT NOT NULL, seq INTEGER NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, session_id TEXT,
      model TEXT, branch TEXT, ticket TEXT, cost_usd REAL, tokens TEXT, transcript_path TEXT NOT NULL,
      prs TEXT NOT NULL DEFAULT '[]', summary TEXT, folded INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE pull_requests (
      repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
      review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_at INTEGER,
      read_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (repo_id, number))`);
    db.exec(`CREATE TABLE board_items (
      repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
      url TEXT NOT NULL, stage TEXT, owner TEXT, parent INTEGER, sub_done INTEGER, sub_total INTEGER,
      blocked_by TEXT NOT NULL DEFAULT '[]', milestone TEXT, size TEXT,
      closed INTEGER NOT NULL DEFAULT 0, priority_source TEXT, PRIMARY KEY (repo_id, issue_number))`);
    db.exec(`INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, transcript_path, summary)
      VALUES ('r1', 'a1', 'repo', 1, 1000, 'running', '/x', 'kept')`);
    db.exec(`INSERT INTO pull_requests VALUES
      ('repo', 7, 'pr', 'u', 'fix/1-x', NULL, 'open', 0, 'approved', 'passing', 1, 2, NULL, 55)`);
    db.exec(`INSERT INTO board_items (repo_id, issue_number, title, status, state, labels, updated_at, url)
      VALUES ('repo', 1, 't', 'Todo', 'planned', '[]', 5, 'u')`);
    db.close();

    for (let opens = 0; opens < 2; opens++) {
      const s = new Store(old);
      expect(s.run("r1")).toMatchObject({ id: "r1", summary: "kept", status: "running" });
      expect(s.run("r1")?.loop ?? null).toBeNull();
      expect(s.run("r1")?.endedBy ?? null).toBeNull();
      expect(s.pullRequests("repo")).toEqual([
        expect.objectContaining({
          number: 7,
          review: "approved",
          ci: "passing",
          headSha: null,
          mergeable: null,
        }),
      ]);
      expect(s.board("repo")[0]).toMatchObject({ itemId: null, projectId: null });
      expect(s.evidenceCount("r1")).toBe(0);
      expect(s.notes()).toEqual([]);
      s.close();
    }
  });
});

describe("pull request head sha and mergeable", () => {
  const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
    repoId: "r1",
    number: 1,
    title: "t",
    url: "u",
    branch: "fix/1-x",
    ticket: null,
    state: "open",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: 1,
    updatedAt: 2,
    mergedAt: null,
    headSha: "a".repeat(40),
    mergeable: "CONFLICTING",
    ...over,
  });

  it("round-trips both and counts a change in either", () => {
    expect(store.upsertPullRequests("r1", [pr()], 0)).toBe(true);
    expect(store.pullRequests("r1")).toEqual([pr()]);
    expect(store.upsertPullRequests("r1", [pr()], 0)).toBe(false);
    expect(store.upsertPullRequests("r1", [pr({ headSha: "b".repeat(40) })], 0)).toBe(true);
    const moved = pr({ headSha: "b".repeat(40), mergeable: "MERGEABLE" });
    expect(store.upsertPullRequests("r1", [moved], 0)).toBe(true);
    store.upsertPullRequests("r1", [pr({ headSha: null, mergeable: null })], 0);
    expect(store.pullRequests("r1")[0]).toMatchObject({ headSha: null, mergeable: null });
  });

  it("adds the columns to a pull_requests table from before them", () => {
    const old = join(dir, "old-prs.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE pull_requests (
      repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
      review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_at INTEGER,
      PRIMARY KEY (repo_id, number))`);
    db.exec(
      "INSERT INTO pull_requests VALUES ('r1', 1, 't', 'u', 'b', NULL, 'open', 0, NULL, NULL, 1, 2, NULL)",
    );
    db.close();
    const migrated = new Store(old);
    expect(migrated.pullRequests("r1")[0]).toMatchObject({ headSha: null, mergeable: null });
    migrated.close();
  });
});
