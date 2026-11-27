import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_FAILED_EVENT_PREFIX,
  FLIGHT_RED_PR_IDLE_MS,
  type FlightState,
  NEW_LOOP,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightSignals } from "../src/flight/signals.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-27T03:00:00Z");
const MIN = 60_000;
const RUN = "guido-1:r1";
const SHA = "a".repeat(40);

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
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", area: ["apps/server/**"] },
        ],
      },
    ],
  },
} as unknown as CcConfig;
const session = config.crew?.sessions[0];
if (session === undefined) throw new Error("no session");

const seats = [
  { id: "guido-1", loop: "build", free: false, atStop: false, area: [] },
] as unknown as FlightState["seats"];

const run: Run = {
  id: RUN,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 300 * MIN,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: "feature/7-x",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
};
const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mc",
  number: 12,
  title: "t",
  url: "https://github.com/o/mc/pull/12",
  branch: "feature/7-x",
  ticket: "mc#7",
  state: "open",
  isDraft: true,
  review: null,
  ci: "failing",
  createdAt: NOW - 200 * MIN,
  updatedAt: NOW - 200 * MIN,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
  isCrossRepository: false,
  checks: [],
  ...over,
});
const red = () => flightSignals({ config, store, session, seats, now: NOW }).signals;
const redPr = () => red().filter((s) => s.kind === "red_pr_idle");
/** The re-run's failure, recorded `ago` before now, as the loop records it. */
const failed = (ago: number) =>
  store.addLoopEvent(
    `${RUN}:1:2:${CI_FAILED_EVENT_PREFIX}aaaaaaa (failing: studio)`,
    RUN,
    `${CI_FAILED_EVENT_PREFIX}aaaaaaa (failing: studio)`,
    NOW - ago,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-red-pr-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.upsertRun(run);
  store.setRunPush({ runId: RUN, sha: SHA, at: NOW - 200 * MIN });
  store.setRunLoop(
    RUN,
    { ...NEW_LOOP, phase: "working", prNumber: 12, ciFails: 1, ciFailedSha: SHA },
    NOW - 200 * MIN,
  );
  store.upsertPullRequests("mc", [pr()], NOW - MIN);
  // the re-run's own event comes first and does not start the clock
  store.addLoopEvent(
    `${RUN}:rerun:${SHA}`,
    RUN,
    `${CI_FAILED_EVENT_PREFIX}aaaaaaa; re-ran studio-ci`,
    NOW - 100 * MIN,
  );
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a red PR with no seat activity", () => {
  it(`wakes FLIGHT once the re-run's failure is ${FLIGHT_RED_PR_IDLE_MS / MIN} minutes old with nothing from the seat`, () => {
    failed(FLIGHT_RED_PR_IDLE_MS);
    expect(redPr()).toEqual([
      expect.objectContaining({
        key: `${RUN}:${SHA}`,
        since: NOW - FLIGHT_RED_PR_IDLE_MS,
        evidence: expect.stringContaining("PR #12 (mc#7) red on aaaaaaa"),
      }),
    ]);
  });

  it("does not wake FLIGHT before then", () => {
    failed(FLIGHT_RED_PR_IDLE_MS - MIN);
    expect(redPr()).toEqual([]);
  });

  it("counts a commit after the failure as seat activity", () => {
    failed(60 * MIN);
    store.addRunCommit({
      runId: RUN,
      repoId: "mc",
      branch: "feature/7-x",
      sha: "b".repeat(40),
      at: NOW - 10 * MIN,
    });
    expect(redPr()).toEqual([]);
  });

  it("raises nothing for a green PR", () => {
    failed(60 * MIN);
    store.upsertPullRequests("mc", [pr({ ci: "passing" })], NOW);
    expect(redPr()).toEqual([]);
  });

  it("raises nothing for an ended run", () => {
    failed(60 * MIN);
    store.setRunEnded(RUN, NOW, "failed", "engine");
    expect(redPr()).toEqual([]);
  });
});
