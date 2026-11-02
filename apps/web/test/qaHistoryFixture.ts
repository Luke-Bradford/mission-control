import type { QaHistoryEntry, QaHistoryPage, QaNativeHistory } from "@mc/core";
import { qaReportFixture } from "./qaReportFixture.ts";

const r = qaReportFixture();
export function qaHistoryFixture(count = 3): QaHistoryPage {
  return {
    entries: Array.from(
      { length: count },
      (_, i): QaHistoryEntry => ({
        key: i % 2 ? `n:${i + 1}` : `r:${(i + 1).toString(16).padStart(64, "0")}`,
        kind: i % 2 ? "native" : "report",
        source: i % 2 ? "native" : "controller",
        repoId: "mission-control",
        prNumber: r.prNumber + i,
        headSha: (i + 1).toString(16).padStart(40, "a"),
        title: i % 2 ? `Native review · round ${i + 1}` : r.prTitle,
        reviewer: { id: `reviewer-${i}`, label: i % 2 ? "RETRO-2" : "Independent reviewer" },
        reviewedAt: i === 1 ? null : r.reviewedAt,
        recordedAt: r.registeredAt - i * 1000,
        state: i === 1 ? "failed" : "saved",
        verdict: i === 1 ? null : r.verdict,
        evidence: i % 2 ? "legacy" : "complete",
        ci: i % 2 ? "unavailable" : "passing",
        visual: i % 2 ? "unknown" : "required",
        pairCount: i % 2 ? 0 : 4,
        screenshotCount: i % 2 ? 1 : 0,
        permalink:
          i % 2 ? `/qa?view=history&native=${i + 1}&identity=${"d".repeat(64)}` : r.permalink,
      }),
    ),
    repositories: [{ id: "mission-control" }, { id: "sample" }],
    limit: 50,
    nextCursor: count === 50 ? "fixture-next-cursor" : null,
    limitations: [
      "Retained saved reports and completed native records only. Older records and images may have been pruned. Historical verdicts do not approve a newer head.",
    ],
  };
}
export function nativeQaFixture(): QaNativeHistory {
  const entry = qaHistoryFixture(2).entries[1];
  return {
    entry,
    prUrl: "https://github.com/o/mc/pull/1012",
    headUrl: `https://github.com/o/mc/commit/${entry.headSha}`,
    review: {
      id: 2,
      authorRunId: "author-2",
      repoId: entry.repoId,
      seatId: entry.reviewer.id,
      prNumber: entry.prNumber,
      sha: entry.headSha,
      epoch: 1,
      attempt: 1,
      round: 2,
      state: "failed",
      runId: "review-2",
      verdict: null,
      summary: null,
      blocking: 0,
      minor: 0,
      failure: "No verdict recorded before the review ended.",
      createdAt: entry.recordedAt - 1000,
      startedAt: entry.recordedAt - 500,
      endedAt: entry.recordedAt,
    },
    findings: [],
    coverage: [],
    tests: [{ command: "pnpm test", file: null, passed: 2, failed: 1, skipped: 0, duration: 24 }],
    screenshots: [
      {
        id: "fixture-shot",
        label: "Recorded browser check",
        width: 1600,
        theme: "dark",
        at: entry.recordedAt,
      },
    ],
    limitations: [
      "Original stored record, not an immutable saved report. No historical CI snapshot or immutable before/after archive.",
      "Test counts are reviewer-reported. Recorded screenshots may have expired.",
    ],
  };
}
