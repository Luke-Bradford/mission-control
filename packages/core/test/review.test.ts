import { describe, expect, it } from "vitest";
import { fillLoopText, RATE_LIMIT_RETRY_MS } from "../src/loop.ts";
import {
  currentReview,
  FIX_TEXT_MAX,
  failedAttempts,
  findingFileOk,
  fixesSent,
  fixText,
  minorLine,
  nextAttempt,
  REVIEW_NUDGE_TEXT,
  REVIEW_RESUME_TEXT,
  REVIEW_RUN_MAX_MS,
  REVIEW_TOKEN_BUDGET,
  type ReviewFact,
  type ReviewFinding,
  type ReviewRunSnapshot,
  reviewRunStep,
} from "../src/review.ts";

describe("findingFileOk", () => {
  it("accepts plain repo-relative paths", () => {
    expect(findingFileOk("apps/server/src/x.ts")).toBe(true);
    expect(findingFileOk("a.ts")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const f of ["/etc/x", "a/../b", "a//b", "a b.ts", "@x/y", "`x`", "a#1"]) {
      expect(findingFileOk(f), f).toBe(false);
    }
  });
});

const fin = (over: Partial<ReviewFinding>): ReviewFinding => ({
  severity: "Important",
  file: "a.ts",
  line: 3,
  summary: "s",
  scenario: "w",
  fix: "f",
  ...over,
});

describe("fixText", () => {
  it("orders and numbers", () => {
    const t = fixText({
      retro: "RETRO",
      sha: "abcdef1234",
      findings: [
        fin({ summary: "a" }),
        fin({ severity: "Critical", summary: "b", line: 0 }),
        fin({ summary: "c" }),
      ],
    });
    expect(t).toContain("RETRO reviewed abcdef1 and found 3 issues to fix");
    expect(t).toContain(
      "1. [Critical] a.ts — b\n   Why: w\n   Fix: f\n\n2. [Important] a.ts:3 — a",
    );
    expect(t.indexOf("3. [Important] a.ts:3 — c")).toBeGreaterThan(t.indexOf("2."));
    expect(t).not.toContain(":0");
  });

  it("caps", () => {
    const findings = Array.from({ length: 50 }, () => fin({ fix: "x".repeat(1900) }));
    const t = fixText({ retro: "RETRO", sha: "abcdef1", findings });
    expect(t.length).toBeLessThanOrEqual(FIX_TEXT_MAX);
    expect(t).toContain("found 50 issues");
    expect(t).toMatch(/…and \d+ more; the next review lists them again\.$/);
  });

  it("skips Minor; singular", () => {
    const t = fixText({
      retro: "RETRO",
      sha: "abcdef1",
      findings: [fin({ severity: "Minor" }), fin({ severity: "Critical" })],
    });
    expect(t).toContain("found 1 issue to fix");
    expect(t).not.toContain("2. ");
  });
});

describe("minorLine", () => {
  it("formats", () => {
    expect(minorLine({ file: "a.ts", line: 0, summary: "s" })).toBe("- `a.ts` — s");
    expect(minorLine({ file: "a.ts", line: 3, summary: "s" })).toBe("- `a.ts:3` — s");
    expect(minorLine({ file: "a.ts", line: 3, summary: "a\n b" })).toBe("- `a.ts:3` — a b");
    const long = minorLine({ file: "a.ts", line: 3, summary: "x".repeat(400) });
    const shown = long.slice("- `a.ts:3` — ".length);
    expect(shown).toHaveLength(300);
    expect(shown.endsWith("…")).toBe(true);
  });
});

const row = (over: Partial<ReviewFact>): ReviewFact => ({
  id: 1,
  sha: "s1",
  epoch: 0,
  attempt: 1,
  state: "reported",
  blocking: 0,
  minor: 0,
  failure: null,
  ...over,
});

describe("review row helpers", () => {
  const rows = [
    row({ id: 1, attempt: 1, state: "failed" }),
    row({ id: 2, attempt: 2, state: "superseded" }),
    row({ id: 3, epoch: 1, attempt: 5, state: "failed" }),
    row({ id: 4, sha: "s2", attempt: 1, state: "running" }),
  ];
  it("currentReview skips superseded rows and other epochs", () => {
    expect(currentReview(rows, 0, "s1")?.id).toBe(1);
    expect(currentReview(rows, 1, "s1")?.id).toBe(3);
    expect(currentReview(rows, 2, "s1")).toBeNull();
  });
  it("failedAttempts and nextAttempt filter by epoch and sha", () => {
    expect(failedAttempts(rows, 0, "s1")).toBe(1);
    expect(failedAttempts(rows, 1, "s1")).toBe(1);
    expect(nextAttempt(rows, 0, "s1")).toBe(3);
    expect(nextAttempt(rows, 1, "s1")).toBe(6);
    expect(nextAttempt(rows, 0, "s9")).toBe(1);
  });
  it("fixesSent counts the run's keys of one epoch", () => {
    const claimed = { "fix:r1:0:1": 1, "fix:r1:0:2": 2, "fix:r1:1:3": 3, "fix:r2:0:4": 4 };
    expect(fixesSent(claimed, "r1", 0)).toBe(2);
    expect(fixesSent(claimed, "r1", 1)).toBe(1);
  });
});

