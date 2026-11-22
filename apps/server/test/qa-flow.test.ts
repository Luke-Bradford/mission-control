import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView, Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-qaflow-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pr = (number: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "r1",
  number,
  title: `PR ${number}`,
  url: `https://example.test/${number}`,
  branch: `feature/${number}-x`,
  ticket: null,
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - 5 * DAY,
  mergedAt: NOW - 5 * DAY,
  headSha: `${number}`.padStart(2, "0").repeat(20),
  mergeCommitSha: `${number}`.padStart(2, "1").repeat(20),
  mergeable: null,
  checks: [],
  ...over,
});

const run = (over: Partial<Run>): Run => ({
  id: "run-a",
  agentId: "guido-1",
  repoId: "r1",
  seq: 1,
  startedAt: NOW - 12 * DAY,
  endedAt: NOW - 5 * DAY,
  status: "ok",
  sessionId: null,
  model: "claude-opus",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

describe("review queue age", () => {
  const review = (n: number, created: number, started: number | null, ended: number | null) => {
    const id = store.requestReview({
      authorRunId: `a${n}`,
      repoId: "r1",
      seatId: "retro-1",
      prNumber: n,
      sha: `${n}`.repeat(40),
      epoch: 0,
      attempt: 1,
      round: 1,
      at: created,
    }) as number;
    if (started !== null)
      store.setReviewState(id, ["queued"], "running", { at: started, runId: `v${n}` });
    if (ended !== null)
      store.recordFindings(id, `v${n}`, {
        verdict: { spec: "pass", quality: "pass" },
        summary: "s",
        findings: [],
        at: ended,
      });
    return id;
  };

  it("gives wait and review time per head, and leaves out unfinished ones", () => {
    const t = NOW - DAY;
    const a = review(1, t, t + 60_000, t + 360_000);
    review(2, t, t + 10_000, null);
    review(3, t, null, null);
    const timings = store.qaFlow(NOW - 7 * DAY).reviewTimings;
    expect(timings.heads).toEqual([
      {
        reviewId: a,
        repoId: "r1",
        prNumber: 1,
        sha: "1".repeat(40),
        reviewWaitMs: 60_000,
        reviewMs: 300_000,
      },
    ]);
    expect(timings.wait).toEqual({ n: 1, medianMs: 60_000, p85Ms: 60_000 });
    expect(timings.review.medianMs).toBe(300_000);
  });
});

describe("rework ratio", () => {
  it("counts blocking rounds per author seat and model", () => {
    store.upsertRun(run({ id: "a1", agentId: "guido-1", model: "opus" }));
    store.upsertRun(run({ id: "a2", agentId: "inco-1", model: "sonnet" }));
    const round = (authorRunId: string, n: number, blocking: boolean) => {
      const at = NOW - DAY;
      const id = store.requestReview({
        authorRunId,
        repoId: "r1",
        seatId: "retro-1",
        prNumber: n,
        sha: `${n}`.repeat(40),
        epoch: 0,
        attempt: 1,
        round: 1,
        at,
      }) as number;
      store.setReviewState(id, ["queued"], "running", { at, runId: `v${n}` });
      store.recordFindings(id, `v${n}`, {
        verdict: { spec: blocking ? "fail" : "pass", quality: "pass" },
        summary: "s",
        findings: blocking
          ? [
              {
                severity: "Important",
                file: "a.ts",
                line: 1,
                summary: "x",
                scenario: "y",
                fix: "z",
              },
            ]
          : [],
        at,
      });
    };
    round("a1", 1, true);
    round("a1", 2, false);
    round("a2", 3, false);
    const r = store.qaFlow(NOW - 7 * DAY).rework;
    expect(r.bySeat).toEqual([
      { key: "guido-1", rounds: 2, reworked: 1, ratio: 0.5, enough: false },
      { key: "inco-1", rounds: 1, reworked: 0, ratio: 0, enough: false },
    ]);
    expect(r.byModel.map((g) => g.key)).toEqual(["opus", "sonnet"]);
  });
});

describe("tests per PR", () => {
  it("counts test files added and changed in each merged PR's diff", () => {
    store.upsertPullRequests(
      "r1",
      [
        pr(7, {
          files: [
            { path: "a/test/x.test.ts", changeType: "ADDED" },
            { path: "a/test/y.test.ts", changeType: "MODIFIED" },
            { path: "a/src/x.ts", changeType: "MODIFIED" },
          ],
        }),
        pr(8, {
          state: "open",
          mergedAt: null,
          files: [{ path: "t/a.test.ts", changeType: "ADDED" }],
        }),
      ],
      NOW,
    );
    expect(store.qaFlow(NOW - 30 * DAY).testsPerPr).toEqual([
      { repoId: "r1", prNumber: 7, mergedAt: NOW - 5 * DAY, added: 1, changed: 1 },
    ]);
  });

  it("leaves out a merged PR whose diff was never read", () => {
    store.upsertPullRequests("r1", [pr(7)], NOW);
    expect(store.qaFlow(NOW - 30 * DAY).testsPerPr).toEqual([]);
  });
});
