import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  type PullRequestView,
  type Run,
  type RunLoop,
  WASTE_THRESHOLDS,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limitRows } from "../src/api.ts";
import type { CcConfig } from "../src/config.ts";
import { flightSignals, markFlightSignalsShown } from "../src/flight/signals.ts";
import { createCheckRecorder } from "../src/guard/check-runs.ts";
import { attentionItems } from "../src/hud.ts";
import { weeklyProjection } from "../src/spend/projection.ts";
import {
  openWasteAlarms,
  resolveWasteAlarm,
  restartHold,
  reviewsHeld,
  syncWasteAlarms,
  ticketParked,
  wasteReport,
} from "../src/spend/waste.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [
    { id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 },
    { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
  ],
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
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", area: ["apps/server/**"] },
          { id: "guido-cx", role: "GUIDO", accountId: "codex-main", area: ["apps/web/**"] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

let n = 0;
const run = (agentId: string, over: Partial<Run> = {}): Run => {
  n += 1;
  return {
    id: `r${n}`,
    agentId,
    repoId: "mc",
    seq: n,
    startedAt: NOW - MIN,
    endedAt: NOW - MIN / 2,
    status: "ok",
    sessionId: "cli",
    model: "m",
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "/x",
    prs: [],
    summary: null,
    ...over,
  };
};

beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "mc-waste-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const mergedPr = (number: number, branch: string, mergedAt: number): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch,
  ticket: `mc#${number}`,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: mergedAt - HOUR,
  updatedAt: mergedAt,
  mergedAt,
  headSha: "h",
  mergeable: null,
});

const checkOn = (runId: string, command: string, sha: string, at: number, ok = false) =>
  store.addCheckRun({ runId, command, headSha: sha, ok, exitCode: ok ? 0 : 1, at });

describe("restart storm (7 November replay)", () => {
  it("raises an alarm within the minute tick and stops that agent's restarts", () => {
    // about 300 FLIGHT sessions in five hours: here the last hour's worth, one start a few minutes
    for (let i = 0; i < 12; i++)
      store.upsertRun(run("flight-1", { startedAt: NOW - 10 * MIN - i * 4 * MIN }));
    store.upsertRun(run("guido-1", { startedAt: NOW - 5 * MIN }));
    expect(syncWasteAlarms(config, store, NOW)).toBe(true);
    const alarms = openWasteAlarms(store);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ check: "restart-storm", subject: "flight-1", level: 12 });
    expect(alarms[0]?.evidence).toMatch(/FLIGHT-1 started 12 times in the last hour/);
    expect(restartHold(store, "flight-1")).toMatch(/restart storm|started 12 times/);
    // another agent is unaffected
    expect(restartHold(store, "guido-1")).toBeNull();
  });

  it("does not fire at the limit, and closes when the hour's count falls back", () => {
    for (let i = 0; i < WASTE_THRESHOLDS.restartStormStarts; i++)
      store.upsertRun(run("guido-1", { startedAt: NOW - i * MIN }));
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store)).toEqual([]);
    store.upsertRun(run("guido-1", { startedAt: NOW - 30 * 1000 }));
    syncWasteAlarms(config, store, NOW);
    expect(restartHold(store, "guido-1")).not.toBeNull();
    syncWasteAlarms(config, store, NOW + 2 * HOUR);
    expect(restartHold(store, "guido-1")).toBeNull();
  });
});

describe("the #1596 replay (retry loop and unchanged rerun)", () => {
  const TICKET = "mc#1596";
  const SHA = "abcdef1234567890";
  const LINT = "pnpm -s lint";

  const replay = () => {
    // nine test runs on one head, six failed; two failed attempts and three parks
    let last = "";
    // the loop's parks end the run 'ok': the park, not the status, is the failed attempt
    for (let i = 0; i < 3; i++) {
      const r = run("guido-1", {
        ticket: TICKET,
        startedAt: NOW - 16 * HOUR + i * 5 * HOUR,
        status: "ok",
      });
      store.upsertRun(r);
      store.setRunLoop(r.id, {
        phase: "parked",
        parked: { kind: "stuck", reason: "no progress", ended: true },
      } as RunLoop);
      last = r.id;
    }
    for (let i = 0; i < 9; i++) checkOn(last, LINT, SHA, NOW - 3 * HOUR + i * MIN, i < 3);
  };

  it("raises both alarms and parks the ticket", () => {
    replay();
    syncWasteAlarms(config, store, NOW);
    const by = Object.fromEntries(openWasteAlarms(store).map((a) => [a.check, a]));
    expect(by["retry-loop"]).toMatchObject({ subject: TICKET, ticket: TICKET, level: 3 });
    expect(by["unchanged-rerun"]).toMatchObject({ ticket: TICKET, level: 8 });
    expect(by["unchanged-rerun"]?.evidence).toContain(LINT);
    expect(ticketParked(store, TICKET)).toMatch(/3 failed attempts/);
    expect(ticketParked(store, "mc#1")).toBeNull();
  });

  it("stays parked until FLIGHT resolves it, and a worse level raises it again", () => {
    replay();
    syncWasteAlarms(config, store, NOW);
    const alarm = openWasteAlarms(store).find((a) => a.check === "retry-loop");
    expect(resolveWasteAlarm(store, alarm?.id ?? 0, NOW, "park it and take the next")).toBe(true);
    expect(resolveWasteAlarm(store, alarm?.id ?? 0, NOW, "again")).toBe(false);
    syncWasteAlarms(config, store, NOW + MIN);
    expect(ticketParked(store, TICKET)).toBeNull();
    store.upsertRun(run("guido-1", { ticket: TICKET, startedAt: NOW + 2 * MIN, status: "failed" }));
    syncWasteAlarms(config, store, NOW + 3 * MIN);
    expect(ticketParked(store, TICKET)).not.toBeNull();
  });

  it("counts three carry-on resumes without a report", () => {
    const r = run("guido-1", { ticket: "mc#7" });
    store.upsertRun(r);
    for (let i = 0; i < 3; i++) store.addResumeAttempt(r.id, NOW - i * MIN);
    syncWasteAlarms(config, store, NOW);
    expect(ticketParked(store, "mc#7")).toMatch(/resumed 3 times without a report/);
  });

  it("closes the alarm once the ticket is closed", () => {
    replay();
    syncWasteAlarms(config, store, NOW);
    expect(ticketParked(store, TICKET)).not.toBeNull();
    store.replaceBoard("mc", [
      {
        repoId: "mc",
        issueNumber: 1596,
        title: "t",
        status: "Done",
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
        closed: true,
        prioritySource: null,
        createdAt: NOW - DAY,
        itemId: "I",
        projectId: "P",
      },
    ]);
    syncWasteAlarms(config, store, NOW + MIN);
    expect(ticketParked(store, TICKET)).toBeNull();
  });
});

describe("unchanged rerun refusal", () => {
  it("refuses the same check on the same commit with a clean tree, and records the refusal", async () => {
    const r = run("guido-1", { ticket: "mc#9" });
    store.upsertRun(r);
    const recorder = createCheckRecorder({
      store,
      checks: async () => ["pnpm -s lint"],
      state: async () => ({ head: "feedbeef00", clean: true }),
      now: () => NOW,
    });
    expect(await recorder.rerun?.(r.id, "pnpm -s lint")).toBeNull();
    checkOn(r.id, "pnpm -s lint", "feedbeef00", NOW - MIN, true);
    expect(await recorder.rerun?.(r.id, "pnpm -s lint")).toMatch(
      /Not run: pnpm -s lint already ran on commit feedbee and nothing has changed/,
    );
    // another command, or another head, is not a rerun
    expect(await recorder.rerun?.(r.id, "pnpm -s typecheck")).toBeNull();
    const moved = createCheckRecorder({
      store,
      checks: async () => ["pnpm -s lint"],
      state: async () => ({ head: "0123456789", clean: true }),
    });
    expect(await moved.rerun?.(r.id, "pnpm -s lint")).toBeNull();
    // a changed file (dirty tree) is not a rerun either
    const dirty = createCheckRecorder({
      store,
      checks: async () => ["pnpm -s lint"],
      state: async () => ({ head: "feedbeef00", clean: false }),
    });
    expect(await dirty.rerun?.(r.id, "pnpm -s lint")).toBeNull();
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).map((a) => [a.check, a.runId, a.level])).toEqual([
      ["unchanged-rerun", r.id, 1],
    ]);
  });
});

describe("review rounds", () => {
  const request = (authorRunId: string, round: number) =>
    store.requestReview({
      authorRunId,
      repoId: "mc",
      seatId: "retro-1",
      prNumber: 4,
      sha: `sha${round}`,
      epoch: 1,
      attempt: 1,
      round,
      at: NOW - MIN,
    });

  it("stops reviews of a change past two rounds until FLIGHT resolves it", () => {
    const r = run("guido-1", { ticket: "mc#5" });
    store.upsertRun(r);
    request(r.id, 1);
    request(r.id, 2);
    expect(reviewsHeld(store, r.id)).toBe(false);
    request(r.id, 3);
    // held at once, before the next scan
    expect(reviewsHeld(store, r.id)).toBe(true);
    syncWasteAlarms(config, store, NOW);
    const alarm = openWasteAlarms(store).find((a) => a.check === "review-rounds");
    expect(alarm).toMatchObject({ subject: r.id, level: 3 });
    resolveWasteAlarm(store, alarm?.id ?? 0, NOW, "fix: one more round");
    expect(reviewsHeld(store, r.id)).toBe(false);
    request(r.id, 4);
    expect(reviewsHeld(store, r.id)).toBe(true);
  });
});

describe("review rounds on a sliced ticket", () => {
  it("alarms for the open slice when a sibling slice of the ticket has merged", () => {
    store.upsertPullRequests(
      "mc",
      [
        { ...mergedPr(10, "slice-1", NOW - DAY), ticket: "mc#5" },
        { ...mergedPr(11, "slice-2", NOW), ticket: "mc#5", state: "open", mergedAt: null },
      ],
      NOW,
    );
    const r = run("guido-1", { ticket: "mc#5", branch: "slice-2" });
    store.upsertRun(r);
    for (const round of [1, 2, 3])
      store.requestReview({
        authorRunId: r.id,
        repoId: "mc",
        seatId: "retro-1",
        prNumber: 11,
        sha: `s${round}`,
        epoch: 1,
        attempt: 1,
        round,
        at: NOW - 10 * DAY,
      });
    syncWasteAlarms(config, store, NOW);
    expect(reviewsHeld(store, r.id)).toBe(true);
    expect(openWasteAlarms(store).find((a) => a.check === "review-rounds")).toMatchObject({
      subject: r.id,
      level: 3,
    });
  });
});

describe("alarms that only alarm", () => {
  it("flags a ticket that passes three runs without a merge, with its runs and findings", () => {
    for (let i = 0; i < 4; i++)
      store.upsertRun(run("guido-1", { ticket: "mc#30", startedAt: NOW - (5 - i) * HOUR }));
    syncWasteAlarms(config, store, NOW);
    const a = openWasteAlarms(store).find((x) => x.check === "runs-per-ticket");
    expect(a?.evidence).toMatch(/mc#30 has taken 4 runs without a merge/);
    expect(a?.evidence).toMatch(/r\d+ \(0\)/);
    expect(ticketParked(store, "mc#30")).toBeNull();
  });

  it("flags cost past 3x the median of the ticket's size when nothing merged", () => {
    // three merged size-S tickets cost $2, $3 and $4 (median $3); mc#40 has cost $15 and no merge
    const merged = [11, 12, 13];
    store.replaceFlow(
      "mc",
      [...merged, 40].map((number) => ({
        repoId: "mc",
        number,
        size: "S",
        startAt: NOW - DAY,
        doneAt: null,
      })),
      [],
    );
    merged.forEach((number, i) => {
      store.upsertRun(
        run("guido-1", {
          ticket: `mc#${number}`,
          branch: `feature/${number}`,
          costUsd: 2 + i,
          startedAt: NOW - 3 * DAY,
        }),
      );
      store.upsertPullRequests("mc", [mergedPr(number, `feature/${number}`, NOW - 2 * DAY)], NOW);
    });
    store.upsertRun(run("guido-1", { ticket: "mc#40", costUsd: 6 }));
    store.upsertRun(run("guido-1", { ticket: "mc#40", costUsd: 9 }));
    syncWasteAlarms(config, store, NOW);
    const a = openWasteAlarms(store).find((x) => x.check === "cost-without-output");
    expect(a).toMatchObject({ subject: "mc#40", level: 5 });
    expect(a?.evidence).toMatch(/mc#40 \(size S\) has cost \$15\.00, over 3x the median \$3\.00/);
    expect(a?.evidence).toMatch(/r\d+ \$6\.00, r\d+ \$9\.00|r\d+ \$9\.00, r\d+ \$6\.00/);
  });

  it("flags FLIGHT and controller spend passing the developers' for a day, naming the split", () => {
    store.upsertRun(run("flight-1", { costUsd: 40 }));
    store.upsertRun(run("guido-1", { ticket: "mc#2", costUsd: 12 }));
    syncWasteAlarms(config, store, NOW);
    const a = openWasteAlarms(store).find((x) => x.check === "coordination-overhead");
    expect(a?.evidence).toMatch(/FLIGHT-1 spent \$40\.00 and the developers \$12\.00/);
  });

  it("flags tickets opened reaching tickets closed in a day, and split tickets, naming them", () => {
    const base: Omit<BoardItem, "repoId" | "issueNumber" | "itemId" | "title"> = {
      status: "Backlog",
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
      createdAt: NOW - HOUR,
      projectId: "P",
    };
    store.replaceBoard(
      "mc",
      [1, 2, 3, 4, 5, 6].map((i) => ({
        ...base,
        repoId: "mc",
        issueNumber: i,
        itemId: `I${i}`,
        title: i === 6 ? "Slice 2 of the refactor" : `Ticket ${i}`,
      })),
    );
    syncWasteAlarms(config, store, NOW);
    const churn = openWasteAlarms(store).filter((x) => x.check === "ticket-churn");
    expect(churn.map((x) => x.subject).sort()).toEqual(["mc#6:split", "mc:day"]);
    expect(churn.find((x) => x.subject === "mc:day")?.evidence).toMatch(
      /6 tickets were opened and 0 closed.*#1/,
    );
  });
});

describe("no waste alarm reaches Needs you", () => {
  it("leaves the notes and the attention items empty with checks firing", () => {
    for (let i = 0; i < 8; i++) store.upsertRun(run("flight-1", { startedAt: NOW - i * MIN }));
    for (let i = 0; i < 4; i++)
      store.upsertRun(
        run("guido-1", { ticket: "mc#30", status: "failed", startedAt: NOW - i * MIN }),
      );
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).length).toBeGreaterThanOrEqual(3);
    expect(store.notes()).toEqual([]);
    expect(
      attentionItems(config, store, NOW).filter((i) => /waste|restart storm|parked/i.test(i.text)),
    ).toEqual([]);
  });
});

describe("a weekly pace past 100% is information only", () => {
  const week = (accountId: string, from: number, to: number) => {
    for (const [at, pct] of [
      [NOW - 6 * HOUR, from],
      [NOW, to],
    ] as const)
      store.addUsage({ accountId, window: "7d", at, resetAt: NOW + DAY, pct, source: "test" });
  };

  it("a seat at 32% use with a 195% projection raises nothing and holds nothing", () => {
    // 32% now, three hours after 10%: the pace carries it to about 208% by the reset a day on
    for (const [at, pct] of [
      [NOW - 3 * HOUR, 10],
      [NOW, 32],
    ] as const)
      store.addUsage({
        accountId: "claude-main",
        window: "7d",
        at,
        resetAt: NOW + DAY,
        pct,
        source: "test",
      });
    expect(weeklyProjection(store, "claude-main")?.projected).toBeGreaterThan(195);
    expect(syncWasteAlarms(config, store, NOW)).toBe(false);
    expect(restartHold(store, "guido-1")).toBeNull();
    expect(store.notes()).toEqual([]);
  });

  it("still shows on the Tokens panel's row", () => {
    week("claude-main", 40, 60);
    const row = limitRows(config, store, NOW).find(
      (r) => r.accountId === "claude-main" && r.window === "7d",
    );
    expect(row?.projected).toBe(weeklyProjection(store, "claude-main")?.projected);
    expect(row?.projected).toBeGreaterThan(100);
  });
});

describe("the read route's report", () => {
  it("serves spend per merged change and the building share, with vendor coverage", () => {
    // Claude records a cost; Codex records tokens only (cost unknown, never zero)
    store.upsertRun(
      run("guido-1", {
        costUsd: 6,
        tokens: { input: 100, output: 50, cacheRead: 9999, cacheCreate: 50 },
      }),
    );
    store.upsertRun(
      run("flight-1", {
        costUsd: 4,
        tokens: { input: 100, output: 100, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    store.upsertRun(
      run("guido-cx", {
        costUsd: null,
        tokens: { input: 300, output: 100, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    const report = wasteReport(config, store, NOW);
    const day = report.spend.find((s) => s.window === "day");
    const week = report.spend.find((s) => s.window === "week");
    expect(report.spend.map((s) => s.window)).toEqual(["day", "week"]);
    expect(day).toMatchObject({
      merged: 0,
      costUsd: 10,
      runs: 3,
      runsWithCost: 2,
      perMergeUsd: null,
      tokens: 200 + 200 + 400,
    });
    // building: claude developer $6 of the $10 recorded; tokens: 200 + 400 of 800
    expect(day?.buildingShareUsd).toBeCloseTo(0.6);
    expect(day?.buildingShareTokens).toBeCloseTo(0.75);
    const codex = day?.vendors.find((v) => v.vendor === "codex");
    expect(codex).toMatchObject({ runs: 1, runsWithCost: 0, costUsd: null, tokens: 400 });
    expect(day?.vendors.find((v) => v.vendor === "claude")).toMatchObject({
      runs: 2,
      runsWithCost: 2,
      costUsd: 10,
    });
    expect(week?.merged).toBe(0);
    expect(report.checks.map((c) => c.check)).toHaveLength(10);
  });

  it("divides by the changes merged in the window", () => {
    store.upsertRun(run("guido-1", { costUsd: 9 }));
    store.upsertPullRequests(
      "mc",
      [mergedPr(1, "a", NOW - HOUR), mergedPr(2, "b", NOW - 3 * DAY)],
      NOW,
    );
    const report = wasteReport(config, store, NOW);
    expect(report.spend.find((s) => s.window === "day")).toMatchObject({
      merged: 1,
      perMergeUsd: 9,
    });
    expect(report.spend.find((s) => s.window === "week")).toMatchObject({
      merged: 2,
      perMergeUsd: 4.5,
    });
  });
});

describe("FLIGHT's activity per day on the read route", () => {
  const wait = (at: number) =>
    store.addFlightDecision({
      at,
      kind: "wait",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "mc#1: waiting on CI",
      decision: "waiting",
      basis: "b",
    });
  const tokens = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheCreate: 0 });

  it("counts wakes, waits and FLIGHT's share of tokens in each 24-hour bucket", () => {
    store.upsertRun(run("flight-1", { startedAt: NOW - 2 * HOUR, tokens: tokens(300) }));
    store.upsertRun(run("guido-1", { startedAt: NOW - 3 * HOUR, tokens: tokens(700) }));
    store.upsertRun(run("flight-1", { startedAt: NOW - 30 * HOUR, tokens: tokens(100) }));
    for (const at of [NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR, NOW - 30 * HOUR])
      store.addFlightWake("r1", at, ["q"]);
    for (const at of [NOW - HOUR, NOW - 30 * HOUR, NOW - 31 * HOUR]) wait(at);
    // a decision that is not a wait is not counted
    store.addFlightDecision({
      at: NOW - HOUR,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "a",
      decision: "d",
      basis: "b",
    });
    const days = wasteReport(config, store, NOW).flight;
    expect(days).toHaveLength(14);
    expect(days.at(-1)?.since).toBe(NOW - DAY);
    expect(days.at(-1)).toMatchObject({
      wakes: 3,
      waits: 1,
      flightTokens: 300,
      totalTokens: 1000,
    });
    expect(days.at(-1)?.tokenShare).toBeCloseTo(0.3);
    expect(days.at(-2)).toMatchObject({ wakes: 1, waits: 2, flightTokens: 100, totalTokens: 100 });
    expect(days.at(-2)?.tokenShare).toBe(1);
    expect(days[0]).toMatchObject({ wakes: 0, waits: 0, totalTokens: 0, tokenShare: null });
  });
});

describe("a resolve does not silence a seat for good", () => {
  it("opens the alarm again for a later storm of the same size, ten days on", () => {
    for (let i = 0; i < 12; i++) store.upsertRun(run("guido-1", { startedAt: NOW - i * MIN }));
    syncWasteAlarms(config, store, NOW);
    const alarm = openWasteAlarms(store).find((a) => a.check === "restart-storm");
    resolveWasteAlarm(store, alarm?.id ?? 0, NOW, "let it run");
    syncWasteAlarms(config, store, NOW + MIN);
    expect(restartHold(store, "guido-1")).toBeNull();
    const later = NOW + 10 * DAY;
    for (let i = 0; i < 9; i++) store.upsertRun(run("guido-1", { startedAt: later - i * MIN }));
    syncWasteAlarms(config, store, later);
    expect(restartHold(store, "guido-1")).not.toBeNull();
  });

  it("does the same for coordination overhead", () => {
    store.upsertRun(run("flight-1", { costUsd: 500 }));
    store.upsertRun(run("guido-1", { ticket: "mc#2", costUsd: 50 }));
    syncWasteAlarms(config, store, NOW);
    const alarm = openWasteAlarms(store).find((a) => a.check === "coordination-overhead");
    resolveWasteAlarm(store, alarm?.id ?? 0, NOW, "known");
    const later = NOW + 10 * DAY;
    store.upsertRun(run("flight-1", { costUsd: 300, startedAt: later - MIN }));
    store.upsertRun(run("guido-1", { ticket: "mc#3", costUsd: 50, startedAt: later - MIN }));
    syncWasteAlarms(config, store, later);
    expect(
      openWasteAlarms(store).some((a) => a.check === "coordination-overhead" && a.id !== alarm?.id),
    ).toBe(true);
  });
});

describe("an external PR's reviews", () => {
  it("are never held without an alarm that can lift the hold", () => {
    for (const round of [1, 2, 3])
      store.requestReview({
        authorRunId: "external-pr:mc#7",
        repoId: "mc",
        seatId: "retro-1",
        prNumber: 7,
        sha: `s${round}`,
        epoch: 1,
        attempt: 1,
        round,
        at: NOW - MIN,
      });
    syncWasteAlarms(config, store, NOW);
    expect(reviewsHeld(store, "external-pr:mc#7")).toBe(false);
    expect(openWasteAlarms(store).filter((a) => a.check === "review-rounds")).toEqual([]);
  });
});

describe("the waste_alarm FLIGHT signal", () => {
  it("is raised once for an open alarm and stays told across ticks", () => {
    for (let i = 0; i < 8; i++) store.upsertRun(run("guido-1", { startedAt: NOW - i * MIN }));
    syncWasteAlarms(config, store, NOW);
    const session = config.crew?.sessions[0];
    if (session === undefined) throw new Error("no session");
    const read = (at: number) =>
      flightSignals({ config, store, session, seats: [], now: at }).signals.filter(
        (s) => s.kind === "waste_alarm",
      );
    const first = read(NOW);
    expect(first).toHaveLength(1);
    expect(first[0]?.told).toBe(false);
    markFlightSignalsShown(store, { repo: "mc", signals: first, triage: [] } as never, NOW);
    const next = read(NOW + MIN);
    expect(next).toHaveLength(1);
    expect(next[0]?.told).toBe(true);
  });

  it("does not wake FLIGHT for an unchanged rerun the hook already refused", () => {
    const r = run("guido-1", { ticket: "mc#1596" });
    store.upsertRun(r);
    for (let i = 0; i < 3; i++)
      store.addRerunRefusal(r.id, "pnpm -s lint", "abc1234def", NOW - i * MIN);
    syncWasteAlarms(config, store, NOW);
    expect(openWasteAlarms(store).map((a) => a.check)).toContain("unchanged-rerun");
    const session = config.crew?.sessions[0];
    if (session === undefined) throw new Error("no session");
    const signals = flightSignals({ config, store, session, seats: [], now: NOW }).signals;
    expect(signals.filter((s) => s.kind === "waste_alarm")).toEqual([]);
  });
});

describe("the merged-ticket read at today's size", () => {
  it("syncs 20,000 runs and 2,000 merged PRs well inside a tick", () => {
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec("BEGIN");
    for (let i = 0; i < 20_000; i++) {
      store.upsertRun(
        run("guido-1", {
          ticket: `mc#${i % 2000}`,
          branch: `feature/${i % 2000}`,
          startedAt: NOW - 3 * 24 * HOUR - i,
        }),
      );
    }
    db.exec("COMMIT");
    store.upsertPullRequests(
      "mc",
      Array.from({ length: 2000 }, (_, i) => mergedPr(i, `feature/${i}`, NOW - 2 * DAY)),
      NOW,
    );
    const t0 = performance.now();
    store.waste.mergedTickets();
    syncWasteAlarms(config, store, NOW);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