describe("reviewRunStep", () => {
  const base = (
    over: Partial<ReviewRunSnapshot> = {},
    seat: Partial<ReviewRunSnapshot["seat"]> = {},
  ): ReviewRunSnapshot => ({
    reviewRunId: "v1",
    prNumber: 12,
    now: 10_000_000,
    hubStartedAt: 5000,
    startedAt: 9_000_000,
    run: { startedAt: 9_000_000, ended: null, tokens: 0 },
    seat: {
      holdsRun: true,
      starting: false,
      state: "running",
      inTurn: false,
      lastTurnEndedAt: null,
      resumedAt: null,
      rateLimitedUntil: null,
      ...seat,
    },
    claimed: {},
    lastEngineLineAt: null,
    ...over,
  });
  const fail = (reason: string) => ({ kind: "fail", reason });

  it("1: fails when the run ended", () => {
    const run = { startedAt: 1, ended: { reason: "exit" }, tokens: 0 };
    expect(reviewRunStep(base({ run }))).toEqual(fail("the review run ended (exit)"));
  });
  it("2: fails when the seat lost the run, unless it is starting", () => {
    expect(reviewRunStep(base({}, { holdsRun: false }))).toEqual(
      fail("the review run lost its seat"),
    );
    expect(reviewRunStep(base({}, { holdsRun: false, starting: true }))).toBeNull();
  });
  it("3: fails over the token budget", () => {
    const run = { startedAt: 1, ended: null, tokens: REVIEW_TOKEN_BUDGET + 1 };
    expect(reviewRunStep(base({ run }))).toEqual(fail("over its 120000-token budget"));
  });
  it("4: fails after 60 minutes, but not while parked", () => {
    const late = { startedAt: 10_000_000 - REVIEW_RUN_MAX_MS - 1 };
    expect(reviewRunStep(base(late))).toEqual(fail("no findings after 60 minutes"));
    expect(reviewRunStep(base(late, { state: "parked", rateLimitedUntil: 10_000_001 }))).toBeNull();
  });
  it("5: fails when it stopped again after the nudge", () => {
    const s = base({ claimed: { "rv-nudge:v1": 100 } }, { state: "idle", lastTurnEndedAt: 200 });
    expect(reviewRunStep(s)).toEqual(fail("stopped twice without reporting findings"));
  });
  it("6: does nothing in a turn", () => {
    const s = base({}, { inTurn: true, state: "parked", resumedAt: 6000 });
    expect(reviewRunStep(s)).toBeNull();
  });
  it("7: resumes once after a hub restart", () => {
    const s = base({}, { resumedAt: 6000 });
    expect(reviewRunStep(s)).toEqual({
      kind: "send",
      key: "rv-resume:v1:5000",
      text: fillLoopText(REVIEW_RESUME_TEXT, { pr: "12" }),
    });
    expect(reviewRunStep({ ...s, claimed: { "rv-resume:v1:5000": 1 } })).toBeNull();
  });
  it("8: retries after a rate limit", () => {
    const s = base({}, { state: "parked", rateLimitedUntil: 9_999_000 });
    expect(reviewRunStep(s)).toMatchObject({ kind: "send", key: "rv-limit:v1:9999000" });
    expect(reviewRunStep(base({}, { state: "parked", rateLimitedUntil: null }))).toMatchObject({
      key: `rv-limit:v1:${Math.floor(10_000_000 / RATE_LIMIT_RETRY_MS)}`,
    });
    expect(reviewRunStep(base({}, { state: "parked", rateLimitedUntil: 10_500_000 }))).toBeNull();
    expect(reviewRunStep({ ...s, claimed: { "rv-limit:v1:9999000": 1 } })).toBeNull();
  });
  it("9: nudges once when the seat went idle without reporting", () => {
    const idle = { state: "idle", lastTurnEndedAt: 9_500_000 } as const;
    expect(reviewRunStep(base({}, idle))).toEqual({
      kind: "send",
      key: "rv-nudge:v1",
      text: fillLoopText(REVIEW_NUDGE_TEXT, { pr: "12" }),
    });
    expect(reviewRunStep(base({ lastEngineLineAt: 9_600_000 }, idle))).toBeNull();
  });
  it("10: otherwise nothing", () => {
    expect(reviewRunStep(base())).toBeNull();
  });
});
