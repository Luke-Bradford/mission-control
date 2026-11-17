import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixSessionArm, Run, RunLoop, RunTokenAudit } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { fixSessionTrialView } from "../src/fix-session-trial.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const config = (on: boolean) =>
  ({
    crew: { fixSessionTrial: on, worktrees: "/w", maxSeats: 1, sessions: [] },
  }) as unknown as CcConfig;

const audit = (
  peak: number,
  cacheRead: number,
  extra: Partial<RunTokenAudit> = {},
): RunTokenAudit => ({
  calls: 20,
  peakContext: peak,
  medianContext: peak / 2,
  cacheRead,
  cacheWrite: 1000,
  output: 500,
  rewrites: 1,
  rewriteTokens: 25_000,
  readAfterReport: cacheRead / 2,
  bySource: { Read: { added: 100, reread: 1000, events: 1 } },
  byCommand: {},
  ...extra,
});

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-fix-trial-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function seed(
  arm: FixSessionArm,
  i: number,
  over: Omit<Partial<Run>, "loop"> & { loop?: Partial<RunLoop> } = {},
) {
  seq += 1;
  const { loop, ...rest } = over;
  const run: Run = {
    id: `${arm}-${i}`,
    agentId: "guido-1",
    repoId: "repo",
    seq,
    startedAt: NOW - 1_000_000 + seq,
    endedAt: NOW - 500_000,
    status: "ok",
    sessionId: null,
    model: null,
    branch: `b-${arm}-${i}`,
    ticket: `repo#${arm === "fresh" ? 100 + i : 200 + i}`,
    costUsd: 1,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: null,
    loop: {
      fixArm: arm,
      merging: { sha: "a", done: ["merge"] },
      ...loop,
    } as unknown as RunLoop,
    ...rest,
  };
  store.upsertRun(run);
  return run;
}

describe("fixSessionTrialView", () => {
  it("compares the arms over merged runs and names every run that is not merged", () => {
    for (const arm of ["continue", "fresh"] as const) {
      for (let i = 0; i < 10; i++) {
        let over: Parameters<typeof seed>[2] = {};
        if (arm === "continue" && i === 9)
          over = {
            endedAt: null,
            loop: {
              merging: undefined,
              mergeHold: { by: "FLIGHT", reason: "waiting on the deploy", at: 1 },
            },
          };
        if (arm === "fresh" && i === 9) over = { status: "failed", loop: { merging: undefined } };
        const run = seed(arm, i, over);
        // continue runs peak at 100k, fresh at 40k; the held and unmerged ones are far off
        const peak = i === 9 ? 900_000 : arm === "continue" ? 100_000 : 40_000;
        const sessions =
          arm === "fresh"
            ? {
                sessions: [
                  { fresh: true, calls: 5, startContext: 30_000, peakContext: peak, cacheRead: 1 },
                ],
              }
            : {};
        store.saveRunTokenAudit(run.id, NOW, audit(peak, peak * 10, sessions), []);
      }
    }
    const view = fixSessionTrialView(store, config(true));
    expect(view.enabled).toBe(true);
    expect(view.arms.continue).toMatchObject({ assigned: 10, merged: 9 });
    expect(view.arms.fresh).toMatchObject({ assigned: 10, merged: 9 });
    expect(view.arms.continue.incomplete).toEqual([
      { runId: "continue-9", ticket: "repo#209", status: "held", reason: "waiting on the deploy" },
    ]);
    expect(view.arms.fresh.incomplete).toEqual([
      { runId: "fresh-9", ticket: "repo#109", status: "ended-unmerged", reason: "ended failed" },
    ]);
    // medians and totals cover the nine merged runs only
    expect(view.arms.continue.median.peakContext).toBe(100_000);
    expect(view.arms.fresh.median.peakContext).toBe(40_000);
    expect(view.arms.fresh.median.fixStartContext).toBe(30_000);
    expect(view.arms.continue.total.rewrites).toBe(9);
    expect(view.arms.continue.total.reread).toBe(9000);
    expect(view.runs).toHaveLength(20);
    const row = view.runs.find((r) => r.runId === "fresh-0");
    expect(row).toMatchObject({ arm: "fresh", status: "merged" });
    expect(row?.tokens?.readAfterReportShare).toBe(0.5);
  });

  it("counts CI failures, review rounds, wakes, fresh sessions and fallbacks per run", () => {
    seed("fresh", 1, {
      loop: {
        fixSessions: [{ sessionId: "s", at: 1, reason: "ci" }],
        fixFallbacks: [{ at: 2, reason: "boom" }],
      },
    });
    store.claimLine("ci:fresh-1:abc", {
      runId: "fresh-1",
      seatId: "guido-1",
      origin: "engine",
      text: "ci failed",
      at: 1,
    });
    store.addLoopEvent("fresh-1:woken:5", "fresh-1", "back for rework", 5);
    store.addLoopEvent("fresh-1:woken:9", "fresh-1", "back for rework", 9);
    const [row] = fixSessionTrialView(store, config(false)).runs;
    expect(row).toMatchObject({
      ciFailures: 1,
      fixWakes: 2,
      freshSessions: 1,
      fallbacks: 1,
      reviewRounds: 0,
      tokens: null,
    });
  });

  it("takes the true median at an even count, not a rounded one", () => {
    for (const [i, cost, rewrites] of [
      [0, 3.2, 0],
      [1, 3.9, 1],
    ] as const) {
      const run = seed("fresh", i, { costUsd: cost });
      store.saveRunTokenAudit(run.id, NOW, audit(40_000, 400_000, { rewrites }), []);
    }
    const { median } = fixSessionTrialView(store, config(true)).arms.fresh;
    expect(median.costUsd).toBeCloseTo(3.55);
    expect(median.rewrites).toBe(0.5);
  });

  it("is empty with no run in the trial", () => {
    const view = fixSessionTrialView(store, config(false));
    expect(view.enabled).toBe(false);
    expect(view.runs).toEqual([]);
    expect(view.arms.fresh.assigned).toBe(0);
  });
});
