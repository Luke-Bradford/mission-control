import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_DECISIONS_SCAN_LIMIT,
  FLIGHT_HEADLINE,
  FLIGHT_ITEMS_LISTED,
  FLIGHT_LEDGER_INDEX_MAX,
  FLIGHT_LEDGER_KEEP_MS,
  FLIGHT_LIST_MAX,
  FLIGHT_METRICS_DAY_MS,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_VIEW_LIMIT,
  type FlightLedgerEntry,
  FOR_THE_CONTROLLER,
  NEW_LOOP,
  orderLedger,
  type PullRequestView,
  type Run,
  wakeKey,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightLedgerView, flightMetrics, flightSummary } from "../src/flight/ledger.ts";
import {
  FLIGHT_RETROSPECTIVE_PARKS_MAX,
  FLIGHT_RETROSPECTIVE_PRS_MAX,
  FLIGHT_RETROSPECTIVE_REASON_MAX,
  mergedTouchesScreen,
  pendingRetrospective,
  prepareRetrospective,
} from "../src/flight/retrospective.ts";
import { observeFlightMain } from "../src/flight/signals.ts";
import { flightState, flightView, flightWake } from "../src/flight/state.ts";
import * as gitRuntime from "../src/runtime/git.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MIN = 60_000;
const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 2,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "main", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "main", model: "opus", area: [] },
        ],
      },
    ],
  },
};
const entry = (key: string, over: Partial<FlightLedgerEntry> = {}): FlightLedgerEntry => ({
  key,
  kind: "work",
  title: key,
  status: "active",
  next: null,
  owner: null,
  waitsOn: null,
  due: null,
  refs: [],
  priority: null,
  createdAt: NOW,
  updatedAt: NOW,
  outcome: null,
  basis: "ticket",
  ...over,
});
const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW - MIN,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "opus",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});
const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "",
  branch: `issue-${number}`,
  ticket: `mc#${number}`,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 3 * FLIGHT_METRICS_DAY_MS,
  updatedAt: NOW,
  mergedAt: NOW - MIN,
  headSha: null,
  mergeable: null,
  ...over,
});
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flight-ledger-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("flightMetrics", () => {
  it("does not list controller decisions without a FLIGHT seat", () => {
    store.addFlightDecision({
      at: NOW - MIN,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "Missing power",
      decision: `${FOR_THE_CONTROLLER} choose a replacement`,
      basis: "operator",
    });

    const withoutFlight = { ...config, crew: undefined };
    expect(flightMetrics(withoutFlight, store, NOW).forTheController).toBe(0);
    expect(flightView(withoutFlight, store, NOW).controllerDecisions).toEqual([]);
  });

  it("shares every recent controller decision with the daily count beyond the view limit", () => {
    const decision = (at: number, text: string) =>
      store.addFlightDecision({
        at,
        kind: "note",
        seatId: null,
        targetRunId: null,
        ref: null,
        questionId: null,
        about: "Missing power",
        decision: text,
        basis: "operator",
      });
    decision(NOW - MIN, `${FOR_THE_CONTROLLER} choose a replacement`);
    for (let n = 0; n <= FLIGHT_VIEW_LIMIT; n++) decision(NOW - n, `newer ${n}`);
    decision(NOW - FLIGHT_METRICS_DAY_MS - 1, `${FOR_THE_CONTROLLER} expired request`);

    const decisions = vi.spyOn(store, "flightDecisions");
    const view = flightView(config, store, NOW);
    expect(decisions).toHaveBeenCalledTimes(1);
    expect(decisions).toHaveBeenCalledWith(
      NOW - FLIGHT_METRICS_DAY_MS,
      FLIGHT_DECISIONS_SCAN_LIMIT,
    );
    expect(flightMetrics(config, store, NOW).forTheController).toBe(1);
    expect(view.decisions).toHaveLength(FLIGHT_VIEW_LIMIT);
    expect((view.controllerDecisions ?? []).map((d) => d.decision)).toEqual([
      `${FOR_THE_CONTROLLER} choose a replacement`,
    ]);
  });

  it("computes daily and live metrics from hub data", () => {
    const mergedAt = NOW - MIN;
    store.upsertPullRequests(
      "mc",
      [
        pr(1),
        pr(2),
        pr(3, { mergedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS }),
        pr(4, { state: "open", mergedAt: null, createdAt: NOW, ci: "pending" }),
      ],
      NOW,
    );
    for (const number of [1, 2])
      store.addBoardMove({
        runId: `dev-${number}`,
        repoId: "mc",
        issue: number,
        column: "Ready",
        state: "done",
        detail: null,
        at: mergedAt - number * 60 * MIN,
      });
    store.upsertRun(
      run("dev", "guido-1", {
        costUsd: 1.25,
        tokens: { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 },
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "ci", reason: "CI failed 3 times", ended: false },
        },
      }),
    );
    store.upsertRun(
      run("flight", "flight-1", { startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS, costUsd: 0.5 }),
    );
    store.upsertRun(
      run("old", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        costUsd: 10,
      }),
    );
    store.upsertRun(
      run("boundary", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        endedAt: NOW - FLIGHT_METRICS_DAY_MS,
        costUsd: 5,
      }),
    );
    store.upsertRun(
      run("past", "guido-1", {
        startedAt: NOW - 2 * FLIGHT_METRICS_DAY_MS,
        endedAt: NOW - FLIGHT_METRICS_DAY_MS - 1,
        costUsd: 30,
      }),
    );
    store.upsertRun(run("other", "guido-1", { repoId: "other", costUsd: 20 }));
    store.addLoopEvent("dev:fail", "dev", "CI failed on abc1234", NOW);
    store.addLoopEvent("dev:rerun:sha", "dev", "CI failed on abc1234; re-ran lint", NOW);
    store.addLoopEvent("dev:park", "dev", "parked: CI failed 3 times", NOW);
    store.addLoopEvent("other:fail", "other", "CI failed on abc1234", NOW);
    for (const n of [1, 2])
      store.claimLine(wakeKey("flight", n), {
        runId: "flight",
        seatId: "flight-1",
        origin: "engine",
        text: "wake",
        at: NOW,
      });
    store.claimLine(wakeKey("flight", 0), {
      runId: "flight",
      seatId: "flight-1",
      origin: "engine",
      text: "old wake",
      at: NOW - 2 * FLIGHT_METRICS_DAY_MS,
    });
    store.addFlightDecision({
      at: NOW,
      kind: "note",
      seatId: "flight-1",
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "Missing power",
      decision: `${FOR_THE_CONTROLLER} update`,
      basis: "operator",
    });
    const runLookup = vi.spyOn(store, "run");
    const claimsLookup = vi.spyOn(store, "claimedKeys");
    expect(flightMetrics(config, store, NOW)).toEqual({
      since: NOW - FLIGHT_METRICS_DAY_MS,
      opened: 1,
      inReview: 1,
      inCi: 1,
      ciFailures: 3,
      reruns: 1,
      parks: { day: 1, live: [{ kind: "ci", n: 1 }] },
      seats: [
        { seat: "guido-1", tokens: 100, costUsd: 16.25 },
        { seat: "flight-1", tokens: 0, costUsd: 0.5 },
      ],
      flight: { wakes: 2, costUsd: 0.5 },
      forTheController: 1,
    });
    expect(runLookup).not.toHaveBeenCalled();
    expect(claimsLookup.mock.calls).toEqual([["flight"]]);
  });

  it("counts every start wake in the window as well as claimed wakes, beyond 50 runs", () => {
    const since = NOW - FLIGHT_METRICS_DAY_MS;
    for (let n = 0; n < 55; n++)
      store.upsertRun(run(`flight-${n}`, "flight-1", { startedAt: since + n, endedAt: NOW }));
    store.upsertRun(run("old-flight", "flight-1", { startedAt: since - 1 }));
    store.upsertRun(run("foreign-flight", "flight-1", { repoId: "other" }));
    for (const id of ["flight-0", "old-flight"])
      store.claimLine(wakeKey(id, 1), {
        runId: id,
        seatId: "flight-1",
        origin: "engine",
        text: "wake",
        at: NOW,
      });
    expect(flightMetrics(config, store, NOW).flight.wakes).toBe(57);
  });

  it("sorts live parks by descending count, breaking ties by kind", () => {
    for (const [n, kind] of (
      ["ci", "conflict", "ci", "review", "conflict", "ci"] as const
    ).entries())
      store.upsertRun(
        run(`park-${n}`, "guido-1", {
          loop: { ...NEW_LOOP, phase: "parked", parked: { kind, reason: kind, ended: false } },
        }),
      );
    store.upsertRun(
      run("ended", "guido-1", {
        endedAt: NOW,
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "review", reason: "ended", ended: true },
        },
      }),
    );
    expect(flightMetrics(config, store, NOW).parks.live).toEqual([
      { kind: "ci", n: 3 },
      { kind: "conflict", n: 2 },
      { kind: "review", n: 1 },
    ]);
  });

  it.each([
    ["ruling-rerun:sha", "FLIGHT re-ran the failed CI jobs on sha", 1, 0],
    ["ruling-rerun:sha:failed", "CI failed again on the re-run of sha", 0, 1],
    ["ruling-rerun:sha:passed", "CI passed on the re-run of sha; FLIGHT accepted the ruling", 0, 0],
    ["rerun:sha", "CI failed on sha; no run could be re-run", 0, 0],
    ["rerun:sha", "CI failed on sha; re-ran lint", 1, 1],
    ["flake:sha", "CI flaked on sha: passed on re-run", 0, 1],
  ])("counts rerun activity %s (%s)", (key, text, reruns, ciFailures) => {
    const id = "dev:with:colons";
    store.upsertRun(run(id, "guido-1"));
    store.addLoopEvent(`${id}:${key}`, id, text, NOW);
    expect(flightMetrics(config, store, NOW)).toMatchObject({ reruns, ciFailures });
  });

  it("returns zeros without a session", () => {
    expect(flightMetrics({ ...config, crew: undefined }, store, NOW)).toMatchObject({
      seats: [],
      flight: { wakes: 0, costUsd: 0 },
    });
  });
});

