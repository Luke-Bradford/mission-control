import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWAY_SETTING, type BoardItem, NEW_LOOP, type Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSED_AWAY } from "../src/away.ts";
import type { CcConfig } from "../src/config.ts";
import { ACCOUNT_STOP_FREES_WHEN, releaseAtAccountStop } from "../src/engine/account-release.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;
const REPO = "mc";
const REF = `${REPO}#7`;

let dir: string;
let store: Store;
let ended: string[];
let started: { seatId: string; issue: number }[];

const seat = (id: string, accountId: string) => ({
  id,
  role: "GUIDO",
  accountId,
  model: "haiku",
  area: ["apps/server/**"],
});

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [
    { id: "acct-a", vendor: "claude", alertAt: 80, stopAt: 95 },
    { id: "acct-b", vendor: "claude", alertAt: 80, stopAt: 95 },
  ],
  repos: [{ id: REPO, github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: 8,
    sessions: [
      {
        id: "s",
        repoId: REPO,
        checkout: "/c",
        seats: [seat("guido-1", "acct-a"), seat("guido-2", "acct-b")],
      },
    ],
  },
} as unknown as CcConfig;

const stop = (accountId: string) =>
  store.addUsage({
    accountId,
    window: "7d",
    at: NOW,
    pct: 99,
    resetAt: NOW + DAY,
    source: "test",
  });

const authorRun = (): Run => ({
  id: "guido-1:1",
  agentId: "guido-1",
  repoId: REPO,
  seq: 1,
  startedAt: NOW - 1000,
  endedAt: null,
  status: "running",
  sessionId: "s",
  model: "haiku",
  branch: "feature/7-x",
  ticket: REF,
  ticketTitle: "x",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP, phase: "working" },
});

const card: BoardItem = {
  repoId: REPO,
  issueNumber: 7,
  title: "t",
  status: "In progress",
  state: "in progress",
  labels: ["area:server"],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "S",
  closed: false,
  prioritySource: null,
  createdAt: NOW,
  itemId: "I7",
  projectId: "P1",
};

const rules = {
  pickFrom: ["Ready"],
  areas: { "area:server": ["apps/server/**"] },
} as never;

let facts: () => { inTurn: boolean; rateLimitedUntil: number | null } | null = () => null;

const release = () =>
  releaseAtAccountStop({
    config,
    store,
    enabled: true,
    rules: async () => rules,
    now: () => NOW,
    supervisor: {
      seat: (id) => store.seatSession(id),
      seatFacts: () => facts() as never,
      async endRunByEngine(runId) {
        ended.push(runId);
        const r = store.run(runId);
        if (r) store.upsertRun({ ...r, endedAt: NOW, status: "ok" });
        store.setSeatSession({
          seatId: "guido-1",
          runId: null,
          cliSessionId: "cli",
          state: "idle",
          reason: null,
          worktree: null,
          updatedAt: NOW,
        });
      },
      async startRun(seatId, issue) {
        started.push({ seatId, issue });
        store.upsertRun({ ...authorRun(), id: `${seatId}:1`, agentId: seatId });
        return { runId: `${seatId}:1`, branch: "feature/7-x" };
      },
    },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-release-"));
  store = new Store(join(dir, "mc.sqlite"));
  ended = [];
  started = [];
  facts = () => null;
  store.replaceBoard(REPO, [card]);
  store.upsertRun(authorRun());
  store.setSeatSession({
    seatId: "guido-1",
    runId: "guido-1:1",
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: "/w/x",
    updatedAt: NOW,
  });
  stop("acct-a");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("releaseAtAccountStop", () => {
  it("hands the ticket to a free seat on another account in one cycle, same ticket", async () => {
    await release();
    expect(ended).toEqual(["guido-1:1"]);
    expect(started).toEqual([{ seatId: "guido-2", issue: 7 }]);
    expect(store.ticketWait(REPO, 7)).toBeNull();
  });

  it("with no other free seat, the ticket waits with its reason and no owner, then clears", async () => {
    stop("acct-b");
    await release();
    expect(ended).toEqual(["guido-1:1"]);
    expect(started).toEqual([]);
    expect(store.ticketWait(REPO, 7)).toMatchObject({
      reason: expect.stringContaining("acct-a"),
      freesWhen: ACCOUNT_STOP_FREES_WHEN,
    });
    expect(store.activeTickets().has(REF)).toBe(false);
    // acct-b resets
    store.addUsage({
      accountId: "acct-b",
      window: "7d",
      at: NOW + 1,
      pct: 10,
      resetAt: NOW + DAY,
      source: "test",
    });
    await release();
    expect(started).toEqual([{ seatId: "guido-2", issue: 7 }]);
    expect(store.ticketWait(REPO, 7)).toBeNull();
  });

  it("releases a seat the CLI parked on a rate limit", async () => {
    store.setSeatSession({
      seatId: "guido-1",
      runId: "guido-1:1",
      cliSessionId: "cli",
      state: "parked",
      reason: "rate limited until 14:00",
      worktree: "/w/x",
      updatedAt: NOW,
    });
    facts = () => ({ inTurn: false, rateLimitedUntil: NOW + DAY });
    await release();
    expect(ended).toEqual(["guido-1:1"]);
    expect(started).toEqual([{ seatId: "guido-2", issue: 7 }]);
  });

  it("keeps the run on its seat while away mode refuses pick-ups", async () => {
    store.setSetting(AWAY_SETTING, JSON.stringify(CLOSED_AWAY));
    await release();
    expect(ended).toEqual([]);
    expect(started).toEqual([]);
    expect(store.ticketWait(REPO, 7)).toBeNull();
  });

  it("leaves a seat's run alone while its turn is under way", async () => {
    await releaseAtAccountStop({
      config,
      store,
      enabled: true,
      rules: async () => rules,
      now: () => NOW,
      supervisor: {
        seat: (id) => store.seatSession(id),
        seatFacts: () => ({ inTurn: true }) as never,
        endRunByEngine: async () => void ended.push("x"),
        startRun: async () => ({ runId: "r", branch: "b" }),
      },
    });
    expect(ended).toEqual([]);
    expect(store.ticketWait(REPO, 7)).toBeNull();
  });
});
