import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWAY_SETTING, NEW_LOOP, type Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSED_AWAY } from "../src/away.ts";
import type { CcConfig } from "../src/config.ts";
import { accountStopReasonText, releaseAtAccountStop } from "../src/engine/account-release.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;
const REPO = "mc";
const REF = `${REPO}#7`;

let dir: string;
let store: Store;
let ended: string[];

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

let facts: () => { inTurn: boolean; rateLimitedUntil: number | null } | null = () => null;

const release = () =>
  releaseAtAccountStop({
    config,
    store,
    enabled: true,
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
    },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-release-"));
  store = new Store(join(dir, "mc.sqlite"));
  ended = [];
  facts = () => null;
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
  it("stops the run with the reason on its timeline and frees the seat", async () => {
    await release();
    expect(ended).toEqual(["guido-1:1"]);
    expect(store.seatSession("guido-1")?.runId).toBeNull();
    expect(store.loopEventsOfRun("guido-1:1").map((e) => e.text)).toContain(
      accountStopReasonText("GUIDO-1", "acct-a"),
    );
  });

  it("stops a run on a seat the CLI parked on a rate limit", async () => {
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
  });

  it("keeps the run on its seat while away mode refuses pick-ups", async () => {
    store.setSetting(AWAY_SETTING, JSON.stringify(CLOSED_AWAY));
    await release();
    expect(ended).toEqual([]);
  });

  it("judges a transferred run by the account it was moved to", async () => {
    store.setSetting(
      "account-transfer:guido-1:1",
      JSON.stringify({ source: "acct-a", target: "acct-b", pending: false }),
    );
    await release();
    expect(ended).toEqual([]);
  });

  it("stops a run transferred onto an account at its stop", async () => {
    store.addUsage({
      accountId: "acct-a",
      window: "7d",
      at: NOW + 1,
      pct: 10,
      resetAt: NOW + DAY,
      source: "test",
    });
    stop("acct-b");
    store.setSetting(
      "account-transfer:guido-1:1",
      JSON.stringify({ source: "acct-a", target: "acct-b", pending: false }),
    );
    await release();
    expect(ended).toEqual(["guido-1:1"]);
  });

  it("leaves a seat's run alone while its turn is under way", async () => {
    await releaseAtAccountStop({
      config,
      store,
      enabled: true,
      now: () => NOW,
      supervisor: {
        seat: (id) => store.seatSession(id),
        seatFacts: () => ({ inTurn: true }) as never,
        endRunByEngine: async () => void ended.push("x"),
      },
    });
    expect(ended).toEqual([]);
  });
});
