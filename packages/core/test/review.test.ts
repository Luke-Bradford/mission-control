import { describe, expect, it } from "vitest";
import { fillLoopText, RATE_LIMIT_RETRY_MS } from "../src/loop.ts";
import {
  CODEX_REVIEW_TOKEN_BUDGET,
  carriedFrom,
  currentReview,
  FIX_TEXT_MAX,
  failedAttempts,
  findingFileOk,
  fixCommsText,
  fixesSent,
  fixText,
  isReviewBudgetFailure,
  minorLine,
  nextAttempt,
  parseMinorFindings,
  REVIEW_NUDGE_TEXT,
  REVIEW_RESUME_TEXT,
  REVIEW_RUN_MAX_MS,
  REVIEW_TOKEN_BUDGET,
  type ReviewFact,
  type ReviewFinding,
  type ReviewRunSnapshot,
  reviewBudgetFailure,
  reviewDepth,
  reviewFor,
  reviewParkText,
  reviewRunStep,
  reviewStatusOf,
  reviewTokenBudgetOf,
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
  it("lists actionable findings for the author", () => {
    const t = fixText({
      retro: "RETRO",
      sha: "abcdef1234",
      findings: [
        fin({ summary: "a" }),
        fin({ severity: "Critical", summary: "b", line: 0 }),
        fin({ summary: "c" }),
      ],
    });
    expect(t).toContain("1. [Critical] a.ts — b");
    expect(t).toContain("2. [Important] a.ts:3 — a");
    expect(t).toContain("3. [Important] a.ts:3 — c");
  });

  it("bounds a long author fix list", () => {
    const findings = Array.from({ length: 50 }, () => fin({ fix: "x".repeat(1900) }));
    const t = fixText({ retro: "RETRO", sha: "abcdef1", findings });
    expect(t.length).toBeLessThanOrEqual(FIX_TEXT_MAX);
    expect(t).toContain("…and");
  });

  it("skips Minor; singular", () => {
    const t = fixText({
      retro: "RETRO",
      sha: "abcdef1",
      findings: [fin({ severity: "Minor" }), fin({ severity: "Critical" })],
    });
    expect(t).toContain("[Critical]");
    expect(t).not.toContain("Minor");
  });
});

describe("fixCommsText", () => {
  it("counts severities and points to the structured findings", () => {
    expect(
      fixCommsText({
        retro: "RETRO",
        sha: "abcdef1234",
        findings: [
          fin({ summary: "a" }),
          fin({ severity: "Critical", summary: "b" }),
          fin({ severity: "Minor", summary: "c" }),
          fin({ severity: "Minor", summary: "d" }),
          fin({ severity: "Minor", summary: "e" }),
        ],
      }),
    ).toBe(
      "RETRO reviewed abcdef1: 1 Critical, 1 Important, 3 Minor.\nFindings are in RETRO's report_findings record; address Critical and Important findings, then report_evidence.",
    );
  });
});