describe("ledger storage and summaries", () => {
  it("pages open entries after filtering without capping summary counts", () => {
    for (let n = 0; n < FLIGHT_LIST_MAX + 2; n++)
      store.putFlightLedgerEntry("s1", entry(`watch-${n}`, { kind: "watch" }), 0);
    store.putFlightLedgerEntry("s1", entry("closed", { kind: "watch", status: "done" }), 0);
    const first = flightLedgerView(config, store);
    expect(first.entries).toHaveLength(FLIGHT_LIST_MAX);
    expect(first).toMatchObject({ more: true, nextOffset: FLIGHT_LIST_MAX });
    const last = flightLedgerView(config, store, { offset: first.nextOffset ?? 0 });
    expect(last).toMatchObject({ more: false, nextOffset: null });
    expect(new Set([...first.entries, ...last.entries].map((e) => e.key)).size).toBe(
      FLIGHT_LIST_MAX + 2,
    );
    expect(flightLedgerView(config, store, { status: "done" }).entries.map((e) => e.key)).toEqual([
      "closed",
    ]);
    expect(flightLedgerView(config, store, { kind: "work" }).entries).toEqual([]);
    expect(flightSummary(config, store, NOW).watching.counts).toMatchObject({
      active: FLIGHT_LIST_MAX + 2,
      done: 1,
    });
  });

  it("carries headline age into summaries and every digest without changing its version", () => {
    expect(flightSummary(config, store, NOW).headlineAgeMin).toBeNull();
    store.setFlightBriefSection({
      sessionId: "s1",
      section: FLIGHT_HEADLINE,
      text: "H",
      updatedAt: NOW - 2 * MIN,
      updatedBy: "flight-1",
    });
    expect(flightSummary(config, store, NOW).headlineAgeMin).toBe(2);
    const first = flightWake(flightState({ config, store, now: NOW, busy: [] }));
    const second = flightWake(
      flightState({ config, store, now: NOW + MIN, busy: [] }),
      first.snapshot,
    );
    expect(first.digest.headlineAgeMin).toBe(2);
    expect(second.digest).toMatchObject({
      headlineAgeMin: 3,
      briefVersion: first.digest.briefVersion,
    });
    expect(second.digest.headline).toBeUndefined();
    store.setFlightBriefSection({
      sessionId: "s1",
      section: FLIGHT_HEADLINE,
      text: "",
      updatedAt: NOW,
      updatedBy: "flight-1",
    });
    expect(flightSummary(config, store, NOW + MIN).headlineAgeMin).toBeNull();
    expect(flightState({ config, store, now: NOW + MIN, busy: [] }).headlineAgeMin).toBeNull();
  });

  it("includes structured watch counts and uncapped triage, deduplicating incoming keys", () => {
    store.setFlightWatch(
      "s1",
      {
        upsert: (["warn", "info", "ok"] as const).map((state) => ({
          id: state,
          state,
          title: state,
          detail: state,
          next: "check",
          catchUp: { kind: "new", line: state },
        })),
      },
      NOW,
    );
    store.upsertRun(run("dev", "guido-1"));
    store.setSeatSession({
      seatId: "guido-1",
      runId: "dev",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    for (let n = 0; n < FLIGHT_ITEMS_LISTED + 2; n++) {
      const id = store.addQuestion({
        agentId: "guido-1",
        runId: "dev",
        text: `Question ${n}?`,
        at: NOW,
      });
      if (n === 0) store.putFlightLedgerEntry("s1", entry(`ask:${id}`, { kind: "incoming" }), 0);
    }
    store.putFlightLedgerEntry("s1", entry("extra", { kind: "incoming" }), 0);
    expect(flightSummary(config, store, NOW)).toMatchObject({
      watching: {
        counts: { blocked: 1, active: 1, done: 1 },
        top: [
          { key: "structured:warn", title: "warn", status: "blocked", next: "check" },
          { key: "structured:info", title: "info", status: "active", next: "check" },
        ],
      },
      incoming: FLIGHT_ITEMS_LISTED + 3,
    });
  });

  it("reports open entries omitted from the digest index", () => {
    expect(flightState({ config, store, busy: [], now: NOW }).ledgerMore).toBe(0);
    for (let n = 0; n < FLIGHT_LEDGER_INDEX_MAX + 3; n++) {
      store.putFlightLedgerEntry("s1", entry(`w${n}`), 0);
    }
    store.putFlightLedgerEntry("s1", entry("done", { status: "done" }), 0);
    store.putFlightLedgerEntry("s1", entry("dropped", { status: "dropped" }), 0);
    store.putFlightLedgerEntry("s2", entry("other"), 0);
    const state = flightState({ config, store, busy: [], now: NOW });
    expect(state.ledger).toHaveLength(FLIGHT_LEDGER_INDEX_MAX);
    expect(state.ledgerMore).toBe(3);
  });
  it("prunes closed entries by updated time across sessions, including removed sessions", () => {
    const before = NOW - FLIGHT_LEDGER_KEEP_MS;
    store.putFlightLedgerEntry(
      "s1",
      entry("old-done", { status: "done", updatedAt: before - 1 }),
      0,
    );
    store.putFlightLedgerEntry(
      "s1",
      entry("old-dropped", { status: "dropped", updatedAt: before - 1 }),
      0,
    );
    store.putFlightLedgerEntry("s1", entry("old-open", { updatedAt: before - 1 }), 0);
    store.putFlightLedgerEntry("s1", entry("boundary", { status: "done", updatedAt: before }), 0);
    store.putFlightLedgerEntry("s2", entry("other", { status: "done", updatedAt: before - 1 }), 0);
    store.putFlightLedgerEntry("s1", entry("new"), before);
    expect(store.flightLedger("s1").map((e) => e.key)).toEqual(["boundary", "new", "old-open"]);
    expect(store.flightLedger("s2")).toHaveLength(0);
  });

  it("orders by kind, open state, priority, age and key without mutating the input", () => {
    const entries = [
      entry("watch", { kind: "watch", priority: "P0" }),
      entry("done", { status: "done", priority: "P0" }),
      entry("null"),
      entry("b", { priority: "P1" }),
      entry("a", { priority: "P1" }),
      entry("old", { priority: "P1", createdAt: NOW - MIN }),
    ];
    expect(orderLedger(entries).map((e) => e.key)).toEqual([
      "old",
      "a",
      "b",
      "null",
      "done",
      "watch",
    ]);
    expect(entries[0]?.key).toBe("watch");
  });

  it("combines pending plans and commitments by due time with undated entries last", () => {
    store.putFlightLedgerEntry("s1", entry("undated", { kind: "commitment" }), 0);
    store.putFlightLedgerEntry(
      "s1",
      entry("commitment", { kind: "commitment", due: NOW + MIN }),
      0,
    );
    store.setFlightPlans(
      "s1",
      {
        upsert: [
          {
            id: "plan",
            kind: "report",
            target: "crew",
            label: "x".repeat(100),
            status: "pending",
            dueAt: NOW,
          },
          {
            id: "cancelled",
            kind: "report",
            target: "crew",
            label: "Cancelled",
            status: "cancelled",
            dueAt: NOW - MIN,
          },
        ],
      },
      NOW,
    );
    const next = flightSummary(config, store, NOW).next;
    expect(next.map((e) => e.key)).toEqual(["plan", "commitment", "undated"]);
    expect(next[0]).toMatchObject({ kind: "plan", ageMin: 0 });
    expect(next[0]?.title).toHaveLength(80);
  });

  it("shows the five most recently completed ledger outcomes", () => {
    for (let n = 0; n < 7; n++)
      store.putFlightLedgerEntry(
        "s1",
        entry(`done-${n}`, { status: "done", updatedAt: NOW - n * MIN, outcome: `Outcome ${n}` }),
        0,
      );
    store.putFlightLedgerEntry("s1", entry("dropped", { status: "dropped" }), 0);
    expect(flightSummary(config, store, NOW).done.map((item) => item.key)).toEqual([
      "done-0",
      "done-1",
      "done-2",
      "done-3",
      "done-4",
    ]);
  });

  it("drops closed arrivals before taking the outcomes and carries each outcome's evidence", () => {
    for (let n = 0; n < 6; n++)
      store.putFlightLedgerEntry(
        "s1",
        entry(`arrival-${n}`, { kind: "incoming", status: "done", updatedAt: NOW + n }),
        0,
      );
    store.putFlightLedgerEntry(
      "s1",
      entry("shipped", {
        status: "done",
        updatedAt: NOW - MIN,
        outcome: "Merged PR #12",
        refs: ["#5", "PR #12"],
        basis: "PR #12 merged",
      }),
      0,
    );
    expect(flightSummary(config, store, NOW).done).toEqual([
      expect.objectContaining({
        key: "shipped",
        outcome: "Merged PR #12",
        refs: ["#5", "PR #12"],
        basis: "PR #12 merged",
        closedAt: NOW - MIN,
      }),
    ]);
  });
});

describe("retrospective measures", () => {
  it("carries the existing metrics, review failures, park reasons, red-main and costly runs", async () => {
    store.upsertPullRequests("mc", [pr(1)], NOW);
    store.upsertRun(run("dev", "guido-1", { costUsd: 3 }));
    store.upsertRun(run("cheap", "guido-1", { costUsd: 1 }));
    store.upsertRun(run("foreign", "guido-1", { repoId: "other", costUsd: 100 }));
    store.addLoopEvent("dev:park", "dev", "parked: failed checks", NOW);
    observeFlightMain(store, "mc", { sha: "red", ci: "failing", at: NOW - MIN });
    observeFlightMain(store, "mc", { sha: "green", ci: "passing", at: NOW });
    for (const [repoId, spec, at] of [
      ["mc", "pass", NOW],
      ["mc", "fail", NOW],
      ["other", "fail", NOW],
      ["mc", "fail", NOW - 2 * FLIGHT_METRICS_DAY_MS],
      ["mc", "fail", NOW + MIN],
    ] as const) {
      const id = store.requestReview({
        authorRunId: "dev",
        repoId,
        seatId: "guido-1",
        prNumber: 1,
        sha: `${repoId}-${spec}-${at}`,
        epoch: 0,
        attempt: 1,
        round: 1,
        at: NOW,
      });
      if (id === null) throw new Error("review not queued");
      store.setReviewState(id, ["queued"], "running", { runId: spec, at: NOW });
      store.recordFindings(id, spec, {
        verdict: { spec, quality: "pass" },
        summary: "reviewed",
        findings: [],
        at,
      });
    }
    await prepareRetrospective(config, store, NOW);
    const report = pendingRetrospective(store, "mc");
    expect(report?.metrics).toEqual(flightMetrics(config, store, NOW));
    expect(report).toMatchObject({
      day: "2026-10-24",
      at: NOW,
      screenChanges: { touching: 0, unknown: 1, share: null },
      reviews: { reported: 2, failed: 1, failRate: 0.5 },
      parkReasons: [{ reason: "failed checks", n: 1 }],
      redMain: [{ kind: "main_red", key: "red" }],
      costlyRuns: [
        { runId: "dev", costUsd: 3 },
        { runId: "cheap", costUsd: 1 },
      ],
      productPass: {
        pages: [
          "/",
          "/flight",
          "/board",
          "/map",
          "/comms",
          "/qa",
          "/telemetry",
          "/audit",
          "/setup",
          "/agent/flight-1",
          "/agent/guido-1",
        ],
        instruction: expect.stringContaining("log pages checked and tickets filed or folded"),
      },
    });
    await prepareRetrospective(config, store, NOW + MIN);
    expect(pendingRetrospective(store, "mc")).toEqual(report);
  });
  it("replaces yesterday's untold report after 03:00 and withholds it while preparing", async () => {
    await prepareRetrospective(config, store, NOW - FLIGHT_METRICS_DAY_MS);
    expect(pendingRetrospective(store, "mc")?.day).toBe("2026-10-23");
    expect(flightState({ config, store, now: NOW, busy: [] }).retrospective).toBeUndefined();
    await prepareRetrospective(config, store, NOW);
    expect(pendingRetrospective(store, "mc")?.day).toBe("2026-10-24");
    const saved = JSON.parse(store.getSetting(`${FLIGHT_RETROSPECTIVE_SETTING}:mc`) ?? "{}");
    expect(saved.told).toBe(false);
  });

  it("normalises and bounds park reasons and includes old red-main episodes seen in the window", async () => {
    store.upsertRun(run("dev", "guido-1"));
    for (const sha of ["abcdef1", "abcdef2"])
      store.addLoopEvent(`dev:park:${sha}`, "dev", `parked: failed on ${sha}`, NOW);
    for (let n = 0; n < FLIGHT_RETROSPECTIVE_PARKS_MAX + 3; n++)
      store.addLoopEvent(`dev:other:${n}`, "dev", `parked: reason ${n} ${"x".repeat(500)}`, NOW);
    observeFlightMain(store, "mc", {
      sha: "red",
      ci: "failing",
      at: NOW - 2 * FLIGHT_METRICS_DAY_MS,
    });
    observeFlightMain(store, "mc", { sha: "red", ci: "failing", at: NOW - MIN });
    await prepareRetrospective(config, store, NOW);
    const report = pendingRetrospective(store, "mc");
    expect(report?.parkReasons[0]).toEqual({ reason: "failed on <sha>", n: 2 });
    expect(report?.parkReasons).toHaveLength(FLIGHT_RETROSPECTIVE_PARKS_MAX);
    expect(
      report?.parkReasons.every((p) => p.reason.length <= FLIGHT_RETROSPECTIVE_REASON_MAX),
    ).toBe(true);
    expect(report?.redMain).toMatchObject([{ key: "red", since: NOW - 2 * FLIGHT_METRICS_DAY_MS }]);
  });

  it("fetches once, pins the clone git dir, caps classification and excludes unknowns from share", async () => {
    store.upsertPullRequests(
      "mc",
      Array.from({ length: FLIGHT_RETROSPECTIVE_PRS_MAX + 2 }, (_, n) =>
        pr(n + 1, {
          mergeCommitSha: n === FLIGHT_RETROSPECTIVE_PRS_MAX + 1 ? null : "a".repeat(40),
        }),
      ),
      NOW,
    );
    const git = vi.spyOn(gitRuntime, "crewGit").mockImplementation(async (_, args) => {
      if (args.includes("ls-remote"))
        return `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\tHEAD\n`;
      if (args.includes("ls-tree")) return "apps/web\n";
      if (args.includes("--name-only")) return "apps/web/src/Page.tsx\0";
      return "";
    });
    await prepareRetrospective(config, store, NOW);
    expect(pendingRetrospective(store, "mc")?.screenChanges).toEqual({
      touching: 99,
      unknown: 3,
      share: 1,
    });
    expect(git.mock.calls.filter(([, args]) => args.includes("fetch"))).toHaveLength(1);
    expect(git.mock.calls.filter(([, args]) => args.includes("diff"))).toHaveLength(
      FLIGHT_RETROSPECTIVE_PRS_MAX - 1,
    );
    for (const [, , common, options] of git.mock.calls) expect(options?.gitDir).toBe(common);
  });
});

const batch = (sources: (string | null)[]): Buffer =>
  Buffer.concat(
    sources.map((source) =>
      source === null
        ? Buffer.from("file missing\n")
        : Buffer.from(`${"a".repeat(40)} blob ${Buffer.byteLength(source)}\n${source}\n`),
    ),
  );

describe("screen classification", () => {
  it("detects web changes, with n/a for no apps/web or unavailable commits", async () => {
    const git = vi.fn(async (args: string[]) =>
      args.includes("ls-tree") ? "apps/web\n" : "apps/web/src/Page.tsx\0",
    );
    expect(await mergedTouchesScreen(git, "a".repeat(40))).toBe(true);
    expect(git.mock.calls[1]).toEqual([
      expect.arrayContaining(["--name-only", "--no-ext-diff", "--no-textconv"]),
    ]);
    expect(await mergedTouchesScreen(git, null)).toBeNull();
    expect(await mergedTouchesScreen(async () => "", "a".repeat(40))).toBeNull();
    expect(
      await mergedTouchesScreen(async () => {
        throw new Error("missing");
      }, "a".repeat(40)),
    ).toBeNull();
  });

  it.each([
    [3, true],
    [4, true],
    [8, false],
  ])("compares changed route line %s with one diff and one batch", async (line, expected) => {
    const source = [
      "      // Reader: apps/web/src/Page.tsx",
      '      api.get("/screen", async () => {',
      "        const value = 1;",
      "        return value;",
      "      });",
      "",
      '      api.get("/internal", async () => {',
      "        return 2;",
      "      });",
    ].join("\n");
    const changed = source
      .split("\n")
      .map((text, n) => (n === Number(line) - 1 ? `${text} // changed` : text))
      .join("\n");
    const git = vi.fn(async (args: string[], _input?: string) =>
      args.includes("--name-only") ? "apps/server/src/api.ts\0" : batch(["", source, "", changed]),
    );
    expect(await mergedTouchesScreen(git, "a".repeat(40), true)).toBe(expected);
    expect(git).toHaveBeenCalledTimes(2);
    expect(git.mock.calls[1]?.[0]).toContain("--batch");
    expect(git.mock.calls[1]?.[1]?.split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("matches unannotated routes via the path table and handles missing files and Unicode byte sizes", async () => {
    const paths = `path: \`/api/boards/\${enc(repoId)}?limit=10\``;
    const source =
      '      api.get("/boards/:repoId", async () => {\n        return ["é"];\n      });';
    const git = async (args: string[]) =>
      args.includes("--name-only")
        ? "apps/server/src/api.ts\0"
        : batch([paths, null, paths, source]);
    expect(await mergedTouchesScreen(git, "a".repeat(40), true)).toBe(true);
  });
});

it("reads real git batches with pinned git dirs and UTF-8 blobs", async () => {
  const checkout = join(dir, "repo");
  mkdirSync(join(checkout, "apps/web/src"), { recursive: true });
  mkdirSync(join(checkout, "apps/server/src"), { recursive: true });
  const runGit = (args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  runGit(["init", "-b", "main"]);
  writeFileSync(join(checkout, "apps/web/src/data.ts"), 'const path = "/api/screen";');
  const route = (value: string) => `api.get("/screen", async () => {\n  return "${value}";\n});`;
  writeFileSync(join(checkout, "apps/server/src/api.ts"), route("é"));
  const commit = () => {
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "test",
    ]);
  };
  commit();
  writeFileSync(join(checkout, "apps/server/src/api.ts"), route("日本語"));
  commit();
  const common = join(checkout, ".git");
  const git = (args: string[], input?: string) =>
    gitRuntime.crewGitBytes(checkout, args, common, { gitDir: common, input });
  expect(await mergedTouchesScreen(git, runGit(["rev-parse", "HEAD"]))).toBe(true);
  await expect(
    git(["cat-file", "--invalid-batch-mode"], "x".repeat(1_000_000)),
  ).rejects.toBeDefined();
});
