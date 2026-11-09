import type { ReviewRow, StoredFinding } from "@mc/core";
import { describe, expect, it } from "vitest";
import { openOlderFindings } from "../src/older-findings.ts";

const review = (
  id: number,
  sha: string,
  blocking: number,
  state = "reported",
  authorRunId = "crew-run",
): ReviewRow =>
  ({ id, sha, blocking, state, authorRunId, repoId: "mc", prNumber: 10 }) as ReviewRow;
const finding = (pos: number, over: Partial<StoredFinding> = {}): StoredFinding => ({
  pos,
  severity: "Critical",
  file: "a.ts",
  line: 1,
  summary: `f${pos}`,
  scenario: "w",
  fix: "x",
  state: "open",
  ...over,
});

function store(reviews: ReviewRow[], findings: Record<number, StoredFinding[]>) {
  return {
    reviewsOfPr: () => reviews,
    findingsOf: (id: number) => findings[id] ?? [],
  };
}
const target = { id: 9, repoId: "mc", prNumber: 10, sha: "new", authorRunId: "ext" };

describe("openOlderFindings", () => {
  it("lists open blocking findings of earlier reviews, with their review and head", () => {
    const s = store([review(1, "old", 1)], {
      1: [finding(0), finding(1, { severity: "Minor", state: "logged" })],
    });
    expect(openOlderFindings(s, target, null)).toEqual([
      { reviewId: 1, sha: "old", finding: finding(0) },
    ]);
  });

  it("leaves out resolved findings, the external review's own same-head attempts, unreported reviews and later reviews", () => {
    const s = store(
      [
        review(1, "old", 1),
        review(2, "new", 1, "reported", "ext"),
        review(3, "x", 1, "failed"),
        review(10, "y", 1),
      ],
      {
        1: [finding(0, { resolution: "fixed" })],
        2: [finding(0)],
        3: [finding(0)],
        10: [finding(0)],
      },
    );
    expect(openOlderFindings(s, target, null)).toEqual([]);
  });

  it("lists a crew review's findings on the very head under review", () => {
    const s = store([review(1, "new", 1)], { 1: [finding(0)] });
    expect(openOlderFindings(s, target, null)).toEqual([
      { reviewId: 1, sha: "new", finding: finding(0) },
    ]);
  });

  it("drops everything before the last clean review, which may be the previous review", () => {
    const s = store([review(1, "old", 1), review(2, "mid", 0), review(3, "mid2", 1)], {
      1: [finding(0)],
      3: [finding(0)],
    });
    expect(openOlderFindings(s, target, 2).map((o) => o.reviewId)).toEqual([3]);
    expect(openOlderFindings(s, target, 3)).toEqual([]);
  });

  it("leaves out the previous review's own findings", () => {
    const s = store([review(1, "old", 1), review(2, "mid", 1)], {
      1: [finding(0)],
      2: [finding(1)],
    });
    expect(openOlderFindings(s, target, 2).map((o) => o.reviewId)).toEqual([1]);
  });
});
