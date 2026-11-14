import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardItem, Run, WasteCounts } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { prepareRetrospective } from "../src/flight/retrospective.ts";
import { wasteCounts, wasteReport } from "../src/spend/waste.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-12T03:00:00Z");
const HOUR = 3_600_000;
const SINCE = NOW - 24 * HOUR;

let dir: string;
let store: Store;

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: 4,
    sessions: [
      {
        id: "s",
        repoId: "mc",
        checkout: "/c",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "claude-main", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", area: [] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

let n = 0;
const run = (ticket: string | null, over: Partial<Run> = {}): Run => {
  n += 1;
  return {
    id: `r${n}`,
    agentId: "guido-1",
    repoId: "mc",
    seq: n,
    startedAt: NOW - 2 * HOUR,
    endedAt: NOW - HOUR,
    status: "ok",
    sessionId: "cli",
    model: "m",
    branch: null,
    ticket,
    costUsd: null,
    tokens: null,
    transcriptPath: "/x",
    prs: [],
    summary: null,
    ...over,
  };
};

const card = (number: number, createdAt: number): BoardItem => ({
  repoId: "mc",
  issueNumber: number,
  itemId: `I${number}`,
  title: `Ticket ${number}`,
  status: "Ready",
  state: "planned",
  labels: [],
  assignees: [],
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
  createdAt,
  projectId: "P",
});
beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "mc-counts-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the retrospective's waste counts", () => {
  it("counts tickets opened and closed, runs per ticket, review rounds and idle seat-hours", () => {
    store.replaceBoard("mc", [
      card(1, NOW - HOUR),
      card(2, NOW - 2 * HOUR),
      card(3, NOW - 5 * 24 * HOUR),
    ]);
    store.replaceFlow(
      "mc",
      [{ repoId: "mc", number: 3, size: "S", startAt: SINCE - HOUR, doneAt: NOW - HOUR }],
      [],
    );
    store.upsertRun(run("mc#1"));
    store.upsertRun(run("mc#1"));
    store.upsertRun(run("mc#1"));
    store.upsertRun(run("mc#2"));
    store.upsertRun(run("mc#9", { startedAt: SINCE - HOUR })); // before the window
    const author = run("mc#1", { startedAt: NOW - 3 * HOUR });
    store.upsertRun(author);
    for (const [round, blocking] of [
      [1, 2],
      [2, 0],
    ] as const) {
      const id = store.requestReview({
        authorRunId: author.id,
        repoId: "mc",
        seatId: "retro-1",
        prNumber: 1,
        sha: `s${round}`,
        epoch: 1,
        attempt: 1,
        round,
        at: NOW - 3 * HOUR,
      });
      const db = (
        store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }
      ).db;
      db.prepare(
        "UPDATE reviews SET state = 'reported', blocking = ?, ended_at = ? WHERE id = ?",
      ).run(blocking, NOW - 2 * HOUR, id);
    }
    // guido-1 was idle before the window's first event, worked from 10h ago, idled 6h to 2h ago
    store.addAgentEvent({
      agentId: "guido-1",
      at: NOW - 10 * HOUR,
      from: "idle",
      to: "running",
      text: "",
    });
    store.addAgentEvent({
      agentId: "guido-1",
      at: NOW - 6 * HOUR,
      from: "running",
      to: "idle",
      text: "",
    });
    store.addAgentEvent({
      agentId: "guido-1",
      at: NOW - 2 * HOUR,
      from: "idle",
      to: "running",
      text: "",
    });

    const c = wasteCounts(config, store, "mc", "2026-11-12", SINCE, NOW);
    expect(c.ticketsOpened).toBe(2);
    expect(c.ticketsClosed).toBe(1);
    expect(c.ticketsWithRuns).toBe(2);
    expect(c.runsPerTicket).toEqual({ mean: 2.5, max: 4, maxTicket: "mc#1" });
    expect(c.reviewRounds).toEqual({ reported: 2, failed: 1 });
    // idle from the window's start to 10h ago (14h, the state before its first event), then 6h to 2h ago (4h)
    expect(c.idleSeatHours).toBeCloseTo(18, 5);
  });

  it("counts a seat idle through the whole window with no state change", () => {
    store.addAgentEvent({
      agentId: "guido-1",
      at: SINCE - 24 * HOUR,
      from: "running",
      to: "idle",
      text: "",
    });
    expect(wasteCounts(config, store, "mc", "2026-11-12", SINCE, NOW).idleSeatHours).toBeCloseTo(
      24,
      5,
    );
  });

  it("is stored by the daily retrospective and served on the waste route", async () => {
    store.replaceBoard("mc", [card(1, NOW - HOUR)]);
    store.addAgentEvent({
      agentId: "guido-1",
      at: SINCE - 24 * HOUR,
      from: "running",
      to: "idle",
      text: "",
    });
    await prepareRetrospective(config, store, NOW);
    const stored = (store.retrospectives("mc")[0] as { counts?: WasteCounts }).counts;
    expect(stored).toMatchObject({ day: "2026-11-12", ticketsOpened: 1 });
    expect(stored?.idleSeatHours).toBeCloseTo(24, 5);
    expect(wasteReport(config, store, NOW + HOUR).counts).toEqual(stored);
  });

  it("serves the latest stored counts on the waste route, null before the first", () => {
    expect(wasteReport(config, store, NOW).counts).toBeNull();
    const counts: WasteCounts = {
      day: "2026-11-12",
      at: NOW,
      since: SINCE,
      ticketsOpened: 2,
      ticketsClosed: 1,
      ticketsWithRuns: 2,
      runsPerTicket: { mean: 2.5, max: 4, maxTicket: "mc#1" },
      reviewRounds: { reported: 2, failed: 1 },
      idleSeatHours: 4,
    };
    store.recordRetrospective("mc", "2026-11-12", NOW, { day: "2026-11-12", counts });
    expect(wasteReport(config, store, NOW + HOUR).counts).toEqual(counts);
  });
});
