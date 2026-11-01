import {
  type BoardItem,
  type FlightPrFlow,
  type FlightState,
  NEW_LOOP,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextWakeAt, wakeReasons } from "../src/flight/state.ts";
import { prFlow, prFlowFacts, prFlowWakeTimes } from "../src/pr-flow.ts";
import { Store } from "../src/store.ts";

const T = Date.parse("2026-11-01T12:00:00Z");
const M = 60_000;
const DAY = 24 * 60 * M;
let store: Store;
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
const flow = (at = T + 20 * M) => prFlow(store, "mc", at);
const row = (at?: number) => flow(at).rows[0];
function review(at: number, blocking = false, author = "author", number = 7) {
  const id = store.requestReview({
    authorRunId: author,
    repoId: "mc",
    seatId: "retro",
    prNumber: number,
    sha: "head",
    epoch: 0,
    attempt: 1,
    round: 1,
    at,
  });
  if (id === null) throw new Error("review not queued");
  store.setReviewState(id, ["queued"], "running", { runId: `review-${id}`, at });
  if (blocking)
    store.recordFindings(id, `review-${id}`, {
      verdict: { spec: "fail", quality: "pass" },
      summary: "fix",
      findings: [
        {
          severity: "Important",
          file: "a.ts",
          line: 1,
          summary: "broken",
          scenario: "example",
          fix: "repair",
        },
      ],
      at: at + M,
    });
  return id;
}
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("PR flow ownership and clocks", () => {
  it("names never-run and ended-run faults from their actual start time", () => {
    store.upsertPullRequests("mc", [pr()], T);
    expect(row()).toMatchObject({ owner: "nobody", ownerSince: T, lastAction: "PR opened" });
    expect(prFlowFacts(flow(T + 5 * M - 1))).toEqual([]);
    expect(prFlowFacts(flow(T + 5 * M))).toEqual([`7:unowned:${T}`]);
    store.upsertRun(run("author", { endedAt: T + M }));
    expect(row()).toMatchObject({
      owner: "nobody",
      ownerSince: T + M,
      lastAction: "run ended",
      lastActor: "guido",
    });
    expect(prFlowFacts(flow(T + 6 * M))).toEqual([`7:unowned:${T + M}`]);
  });

  it("never lets a newer reviewer run replace an author, and prefers a direct binding to ticket fallback", () => {
    store.upsertRun(run());
    store.setRunLoop("author", { ...NEW_LOOP, phase: "ci", prNumber: 7 }, T + M);
    store.upsertRun(run("same-ticket", { branch: null, startedAt: T + 2 * M, agentId: "other" }));
    store.upsertRun(
      run("reviewer", { branch: null, startedAt: T + 3 * M, reviewId: 1, agentId: "retro" }),
    );
    store.upsertPullRequests("mc", [pr()], T);
    expect(row()).toMatchObject({ owner: "CI", stage: "CI" });
    store.setRunEnded("reviewer", T + 4 * M, "ok", "operator");
    expect(row()).toMatchObject({ owner: "CI", stage: "CI" });
  });

  it("preserves the first CI timestamp across later same-stage snapshots", () => {
    store.upsertRun(run());
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7 }, T);
    store.setRunLoop("author", { ...NEW_LOOP, phase: "ci", prNumber: 7 }, T + M);
    store.setRunLoop("author", { ...NEW_LOOP, phase: "ci", prNumber: 7, transient: 1 }, T + 2 * M);
    store.upsertPullRequests("mc", [pr()], T);
    expect(row()).toMatchObject({ stage: "CI", stageSince: T + M });
  });

  it("distinguishes UAT, pending controller, completed controller, and FLIGHT clearance", () => {
    store.upsertRun(run());
    store.upsertPullRequests("mc", [pr()], T);
    store.setRunLoop(
      "author",
      { ...NEW_LOOP, prNumber: 7, uat: { sha: "head", from: "ci", accepted: false } },
      T + M,
    );
    expect(row()).toMatchObject({ owner: "operator", stage: "clearance", ownerSince: T + M });
    store.setRunLoop(
      "author",
      { ...NEW_LOOP, prNumber: 7, controllerCheck: { sha: "head", from: "ci", pass: false } },
      T + 2 * M,
    );
    expect(row()).toMatchObject({
      owner: "controller",
      stage: "controller check",
      ownerSince: T + 2 * M,
    });
    store.setRunLoop(
      "author",
      {
        ...NEW_LOOP,
        prNumber: 7,
        phase: "ci",
        controllerCheck: { sha: "head", from: "ci", pass: true },
      },
      T + 3 * M,
    );
    expect(row()).toMatchObject({ owner: "CI", stage: "CI", waitsOn: [] });
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, awaitingFlight: "head" }, T + 4 * M);
    expect(row()).toMatchObject({ owner: "FLIGHT", stage: "clearance" });
  });

  it("shows delivered blocking fixes as author rework, then moves to the next review; failed reviewer parks belong to FLIGHT", () => {
    store.upsertRun(run());
    store.upsertPullRequests("mc", [pr()], T);
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, phase: "review" }, T);
    const id = review(T + M, true);
    expect(row()).toMatchObject({ stage: "review", owner: "hub" });
    store.addLoopEvent(`author:review:${id}:fix`, "author", "sent findings to GUIDO", T + 3 * M);
    expect(row()).toMatchObject({
      stage: "rework",
      owner: "guido",
      seatId: "guido",
      stageSince: T + 3 * M,
    });
    store.requestReview({
      authorRunId: "author",
      repoId: "mc",
      seatId: "retro",
      prNumber: 7,
      sha: "head",
      epoch: 0,
      attempt: 2,
      round: 2,
      at: T + 4 * M,
    });
    expect(row()).toMatchObject({ stage: "review", owner: "retro", stageSince: T + 4 * M });
    store.setRunLoop(
      "author",
      {
        ...NEW_LOOP,
        prNumber: 7,
        phase: "parked",
        parked: { kind: "review-failed", reason: "reviewer failed", ended: false },
      },
      T + 5 * M,
    );
    expect(row()).toMatchObject({ stage: "clearance", owner: "FLIGHT" });
  });

  it("ignores old-epoch and other-author reviews after a same-head resume", () => {
    store.upsertRun(run());
    store.upsertPullRequests("mc", [pr()], T);
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, phase: "review" }, T);
    const old = review(T + M);
    store.recordFindings(old, `review-${old}`, {
      verdict: { spec: "pass", quality: "pass" },
      summary: "clean",
      findings: [],
      at: T + 2 * M,
    });
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, epoch: 1 }, T + 3 * M);
    expect(row()).toMatchObject({ stage: "building", owner: "guido" });
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, epoch: 1, phase: "review" }, T + 4 * M);
    store.requestReview({
      authorRunId: "other",
      repoId: "mc",
      seatId: "wrong-seat",
      prNumber: 7,
      sha: "head",
      epoch: 1,
      attempt: 1,
      round: 1,
      at: T + 5 * M,
    });
    expect(row()).toMatchObject({ stage: "review", owner: "review seat" });
  });

  it("uses timestamp order rather than insertion order and records the newest real action and actor", () => {
    store.upsertRun(run());
    store.upsertPullRequests("mc", [pr()], T);
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, phase: "ci" }, T + 3 * M);
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, transient: 1 }, T + M);
    // The live state can be updated independently; historical event order stays chronological.
    store.setRunLoop("author", { ...NEW_LOOP, prNumber: 7, phase: "ci", transient: 2 }, T + 4 * M);
    expect(row()).toMatchObject({ stageSince: T + 3 * M });
    review(T + 5 * M, true);
    expect(row()).toMatchObject({
      lastAction: "review reported",
      lastActor: "retro",
      lastActionAt: T + 6 * M,
    });
    store.upsertPullRequests(
      "mc",
      [
        pr(7, {
          ci: "passing",
          checks: [
            {
              name: "CI",
              kind: "check",
              attempt: 1,
              state: "passing",
              conclusion: "success",
              url: null,
            },
          ],
        }),
      ],
      T + 7 * M,
    );
    expect(row()).toMatchObject({ lastActor: "CI", lastActionAt: T + 7 * M });
    store.addFlightDecision({
      kind: "hold",
      seatId: "guido",
      targetRunId: "author",
      ref: "mc#7",
      questionId: null,
      about: "hold",
      decision: "wait for dependency",
      basis: "test",
      at: T + 8 * M,
    });
    expect(row()).toMatchObject({
      lastAction: "wait for dependency",
      lastActor: "FLIGHT",
      lastActionAt: T + 8 * M,
    });
    store.addLoopEvent(
      "author:0:controller-check:head:pass",
      "author",
      "controller check passed",
      T + 9 * M,
    );
    expect(row()).toMatchObject({
      lastAction: "controller check passed",
      lastActor: "controller",
      lastActionAt: T + 9 * M,
    });
  });
});

