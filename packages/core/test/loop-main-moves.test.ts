import { describe, expect, it } from "vitest";
import type { LoopAction, LoopSnapshot } from "../src/loop.ts";
import {
  CI_PENDING_MAX_MS,
  conflictKey,
  conflictText,
  mainConflictText,
  mergedMainText,
  NEW_LOOP,
  reconcile,
} from "../src/loop.ts";
import type { LoopReviewFacts } from "../src/review.ts";
import type { RunLoop } from "../src/types.ts";

const SHA = "aaaaaaa1111";
const SHA2 = "bbbbbbb2222";
const MAIN = "cccccccc3333";
const NOW = 10_000_000;

function snap(over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot {
  return {
    runId: "r1",
    runStartedAt: 1000,
    loop: { ...NEW_LOOP, ...loop },
    ticket: { ref: "owner/repo#7", title: "T", issue: 7 },
    now: NOW,
    tz: "UTC",
    hubStartedAt: 5000,
    seat: {
      call: "SULU",
      state: "idle",
      inTurn: false,
      lastTurnEndedAt: NOW - 1000,
      resumedAt: null,
      rateLimitedUntil: null,
      openQuestion: false,
      holdsRun: true,
    },
    evidence: { id: 1, at: 2000, ruling: false },
    evidenceCount: 1,
    headCommit: SHA,
    pushed: { sha: SHA, at: NOW - 60_000 },
    pr: pr(),
    card: null,
    claimed: {},
    openNotes: [],
    lastEngineLineAt: null,
    tokens: 0,
    budget: 1000,
    ended: null,
    asideOk: true,
    autoMerge: true,
    hardRulesSet: true,
    ...over,
  };
}

const pr = (
  over: Partial<NonNullable<LoopSnapshot["pr"]>> = {},
): NonNullable<LoopSnapshot["pr"]> => ({
  number: 12,
  state: "open",
  headSha: SHA,
  ci: "passing",
  mergeable: "MERGEABLE",
  polledAt: NOW,
  isDraft: true,
  reviewStatus: "passing",
  ...over,
});

const gateOf = (over: Partial<NonNullable<RunLoop["gate"]>> = {}): RunLoop["gate"] => ({
  sha: SHA,
  mainSha: MAIN,
  containsMain: false,
  hubOnly: true,
  strays: [],
  ...over,
});

const reviewed = (blocking = 0): LoopReviewFacts => ({
  retro: "RETRO-1",
  rows: [
    { id: 1, sha: SHA, epoch: 0, attempt: 1, state: "reported", blocking, minor: 0, failure: null },
  ],
  findings: [],
});

/** A merge workspace in review, behind main, its seat idle between turns. */
const behind = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot =>
  snap(
    { review: reviewed(), ...over },
    {
      phase: "review",
      reportedEvidenceId: 1,
      cardFor: "review:0",
      gate: gateOf(),
      touches: { sha: SHA, paths: [] },
      ...loop,
    },
  );

/** The run off its seat: another run holds the seat. */
const aside = (s: LoopSnapshot, wake = false): LoopSnapshot => ({
  ...s,
  loop: { ...s.loop, aside: { worktree: "/w/r1", wake } },
  seat: { ...s.seat, state: "stopped", inTurn: true, holdsRun: false },
});

const kinds = (a: LoopAction[]): string[] => a.map((x) => x.kind);
const sends = (a: LoopAction[]): string[] => a.flatMap((x) => (x.kind === "send" ? [x.key] : []));
const update: LoopAction = { kind: "update-branch", mainSha: MAIN };

describe("main moves", () => {
  it("texts", () => {
    expect(conflictKey("r1", MAIN)).toBe(`conflict:r1:${MAIN}`);
    expect(conflictText(["a.ts", "b.ts"])).toBe(
      "Merging main into your branch conflicted in: a.ts, b.ts. Resolve the conflict markers in those files, keeping what both sides meant, then call mc commit and mc report_evidence.",
    );
    expect(mergedMainText(MAIN)).toBe("merged main ccccccc into the branch");
    expect(mainConflictText(MAIN, 1)).toBe("merging main ccccccc conflicted in 1 file");
    expect(mainConflictText(MAIN, 2)).toBe("merging main ccccccc conflicted in 2 files");
  });

  it("behind main only: merge without updating the branch", () => {
    const a = reconcile(behind()).actions;
    expect(kinds(a)).not.toContain("update-branch");
    expect(a).toContainEqual({ kind: "merge", sha: SHA });
    expect(kinds(a)).toContain("mark-ready");
  });

  it("hard-rule paths behind main do not update without a conflict", () => {
    const s = behind(
      {},
      { touches: { sha: SHA, paths: ["a/x.ts"] }, gate: gateOf({ strays: ["a/x.ts"] }) },
    );
    expect(kinds(reconcile(s).actions)).not.toContain("update-branch");
  });

  it("a conflicting PR in review updates to main", () => {
    const a = reconcile(behind({ pr: pr({ mergeable: "CONFLICTING" }) })).actions;
    expect(a).toContainEqual(update);
    expect(kinds(a)).not.toContain("merge");
    expect(kinds(a)).not.toContain("mark-ready");
  });

  it("hard-rule paths on a conflicting PR do not raise a ready note", () => {
    const s = behind(
      { pr: pr({ mergeable: "CONFLICTING" }) },
      { touches: { sha: SHA, paths: ["a/x.ts"] }, gate: gateOf({ strays: ["a/x.ts"] }) },
    );
    const a = reconcile(s).actions;
    expect(a).toContainEqual(update);
    expect(a.some((x) => x.kind === "note" && x.noteKind === "ready")).toBe(false);
  });

  it("not while the seat is in a turn or not idle", () => {
    const b = behind({ pr: pr({ mergeable: "CONFLICTING" }) });
    for (const seatOver of [{ inTurn: true }, { state: "running" as const }]) {
      const a = reconcile({ ...b, seat: { ...b.seat, ...seatOver } }).actions;
      expect(kinds(a)).not.toContain("update-branch");
    }
  });

  it("not in a draft workspace", () => {
    expect(
      kinds(reconcile(behind({ autoMerge: false, pr: pr({ mergeable: "CONFLICTING" }) })).actions),
    ).not.toContain("update-branch");
  });

  it("not while a fix is due: the fix line goes instead", () => {
    const r = reconcile(behind({ review: reviewed(1), pr: pr({ mergeable: "CONFLICTING" }) }));
    expect(kinds(r.actions)).not.toContain("update-branch");
    expect(sends(r.actions)).toEqual(["fix:r1:0:1"]);
  });

  it("not while the head is not the pushed sha", () => {
    expect(
      kinds(reconcile(behind({ headCommit: SHA2, pr: pr({ mergeable: "CONFLICTING" }) })).actions),
    ).not.toContain("update-branch");
  });

  it("not with strays outside the hard rules", () => {
    const s = behind(
      { pr: pr({ mergeable: "CONFLICTING" }) },
      { gate: gateOf({ strays: ["x/y.ts"] }) },
    );
    expect(kinds(reconcile(s).actions)).not.toContain("update-branch");
  });

  it("not once the branch contains main, or with no gate", () => {
    const has = behind(
      { pr: pr({ mergeable: "CONFLICTING" }) },
      { gate: gateOf({ containsMain: true }) },
    );
    expect(kinds(reconcile(has).actions)).not.toContain("update-branch");
    expect(
      kinds(reconcile(behind({ pr: pr({ mergeable: "CONFLICTING" }) }, { gate: null })).actions),
    ).not.toContain("update-branch");
  });

  it("a conflicting aside run updates, and stays aside", () => {
    const r = reconcile(aside(behind({ pr: pr({ mergeable: "CONFLICTING" }) })));
    expect(r.actions).toContainEqual(update);
    expect(kinds(r.actions)).not.toContain("merge");
    expect(kinds(r.actions)).not.toContain("mark-ready");
    expect(r.loop.aside).toEqual({ worktree: "/w/r1", wake: false });
  });

  it("a conflicting PR in ci, in a merge workspace: stays in ci and updates", () => {
    const s = behind(
      { pr: pr({ mergeable: "CONFLICTING", ci: "pending" }) },
      { phase: "ci", cardFor: "ci:0", pushStartedAt: NOW - 120_000, pushFor: SHA },
    );
    const r = reconcile(s);
    expect(r.loop.phase).toBe("ci");
    expect(r.loop.parked).toBeNull();
    expect(r.actions).toContainEqual(update);
  });

  it("a conflicting PR in ci still parks in a draft workspace, or with a merge under way", () => {
    const ci = { phase: "ci" as const, cardFor: "ci:0", pushStartedAt: NOW - 120_000 };
    const conflicting = pr({ mergeable: "CONFLICTING" });
    const merging = { mainSha: MAIN, files: ["a.ts"] };
    for (const s of [
      behind({ autoMerge: false, pr: conflicting }, ci),
      behind({ pr: conflicting }, { ...ci, mainMerge: merging }),
    ]) {
      expect(reconcile(s).loop.parked).toEqual({
        kind: "conflict",
        reason: "PR #12 conflicts with main",
        ended: false,
      });
    }
  });

  it("a conflicting PR in ci with no gate yet: stays in ci, no update", () => {
    const s = behind(
      { pr: pr({ mergeable: "CONFLICTING" }) },
      { phase: "ci", cardFor: "ci:0", pushStartedAt: NOW - 120_000, gate: null },
    );
    const r = reconcile(s);
    expect(r.loop.phase).toBe("ci");
    expect(r.loop.parked).toBeNull();
    expect(kinds(r.actions)).not.toContain("update-branch");
  });

  it("a conflicting PR in ci with no gate parks once CI could have stayed pending that long", () => {
    const s = behind(
      {
        pr: pr({ mergeable: "CONFLICTING" }),
        pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS - 1 },
      },
      { phase: "ci", cardFor: "ci:0", pushStartedAt: NOW - CI_PENDING_MAX_MS - 1, gate: null },
    );
    expect(reconcile(s).loop.parked).toEqual({
      kind: "conflict",
      reason: "PR #12 conflicts with main",
      ended: false,
    });
  });

  describe("a conflicted merge waits on the seat", () => {
    const merging = { mainSha: MAIN, files: ["a.ts", "b.ts"] };
    const working = (over: Partial<LoopSnapshot> = {}): LoopSnapshot =>
      behind(over, { phase: "working", cardFor: "working:0", mainMerge: merging });

    it("sends the conflict line once", () => {
      const s = working();
      const r = reconcile(s);
      expect(r.loop.phase).toBe("working");
      expect(r.actions).toContainEqual({
        kind: "send",
        key: `conflict:r1:${MAIN}`,
        text: conflictText(["a.ts", "b.ts"]),
      });
      expect(kinds(r.actions)).not.toContain("update-branch");
      const claimed = reconcile({ ...s, claimed: { [`conflict:r1:${MAIN}`]: NOW } });
      expect(sends(claimed.actions)).not.toContain(`conflict:r1:${MAIN}`);
    });

    it("does not send it in a turn", () => {
      const s = working();
      expect(sends(reconcile({ ...s, seat: { ...s.seat, inTurn: true } }).actions)).toEqual([]);
    });

    it("wakes an aside run", () => {
      const r = reconcile(aside(working()));
      expect(r.loop.aside).toEqual({ worktree: "/w/r1", wake: true });
      expect(kinds(r.actions)).toContain("wake");
    });

    it("a report moves it to ci and clears it", () => {
      const r = reconcile(
        working({
          headCommit: SHA2,
          evidence: { id: 2, at: NOW - 10, ruling: false },
          evidenceCount: 2,
        }),
      );
      expect(r.loop.phase).toBe("ci");
      expect(r.loop.mainMerge).toBeNull();
      expect(r.loop.pushFor).toBe(SHA2);
    });

    it("the copy shares nothing with the input", () => {
      const s = working();
      const r = reconcile(s);
      expect(r.loop.mainMerge).toEqual(merging);
      expect(r.loop.mainMerge?.files).not.toBe(merging.files);
    });
  });
});
