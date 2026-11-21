import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20);
let dir: string;
let store: Store;
let raw: { db: { prepare(sql: string): { run(...a: (string | number | null)[]): unknown } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-model-table-"));
  store = new Store(join(dir, "mc.db"));
  raw = store as unknown as typeof raw;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Run>): Run => ({
  id: "guido-1:1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 10 * DAY,
  endedAt: NOW - 9 * DAY,
  status: "ok",
  sessionId: null,
  model: "sonnet-5.5",
  branch: null,
  ticket: "mc#1",
  costUsd: 2,
  tokens: { input: 10, output: 20, cacheRead: 500, cacheCreate: 30 },
  transcriptPath: "",
  prs: [],
  summary: null,
  loopKind: "build",
  effort: "medium",
  plan: { by: null, at: null, ref: "x" },
  ...over,
});

/** A reported review of `authorRunId`. */
function review(authorRunId: string, round: number, blocking: number, at: number, pr = 9) {
  const id = store.requestReview({
    authorRunId,
    repoId: "mc",
    seatId: "retro",
    prNumber: pr,
    sha: `${round}`.repeat(40),
    epoch: 0,
    attempt: round,
    round,
    at,
  }) as number;
  store.setReviewState(id, ["queued"], "reported", { at });
  raw.db
    .prepare("UPDATE reviews SET blocking = ?, ended_at = ? WHERE id = ?")
    .run(blocking, at, id);
}

describe("modelTableData", () => {
  it("reads a reviewed build run's rounds, blocking, size, merge and ticket tokens", () => {
    store.upsertRun(run({}));
    // another run on the ticket adds its tokens
    store.upsertRun(run({ id: "guido-1:2", seq: 2, loopKind: "review", agentId: "retro" }));
    review("guido-1:1", 1, 2, NOW - 9 * DAY);
    review("guido-1:1", 2, 1, NOW - 8 * DAY);
    raw.db.prepare("INSERT INTO flow_issues (repo_id, number, size) VALUES ('mc', 1, 'S')").run();
    raw.db
      .prepare(
        "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('mc', 9, ?, '{}')",
      )
      .run(NOW - 7 * DAY);
    const data = store.modelTableData(NOW - 30 * DAY, NOW);
    expect(data.rows).toEqual([
      expect.objectContaining({
        runId: "guido-1:1",
        seatId: "guido-1",
        reviewSeatId: "retro",
        ticket: "mc#1",
        model: "sonnet-5.5",
        effort: "medium",
        planned: true,
        size: "S",
        merged: true,
        maxRound: 2,
        blocking: 3,
        costUsd: 2,
        ticketTokens: 120,
        endedAt: NOW - 8 * DAY,
      }),
    ]);
    expect(data.stepUpSince).toBeNull();
    expect(data.seatRuns.map((s) => [s.seatId, s.loop])).toEqual([
      ["guido-1", "build"],
      ["retro", "review"],
    ]);
  });

  it("leaves out a run with no reported review and a Size-waived plan counts as unplanned", () => {
    store.upsertRun(run({ id: "guido-1:3", plan: { skipped: "Size XS" } }));
    expect(store.modelTableData(NOW - 30 * DAY, NOW).rows).toEqual([]);
    review("guido-1:3", 1, 0, NOW - 5 * DAY);
    const [only] = store.modelTableData(NOW - 30 * DAY, NOW).rows;
    expect(only).toMatchObject({ planned: false, merged: false, size: null });
  });

  it("reports when step-up advice began", () => {
    store.setModelAdvice("mc", 1, {
      step: "build",
      model: null,
      effort: "high",
      reason: "r",
      by: "step-up",
      at: NOW - 3 * DAY,
    });
    expect(store.modelTableData(NOW - 30 * DAY, NOW).stepUpSince).toBe(NOW - 3 * DAY);
    // a later planner recommendation replaces the stored advice but not when step-up began
    store.setModelAdvice("mc", 1, {
      step: "build",
      model: "opus-5.5",
      effort: "high",
      reason: "planner",
      by: "planner",
      at: NOW - 1 * DAY,
    });
    expect(store.modelAdvice("mc", 1, "build")?.by).toBe("planner");
    expect(store.modelTableData(NOW - 30 * DAY, NOW).stepUpSince).toBe(NOW - 3 * DAY);
  });
});