describe("dependencies and immutable flow metrics", () => {
  it("reads body, GitHub blocked-by, stacked bases and closing issues in both directions", () => {
    store.upsertPullRequests(
      "mc",
      [
        pr(7, { ticket: "mc#70", closingIssues: [70, 71] }),
        pr(9),
        pr(10, { base: "feature/7" }),
        pr(11),
      ],
      T,
    );
    store.replaceBoard("mc", [
      card(70),
      card(71),
      card(9, { after: { issues: [71], prs: [] } }),
      card(11, {
        blockedBy: [{ ref: "mc#70", closed: false }],
        after: { issues: [], prs: [7] },
      }),
    ]);
    const rows = flow().rows;
    expect(rows.find((r) => r.pr === 7)?.blocks).toEqual(
      expect.arrayContaining(["mc#9", "PR 9", "PR 10", "mc#11", "PR 11"]),
    );
    expect(rows.find((r) => r.pr === 9)?.waitsOn).toEqual(
      expect.arrayContaining([expect.stringContaining("mc#71")]),
    );
    expect(rows.find((r) => r.pr === 10)?.waitsOn).toEqual(
      expect.arrayContaining(["PR 7 to merge"]),
    );
    expect(rows.find((r) => r.pr === 11)?.waitsOn).toEqual(
      expect.arrayContaining([expect.stringContaining("PR 7"), expect.stringContaining("mc#70")]),
    );
  });

  function merged(number: number, start: number, unit: number) {
    const id = `author-${number}`;
    store.upsertRun(
      run(id, { startedAt: start, branch: `feature/${number}`, ticket: `mc#${number}` }),
    );
    store.upsertPullRequests("mc", [pr(number, { createdAt: start })], start);
    const loop = (n: number, patch: Partial<NonNullable<Run["loop"]>>) =>
      store.setRunLoop(
        id,
        { ...NEW_LOOP, prNumber: number, pushFor: "head", ...patch },
        start + n * unit,
      );
    loop(0, {});
    loop(1, { phase: "ci", ciFails: 3 });
    loop(2, { phase: "review" });
    const r = store.requestReview({
      authorRunId: id,
      repoId: "mc",
      seatId: "retro",
      prNumber: number,
      sha: "head",
      epoch: 0,
      attempt: 1,
      round: 1,
      at: start + 2 * unit,
    });
    if (r === null) throw new Error("missing review");
    store.setReviewState(r, ["queued"], "running", { runId: `review-${r}`, at: start + 2 * unit });
    store.recordFindings(r, `review-${r}`, {
      verdict: { spec: "fail", quality: "pass" },
      summary: "fix",
      findings: [
        {
          severity: "Important",
          file: "a.ts",
          line: 1,
          summary: "broken",
          scenario: "x",
          fix: "repair",
        },
      ],
      at: start + 3 * unit,
    });
    store.addLoopEvent(`${id}:review:${r}:fix`, id, "fix delivered", start + 3 * unit);
    loop(4, { mainMerge: { mainSha: "main", files: [] } });
    loop(5, { mergeHold: { by: "FLIGHT", reason: "clearance", at: start + 5 * unit } });
    loop(6, { controllerCheck: { sha: "head", from: "ci", pass: false } });
    loop(7, { merging: { sha: "head", done: [] } });
    store.upsertPullRequests(
      "mc",
      [pr(number, { state: "merged", createdAt: start, mergedAt: start + 8 * unit })],
      start + 8 * unit,
    );
    store.setRunEnded(id, start + 8 * unit, "ok", "operator");
  }

  it("measures all eight ordered stages and blocking review rounds in exact 24h/7d cohorts, even after cache eviction", () => {
    merged(7, T, M);
    merged(8, T - 2 * DAY, 2 * M);
    store.upsertPullRequests(
      "mc",
      [pr(9, { state: "merged", createdAt: T - 3 * DAY, mergedAt: T - 3 * DAY + 10 * M })],
      T,
    );
    store.replacePullRequests("mc", [], T + 10 * M);
    const [day, week] = flow(T + 10 * M).metrics;
    expect(day).toMatchObject({
      merged: 1,
      openToMerge: { p50Ms: 8 * M, p90Ms: 8 * M },
      reworkRounds: { p50: 1, p90: 1 },
    });
    expect(day?.stageTimes).toHaveLength(8);
    for (const stage of day?.stageTimes ?? []) expect(stage).toMatchObject({ p50Ms: M, p90Ms: M });
    expect(week).toMatchObject({
      merged: 3,
      openToMerge: { p50Ms: 10 * M, p90Ms: 16 * M },
      reworkRounds: { p50: 1, p90: 1 },
    });
    for (const stage of week?.stageTimes ?? [])
      expect(stage).toMatchObject({ p50Ms: M, p90Ms: 2 * M });
  });
  it("keeps live owners fresh, includes new merges immediately, and expires metrics at window boundaries", () => {
    merged(7, T, M);
    expect(flow(T + 8 * M).metrics[0]?.merged).toBe(1);
    store.upsertRun(run("next", { ticket: "mc#8", branch: "feature/8", startedAt: T + 8 * M }));
    store.setRunLoop("next", { ...NEW_LOOP, phase: "ci", prNumber: 8 }, T + 8 * M + 1);
    store.upsertPullRequests("mc", [pr(8, { createdAt: T + 8 * M })], T + 8 * M);
    expect(flow(T + 8 * M + 2).rows[0]).toMatchObject({ pr: 8, owner: "CI" });
    store.upsertPullRequests(
      "mc",
      [pr(8, { state: "merged", createdAt: T + 8 * M, mergedAt: T + 8 * M + 3 })],
      T + 8 * M + 3,
    );
    expect(flow(T + 8 * M + 4).metrics[0]?.merged).toBe(2);
    expect(flow(T + DAY + 8 * M).metrics[0]?.merged).toBe(2);
    expect(flow(T + DAY + 8 * M + 1).metrics[0]?.merged).toBe(1);
  });
});

