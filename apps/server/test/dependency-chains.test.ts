import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type BoardItem,
  NEW_LOOP,
  OPERATOR_HEADER,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { readDependencyChains } from "../src/dependency-chains.ts";
import { setExternalMergeHold } from "../src/external-pr-control.ts";
import { Store } from "../src/store.ts";

const T = Date.parse("2026-11-01T12:00:00Z");
const M = 60_000;
let store: Store;
let dir: string;
let db: DatabaseSync;
const pr = (number = 7, patch: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}`,
  ticket: `mc#${number}`,
  state: "open",
  isDraft: true,
  review: null,
  ci: null,
  createdAt: T,
  updatedAt: T,
  mergedAt: null,
  headSha: "head",
  mergeable: null,
  ...patch,
});
const run = (id = "author", patch: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido",
  repoId: "mc",
  seq: 1,
  startedAt: T,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: "feature/7",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/unused",
  prs: [],
  summary: null,
  ...patch,
});
const card = (issueNumber: number, patch: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber,
  title: `Ticket ${issueNumber}`,
  status: "Ready",
  state: "planned",
  labels: [],
  priority: null,
  updatedAt: T,
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
  createdAt: T,
  itemId: `I${issueNumber}`,
  projectId: "P",
  ...patch,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dependency-chain-"));
  const path = join(dir, "mc.sqlite");
  store = new Store(path);
  db = new DatabaseSync(path);
});
afterEach(() => {
  db.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const read = () => readDependencyChains(store, "mc", T + 20 * M);
const snapshot = () =>
  JSON.stringify(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => [
        r.name,
        db.prepare(`SELECT * FROM "${String(r.name).replaceAll('"', '""')}"`).all(),
      ]),
  );

describe("dependency chain stored read", () => {
  it("uses closing issues over a stale branch ticket and preserves self-dependency cycles", () => {
    store.replaceBoard("mc", [card(1), card(2, { after: { issues: [], prs: [7] } })]);
    store.upsertPullRequests("mc", [pr(7, { ticket: "mc#999", closingIssues: [1] })], T);
    expect(read()[0]?.root.ref).toBe("mc#1");
    store.replaceBoard("mc", [card(1, { after: { issues: [], prs: [7] } })]);
    expect(read()[0]).toMatchObject({
      state: "stuck",
      reason: "These tickets wait on each other: mc#1.",
    });
  });
  it("marks a root past its actual seven-day stage p90 stuck", () => {
    store.upsertRun(
      run("history", { startedAt: T - 60 * M, branch: "feature/70", ticket: "mc#70" }),
    );
    store.setRunLoop("history", { ...NEW_LOOP, prNumber: 70, phase: "ci" }, T - 60 * M);
    store.setRunLoop("history", { ...NEW_LOOP, prNumber: 70, phase: "done" }, T - 59 * M);
    store.upsertRun(
      run("history", {
        startedAt: T - 60 * M,
        endedAt: T - 58 * M,
        branch: "feature/70",
        ticket: "mc#70",
      }),
    );
    store.upsertPullRequests(
      "mc",
      [pr(70, { ticket: "mc#70", createdAt: T - 60 * M, state: "merged", mergedAt: T - 58 * M })],
      T,
    );
    store.upsertPullRequests("mc", [pr(7, { ticket: "mc#1" })], T);
    store.upsertRun(run("author", { ticket: "mc#1" }));
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, phase: "ci" }, T);
    store.replaceBoard("mc", [card(1), card(2, { after: { issues: [1], prs: [] } })]);
    expect(read()[0]).toMatchObject({ state: "stuck", reason: "Past CI stage p90", owner: "CI" });
  });

  it("continues through a PR into its carried ticket's remaining waits", () => {
    store.replaceBoard("mc", [
      card(1),
      card(2, { after: { issues: [1], prs: [] } }),
      card(3, { after: { issues: [], prs: [22] } }),
    ]);
    store.upsertPullRequests("mc", [pr(22, { ticket: "mc#2", closingIssues: [2] })], T);
    const chains = read();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.root.ref).toBe("mc#1");
    expect(chains[0]?.root.children[0]?.ref).toBe("mc#2");
    expect(chains[0]?.root.children[0]?.children[0]?.ref).toBe("mc#3");
    expect(chains[0]?.frees).toEqual(["mc#2"]);
    expect(chains[0]?.stillWaiting).toEqual(["mc#3"]);
  });
  it("uses both outstanding waits and only their observed start times", () => {
    store.replaceBoard("mc", [card(1), card(2), card(3, { after: { issues: [1, 2], prs: [] } })]);
    store.setSetting(
      "dependency-waits:mc",
      JSON.stringify({ waiting: { "mc#3": { open: ["mc#1"], since: T } }, released: [] }),
    );
    const chains = read();
    expect(chains.map((c) => c.root.ref)).toEqual(["mc#1", "mc#2"]);
    expect(chains[0]?.root.children[0]).toMatchObject({ waitedMs: 20 * M, alsoWaitsOn: ["mc#2"] });
    expect(chains[1]?.root.children[0]?.waitedMs).toBeNull();
    expect(chains.every((c) => c.frees.length === 0)).toBe(true);
  });
  it("includes holds and ignores a merged hold until the engine reconciles it", () => {
    store.replaceBoard("mc", [card(2)]);
    store.addHold({ ref: "mc#2", waitsOn: 7, basis: "Build after this", at: T });
    store.upsertPullRequests("mc", [pr(7, { ticket: null })], T);
    expect(read()[0]?.root.children[0]).toMatchObject({
      ref: "mc#2",
      edge: "held",
      waitedMs: 20 * M,
    });
    store.upsertPullRequests(
      "mc",
      [pr(7, { ticket: null, state: "merged", mergedAt: T + M })],
      T + M,
    );
    expect(read()).toEqual([]);
  });
  it("keeps unread PRs and untracked references unknown", () => {
    store.replaceBoard("mc", [
      card(2, {
        after: { issues: [], prs: [99] },
        blockedBy: [{ ref: "elsewhere#8", closed: false }],
      }),
    ]);
    const chains = read();
    expect(chains).toHaveLength(2);
    expect(chains.every((c) => c.state === "unknown" && c.longestWaitMs === null)).toBe(true);
    expect(chains.find((c) => c.root.ref === "PR 99")?.reason).toBe("PR 99 not read yet");
  });
  it("finds a stacked card-less PR and a real seat queue with a recorded observation", () => {
    store.upsertPullRequests(
      "mc",
      [
        pr(7, { ticket: null }),
        pr(8, { ticket: null, base: "feature/7" }),
        pr(9, { ticket: null }),
      ],
      T,
    );
    store.upsertRun(
      run("ahead", { ticket: null, branch: "feature/7", loop: { ...NEW_LOOP, prNumber: 7 } }),
    );
    store.upsertRun(
      run("queued", { ticket: null, branch: "feature/9", loop: { ...NEW_LOOP, prNumber: 9 } }),
    );
    store.setRunLoop(
      "queued",
      { ...NEW_LOOP, prNumber: 9, aside: { worktree: "/unused", wake: false } },
      T + 5 * M,
    );
    const chains = read();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.root.ref).toBe("PR 7");
    expect(chains[0]?.root.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "PR 8", edge: "stacked", waitedMs: null }),
        expect.objectContaining({ ref: "PR 9", edge: "queue", waitedMs: 15 * M }),
      ]),
    );
    expect(chains[0]?.longestWaitMs).toBe(15 * M);
  });
  it("does not invent a queue start from a run's earlier start time", () => {
    store.upsertRun(run("ahead", { ticket: "mc#1" }));
    store.upsertRun(
      run("queued", {
        ticket: "mc#2",
        loop: { ...NEW_LOOP, aside: { worktree: "/unused", wake: false } },
      }),
    );
    expect(read()[0]?.root.children[0]).toMatchObject({
      ref: "mc#2",
      edge: "queue",
      waitedMs: null,
    });
  });
  it("keeps operator holds visible even when there is no live author run", () => {
    store.replaceBoard("mc", [card(2, { after: { issues: [], prs: [7] } })]);
    store.upsertPullRequests("mc", [pr(7, { ticket: null })], T);
    setExternalMergeHold(store, "mc", 7, "CAPCOM: wait for real seat proof");
    expect(read()[0]).toMatchObject({
      state: "with-you",
      owner: "operator",
      reason: "CAPCOM: wait for real seat proof",
    });
  });
  it("distinguishes a running ticket, an unowned ticket, and a closed-unmerged PR", () => {
    store.replaceBoard("mc", [card(1), card(2, { after: { issues: [1], prs: [] } })]);
    expect(read()[0]?.state).toBe("stuck");
    store.upsertRun(run("worker", { ticket: "mc#1", branch: null }));
    expect(read()[0]).toMatchObject({ state: "moving", owner: "guido", seatId: "guido" });
    store.upsertPullRequests("mc", [pr(7, { ticket: "mc#1", state: "closed" })], T);
    expect(read()[0]).toMatchObject({ state: "stuck", reason: "Closed without merging" });
  });
  it("reports cycles through PR references and writes no database table on repeated reads", () => {
    store.replaceBoard("mc", [
      card(1, { after: { issues: [2], prs: [] } }),
      card(2, { after: { issues: [], prs: [7] } }),
    ]);
    store.upsertPullRequests("mc", [pr(7, { ticket: "mc#1" })], T);
    const before = snapshot();
    const first = read();
    expect(first[0]).toMatchObject({
      state: "stuck",
      reason: "These tickets wait on each other: mc#1, mc#2.",
    });
    expect(read()).toEqual(first);
    expect(snapshot()).toBe(before);
    expect(store.getSetting("dependency-waits:mc")).toBeNull();
  });
});