describe("reviewParkText", () => {
  it("gives FLIGHT both sides' last words, including each finding's reason", () => {
    const t = reviewParkText("RETRO", "abcdef1234", 3, {
      developer: "The guard already covers this path.",
      findings: [
        fin({
          summary: "The guard is bypassed",
          scenario: "A symlink skips it",
          fix: "Check links",
        }),
        fin({
          summary: "The test misses it",
          scenario: "Only files are covered",
          fix: "Add a link test",
        }),
      ],
    });
    expect(t).toContain("Developer's last reply: The guard already covers this path.");
    expect(t).toContain(
      "RETRO's last findings: The guard is bypassed\nWhy: A symlink skips it\nSuggested fix: Check links\n\nThe test misses it\nWhy: Only files are covered\nSuggested fix: Add a link test",
    );
  });

  it("caps the complete RETRO findings section at 1000 characters", () => {
    const t = reviewParkText("RETRO", "abcdef1234", 3, {
      developer: "reply",
      findings: [
        fin({ summary: "s".repeat(250), scenario: "w".repeat(800), fix: "f".repeat(500) }),
      ],
    });
    const section = t.slice(t.indexOf("RETRO's last findings:"));
    expect(section.length).toBeLessThanOrEqual(1000);
    expect(section).toContain("Why:");
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
    tokenBudget: REVIEW_TOKEN_BUDGET,
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
  it("3: a run over 120000 passes under its own budget and fails over it", () => {
    const tokenBudget = reviewTokenBudgetOf("codex");
    expect(tokenBudget).toBeGreaterThan(REVIEW_TOKEN_BUDGET);
    const under = { startedAt: 1, ended: null, tokens: REVIEW_TOKEN_BUDGET + 1 };
    expect(reviewRunStep(base({ run: under, tokenBudget }))).toBeNull();
    const over = { startedAt: 1, ended: null, tokens: tokenBudget + 1 };
    expect(reviewRunStep(base({ run: over, tokenBudget }))).toEqual(
      fail(reviewBudgetFailure(tokenBudget)),
    );
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

describe("reviewStatusOf", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const fact = (o: Partial<ReviewFact>): ReviewFact => ({
    id: 1,
    sha: A,
    epoch: 0,
    attempt: 1,
    state: "queued",
    blocking: 0,
    minor: 0,
    failure: null,
    ...o,
  });

  it("no current row: null", () => {
    for (const rows of [
      [],
      [fact({ state: "superseded" })],
      [fact({ epoch: 1 })],
      [fact({ sha: B })],
    ]) {
      expect(reviewStatusOf(rows, 0, A, null)).toBeNull();
    }
  });

  it("queued and starting: pending queued", () => {
    for (const state of ["queued", "starting"] as const) {
      expect(reviewStatusOf([fact({ state })], 0, A, null)).toEqual({
        state: "pending",
        description: "QA review queued",
      });
    }
  });

  it("running: pending running", () => {
    expect(reviewStatusOf([fact({ state: "running" })], 0, A, null)).toEqual({
      state: "pending",
      description: "QA review running",
    });
  });

  it("reported clean: success", () => {
    expect(reviewStatusOf([fact({ state: "reported", minor: 2 })], 0, A, null)).toEqual({
      state: "success",
      description: "QA review passed",
    });
  });

  it("reported blocking: failure", () => {
    expect(reviewStatusOf([fact({ state: "reported", blocking: 1 })], 0, A, null)).toEqual({
      state: "failure",
      description: "QA review found blocking issues",
    });
  });

  it("failed: null", () => {
    expect(reviewStatusOf([fact({ state: "failed" })], 0, A, null)).toBeNull();
  });

  it("waived wins", () => {
    const rows = [fact({ state: "reported", blocking: 3 })];
    expect(reviewStatusOf(rows, 0, A, A)).toEqual({
      state: "success",
      description: "QA review waived by the operator",
    });
    expect(reviewStatusOf(rows, 0, A, B)).toEqual({
      state: "failure",
      description: "QA review found blocking issues",
    });
  });

  it("carriedFrom needs the carry to end at sha, and a from that is not waived", () => {
    expect(carriedFrom({ from: A, to: B }, null, B)).toBe(A);
    expect(carriedFrom({ from: A, to: B }, undefined, B)).toBe(A);
    expect(carriedFrom({ from: A, to: B }, A, B)).toBeNull();
    expect(carriedFrom({ from: A, to: B }, null, A)).toBeNull();
    expect(carriedFrom({ from: A, to: A }, null, A)).toBeNull();
    expect(carriedFrom(null, null, B)).toBeNull();
  });

  it("reviewFor prefers its own row and does not carry a failed one", () => {
    expect(reviewFor([fact({ state: "reported" })], 0, B, A)?.sha).toBe(A);
    expect(reviewFor([fact({ state: "reported" }), fact({ id: 2, sha: B })], 0, B, A)?.id).toBe(2);
    expect(reviewFor([fact({ state: "failed" })], 0, B, A)).toBeNull();
    expect(reviewFor([fact({ state: "reported" })], 0, B, null)).toBeNull();
  });

  it("a carried review keeps its verdict and names the reviewed sha", () => {
    expect(reviewStatusOf([fact({ state: "reported" })], 0, B, null, A)).toEqual({
      state: "success",
      description: "QA review passed (carried from aaaaaaa, main merged)",
    });
    expect(reviewStatusOf([fact({ state: "reported", blocking: 1 })], 0, B, null, A)).toEqual({
      state: "failure",
      description: "QA review found blocking issues (carried from aaaaaaa, main merged)",
    });
  });
});

describe("reviewDepth", () => {
  it("is light for a small size or a small label", () => {
    expect(reviewDepth({ labels: [], size: "XS" })).toBe("light");
    expect(reviewDepth({ labels: [], size: "S" })).toBe("light");
    for (const label of ["chore", "test", "docs"]) {
      expect(reviewDepth({ labels: [label], size: null })).toBe("light");
    }
  });

  it("is full otherwise, and full wins where the rules overlap", () => {
    expect(reviewDepth({ labels: [], size: "M" })).toBe("full");
    expect(reviewDepth({ labels: ["docs"], size: "M" })).toBe("full");
    expect(reviewDepth({ labels: ["bug"], size: "S" })).toBe("full");
    expect(reviewDepth({ labels: ["type:feature"], size: "XS" })).toBe("full");
    expect(reviewDepth({ labels: [], size: null })).toBe("full");
  });
});

describe("parseMinorFindings", () => {
  it("keeps the writer's list lines verbatim and stops at the next section", () => {
    expect(
      parseMinorFindings(
        "## Minor findings (logged, not looped)\n\nRETRO reviewed.\n- `a.ts:2` — Keep this.\n- …and 2 more in Mission Control\n\n## Tests\n- Passed",
      ),
    ).toEqual(["- `a.ts:2` — Keep this.", "- …and 2 more in Mission Control"]);
    expect(parseMinorFindings("## Tests\n- Passed")).toEqual([]);
  });
});

describe("reviewTokenBudgetOf", () => {
  it("is the account's own budget, else the vendor's default", () => {
    expect(reviewTokenBudgetOf("claude")).toBe(REVIEW_TOKEN_BUDGET);
    expect(reviewTokenBudgetOf("codex")).toBe(CODEX_REVIEW_TOKEN_BUDGET);
    expect(reviewTokenBudgetOf("codex", 90_000)).toBe(90_000);
  });
  it("isReviewBudgetFailure matches only the budget failure text", () => {
    expect(isReviewBudgetFailure(reviewBudgetFailure(250_000))).toBe(true);
    expect(isReviewBudgetFailure("the review run ended (exit)")).toBe(false);
    expect(isReviewBudgetFailure(null)).toBe(false);
  });
});