describe("PR flow timed wake boundaries", () => {
  it("targets only the PR identity, so another PR's clearance decision cannot settle it", () => {
    const reasons = wakeReasons(
      "{}",
      JSON.stringify({ prFlow: [`7:stage:clearance:${T}`, `8:waiting:controller:${T}`] }),
    );
    expect(reasons.map((r) => r.targets)).toEqual([
      ["7", "#7"],
      ["8", "#8"],
    ]);
  });

  it.each(["operator", "controller"] as const)(
    "schedules and emits stable %s and p90 facts at their boundaries",
    (owner) => {
      const f: FlightPrFlow = {
        generatedAt: T,
        unowned: 0,
        rows: [
          {
            pr: 7,
            ticket: "mc#7",
            title: "held",
            owner,
            stage: "clearance",
            stageSince: T,
            ownerSince: T,
            openSince: T,
            waitsOn: [],
            blocks: [],
            lastAction: "held",
            lastActor: owner,
          },
        ],
        metrics: [
          {
            windowMs: 7 * DAY,
            merged: 1,
            openToMerge: { p50Ms: M, p90Ms: M },
            reworkRounds: { p50: 0, p90: 0 },
            stageTimes: [{ stage: "clearance", p50Ms: M, p90Ms: 10 * M }],
          },
        ],
      };
      expect(prFlowWakeTimes(f)).toEqual([T + 10 * M, T + 15 * M]);
      expect(nextWakeAt({ prFlow: f, planned: [] } as unknown as FlightState, 0, T)).toBe(
        T + 10 * M,
      );
      f.generatedAt = T + 10 * M - 1;
      expect(prFlowFacts(f)).toEqual([]);
      f.generatedAt++;
      expect(prFlowFacts(f)).toEqual([`7:stage:clearance:${T}`]);
      f.generatedAt = T + 15 * M - 1;
      expect(prFlowFacts(f)).toHaveLength(1);
      f.generatedAt++;
      expect(prFlowFacts(f)).toEqual([`7:stage:clearance:${T}`, `7:waiting:${owner}:${T}`]);
      const facts = prFlowFacts(f);
      f.generatedAt += M;
      expect(prFlowFacts(f)).toEqual(facts);
    },
  );
});