it("serves complete scoped chains without writing any database table", async () => {
  store.replaceBoard("mc", [card(1), card(2, { after: { issues: [1], prs: [] } })]);
  store.replaceBoard("other", [
    { ...card(3), repoId: "other" },
    { ...card(4, { after: { issues: [3], prs: [] } }), repoId: "other" },
  ]);
  const config = {
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [],
    loops: [],
    repos: ["mc", "other"].map((id) => ({
      id,
      github: `owner/${id}`,
      project: 1,
      statusMap: {},
      autonomy: "merge",
    })),
    poll: { usageMinutes: 30, githubSeconds: 60 },
  } as unknown as CcConfig;
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    operatorToken: "test-token",
    now: () => T + 20 * M,
  });
  await app.ready();
  try {
    const before = snapshot();
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: { [OPERATOR_HEADER]: "test-token" } });
    const first = await get("/api/dependencies?repoId=mc");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual([
      expect.objectContaining({
        repoId: "mc",
        root: expect.objectContaining({ ref: "mc#1" }),
        frees: ["mc#2"],
      }),
    ]);
    expect((await get("/api/dependencies?repoId=mc")).json()).toEqual(first.json());
    const all = (await get("/api/dependencies")).json();
    expect(all.map((c: { repoId: string }) => c.repoId)).toEqual(["mc", "other"]);
    expect(snapshot()).toBe(before);
  } finally {
    await app.close();
  }
});
