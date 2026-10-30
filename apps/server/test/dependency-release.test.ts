import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  DEFAULT_REPO_RULES,
  NEW_LOOP,
  type PullRequestView,
  type RepoRules,
  type Run,
  type TicketView,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { blockedWork, observeWaits, releasedLines } from "../src/dependencies.ts";
import { RELEASE_RETRY_MS, releaseDependents } from "../src/engine/dependencies.ts";
import { flightState, flightView } from "../src/flight/state.ts";
import type { Move } from "../src/github-board.ts";
import { Store } from "../src/store.ts";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const MIN = 60_000;
const REPO = "mc";
const RULES: RepoRules = { ...DEFAULT_REPO_RULES, areas: { "area:server": ["apps/server/**"] } };

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: REPO, github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/w",
    maxSeats: 4,
    sessions: [
      {
        id: "mc-crew",
        repoId: REPO,
        checkout: "/tmp/c",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "haiku", area: [] },
          {
            id: "guido-1",
            role: "GUIDO",
            accountId: "a",
            model: "haiku",
            area: ["apps/server/**"],
          },
        ],
      },
    ],
  },
} as unknown as CcConfig;

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: REPO,
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "Ready",
  state: "planned",
  labels: ["area:server"],
  assignees: [],
  priority: null,
  updatedAt: T0,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "M",
  closed: false,
  prioritySource: null,
  createdAt: T0,
  itemId: `I${n}`,
  projectId: "P",
  ...over,
});

const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: REPO,
  number,
  title: "PR",
  url: "u",
  branch: `feature/${number}`,
  ticket: null,
  state: "open",
  isDraft: false,
  review: null,
  ci: "pending",
  createdAt: T0,
  updatedAt: T0,
  mergedAt: null,
  headSha: "abc",
  mergeable: null,
  ...over,
});

let dir: string;
let store: Store;
let moves: Move[];
let synced: string[];
let syncResult: "merged" | "refused";
let body: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-dep-"));
  store = new Store(join(dir, "mc.sqlite"));
  moves = [];
  synced = [];
  syncResult = "merged";
  body = "## Done when\n- x\n";
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (id: string, ticket: string, prNumber: number): Run => ({
  id,
  agentId: "guido-1",
  repoId: REPO,
  seq: 1,
  startedAt: T0,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP, phase: "ci", prNumber },
});

const release = (now: number) =>
  releaseDependents({
    store,
    config,
    now: () => now,
    move: async (m) => {
      moves.push(m);
      return { ok: true, changed: true };
    },
    syncMain: async (id) => {
      synced.push(id);
      return { kind: syncResult };
    },
    rules: async () => RULES,
    fetchTicket: async (_repo, n) => ({ number: n, body }) as TicketView,
    prsFor: (repoId) => store.pullRequests(repoId),
    log: () => {},
  });

/** 1139 waits on 1015, whose PR 1033 is open; 1139's own PR 1040 is in CI under run r-1139. */
function seed(): void {
  store.replaceBoard(REPO, [
    card(1015, { status: "In review", state: "review" }),
    card(1139, { status: "Blocked", state: "blocked", after: { issues: [1015], prs: [] } }),
  ]);
  store.upsertPullRequests(
    REPO,
    [
      pr(1033, { ticket: "mc#1015", closingIssues: [1015] }),
      pr(1040, { ticket: "mc#1139", closingIssues: [1139] }),
    ],
    T0,
  );
  const r = run("r-1139", "mc#1139", 1040);
  store.upsertRun(r);
  store.setRunLoop(r.id, r.loop ?? null);
}

/** 1015's PR merges and its issue closes. */
function merge1015(at: number): void {
  store.replaceBoard(REPO, [
    card(1015, { status: "Done", state: "done", closed: true }),
    card(1139, { status: "Blocked", state: "blocked", after: { issues: [1015], prs: [] } }),
  ]);
  store.upsertPullRequests(
    REPO,
    [
      pr(1033, { ticket: "mc#1015", closingIssues: [1015], state: "merged", mergedAt: at }),
      pr(1040, { ticket: "mc#1139", closingIssues: [1139] }),
    ],
    at,
  );
}

