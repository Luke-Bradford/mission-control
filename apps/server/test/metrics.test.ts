import type { PullRequestView, Run } from "@mc/core";
import { NEW_LOOP } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type MetricsScope, metricsView } from "../src/metrics.ts";
import { overviewSummary } from "../src/overview.ts";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-17T12:00:30Z");
const MIDNIGHT = Date.parse("2026-10-16T23:00:00Z"); // Europe/London, BST
let store: Store;
const scope: MetricsScope = {
  repoIds: ["repo"],
  pipelineRepoIds: ["repo"],
  timezone: "Europe/London",
};
const view = (at = NOW, s: MetricsScope = scope) => metricsView(store, at, s);
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});

const pr = (n: number, extra: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "repo",
  number: n,
  title: `PR ${n}`,
  url: "",
  branch: "b",
  ticket: null,
  state: "merged",
  isDraft: false,
  review: null,
  ci: null,
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - MIN,
  mergedAt: null,
  headSha: null,
  mergeable: null,
  ...extra,
});
const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id,
  agentId: "seat",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: NOW - MIN,
  status: "ok",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP },
  ...extra,
});

it("reads zeros and nulls from an empty store", () => {
  expect(view()).toEqual({
    at: NOW,
    inProgress: { count: 0, oldestAt: null },
    merged: { count: 0, loops: 0 },
    cycleTime: { p50Ms: null, p85Ms: null, n: 0, excluded: 0 },
    cost: { usd: null },
  });
});

it("counts PRs merged in the last 24 hours in the crew's repos; loop repos apart", () => {
  store.replacePullRequests(
    "repo",
    [
      pr(1, { mergedAt: NOW - MIN, ticket: "repo#1" }),
      pr(2, { mergedAt: NOW - 23 * HOUR }), // before local midnight, still inside 24 h
      pr(3, { mergedAt: NOW - DAY }), // exactly 24 h ago: outside
      pr(4, { mergedAt: NOW + MIN }), // the future
      pr(5, { state: "open" }),
    ],
    NOW,
  );
  store.replacePullRequests("other", [pr(6, { repoId: "other", mergedAt: NOW - MIN })], NOW);
  expect(view().merged).toEqual({ count: 2, loops: 0 });
  // "other" is in view but has no crew session: an observed loop's repo
  expect(view(NOW, { ...scope, repoIds: ["repo", "other"] }).merged).toEqual({
    count: 2,
    loops: 1,
  });
});

it("measures cycle time p50 and p85 over 14 days, leaving out tickets with no start", () => {
  const issue = (number: number, hours: number | null, doneAt = NOW - HOUR) => ({
    repoId: "repo",
    number,
    size: null,
    startAt: hours === null ? null : doneAt - hours * HOUR,
    doneAt,
  });
  store.replaceFlow(
    "repo",
    [
      issue(1, 2),
      issue(2, 4),
      issue(3, 6),
      issue(4, 8),
      issue(5, 30),
      issue(6, null),
      { ...issue(7, 1), startAt: NOW }, // out of order
      issue(8, 1, NOW - 15 * DAY), // outside the window
    ],
    [],
  );
  store.replaceFlow("other", [{ ...issue(9, 100), repoId: "other" }], []);
  // 2 4 6 8 30: the median is 6; p85 sits at rank 3.4, 8 + 0.4 × 22.
  const { p85Ms, ...rest } = view().cycleTime;
  expect(rest).toEqual({ p50Ms: 6 * HOUR, n: 5, excluded: 2 });
  expect(p85Ms).toBeCloseTo(16.8 * HOUR);
});

it("sums today's API-equivalent cost in the repos in view, like the Overview's spend", () => {
  store.upsertRun(run("unpriced", { startedAt: NOW - HOUR, endedAt: NOW }));
  // a run that reported no cost leaves the figure unknown, not $0
  expect(view().cost.usd).toBeNull();
  store.upsertRun(run("a", { startedAt: NOW - 2 * HOUR, endedAt: NOW, costUsd: 4 }));
  store.upsertRun(run("b", { startedAt: MIDNIGHT - 2 * HOUR, endedAt: MIDNIGHT, costUsd: 9 }));
  store.upsertRun(run("c", { repoId: "other", costUsd: 5 }));
  expect(view().cost.usd).toBeCloseTo(4);
  const spend = overviewSummary(store, NOW, {
    repoIds: ["repo"],
    timezone: "Europe/London",
    attention: [],
  }).kpis.spendToday.usd;
  expect(view().cost.usd).toBeCloseTo(spend);
});