describe("release on merge", () => {
  it("moves a Blocked dependent to Ready and tells its PR's run to merge main, once", async () => {
    seed();
    await release(T0);
    expect(moves).toEqual([]);
    expect(synced).toEqual([]);

    merge1015(T0 + 5 * MIN);
    await release(T0 + 6 * MIN);
    expect(moves).toEqual([{ runId: "dep:mc#1139", repoId: REPO, issue: 1139, column: "Ready" }]);
    expect(synced).toEqual(["r-1139"]);

    await release(T0 + 7 * MIN);
    expect(moves).toHaveLength(1);
    expect(synced).toHaveLength(1);
  });

  it("leaves an incomplete dependent in Blocked", async () => {
    seed();
    await release(T0);
    body = "no plan";
    merge1015(T0 + 5 * MIN);
    await release(T0 + 6 * MIN);
    expect(moves).toEqual([]);
    expect(synced).toEqual(["r-1139"]);
  });

  it("tries a refused merge-main again after the retry wait", async () => {
    seed();
    await release(T0);
    syncResult = "refused";
    merge1015(T0 + 5 * MIN);
    await release(T0 + 6 * MIN);
    expect(synced).toHaveLength(1);
    await release(T0 + 7 * MIN);
    expect(synced).toHaveLength(1);
    syncResult = "merged";
    await release(T0 + 6 * MIN + RELEASE_RETRY_MS);
    expect(synced).toHaveLength(2);
    await release(T0 + 6 * MIN + 2 * RELEASE_RETRY_MS);
    expect(synced).toHaveLength(2);
  });

  it("does not release a ticket that closed or left while it waited", async () => {
    seed();
    await release(T0);
    store.replaceBoard(REPO, [card(1015, { status: "In review" })]);
    await release(T0 + MIN);
    expect(moves).toEqual([]);
    expect(observeWaits(store, REPO, T0 + MIN).released).toEqual([]);
  });
});

describe("what the hub tells FLIGHT", () => {
  it("lists each blocked ticket with its chain and how long it has waited", () => {
    store.replaceBoard(REPO, [
      card(1, { status: "In progress", state: "in progress" }),
      card(2, { status: "Blocked", state: "blocked", after: { issues: [1], prs: [] } }),
      card(3, { status: "Blocked", state: "blocked", after: { issues: [2], prs: [] } }),
    ]);
    store.upsertPullRequests(REPO, [pr(7, { ticket: "mc#1", closingIssues: [1] })], T0);
    blockedWork(store, REPO, T0);
    const view = flightView(config, store, T0 + 45 * MIN);
    expect(view.blocked).toEqual([
      {
        ref: "mc#2",
        title: "Ticket 2",
        column: "Blocked",
        waitsOn: ["mc#1 (PR 7 in CI)"],
        chain: ["mc#2", "mc#1"],
        waitedMin: 45,
      },
      {
        ref: "mc#3",
        title: "Ticket 3",
        column: "Blocked",
        waitsOn: ["mc#2"],
        chain: ["mc#3", "mc#2", "mc#1"],
        waitedMin: 45,
      },
    ]);
  });

  it("puts the blocked tickets in the state FLIGHT reads, and a freed ticket in the wake", () => {
    store.replaceBoard(REPO, [
      card(1, { status: "In progress", state: "in progress" }),
      card(2, { status: "Blocked", state: "blocked", after: { issues: [1], prs: [] } }),
    ]);
    expect(flightState({ config, store, busy: [], now: T0 }).blocked?.map((b) => b.ref)).toEqual([
      "mc#2",
    ]);
    store.replaceBoard(REPO, [
      card(1, { status: "Done", state: "done", closed: true }),
      card(2, { status: "Blocked", state: "blocked", after: { issues: [1], prs: [] } }),
    ]);
    const next = flightState({ config, store, busy: [], now: T0 + MIN });
    expect(next.blocked).toEqual([]);
    expect(next.triage.map((t) => t.evidence)).toEqual(["mc#1 closed: mc#2 unblocked"]);
  });

  it("says which work merged and which tickets it unblocked", () => {
    expect(
      releasedLines(
        [
          { ref: "mc#1139", resolved: ["mc#1015"], at: T0 },
          { ref: "mc#1142", resolved: ["mc#1015"], at: T0 },
        ],
        () => "merged",
      ),
    ).toEqual([{ ref: "mc#1139", at: T0, text: "mc#1015 merged: mc#1139, mc#1142 unblocked" }]);
  });
});
