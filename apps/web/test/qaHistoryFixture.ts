import type { QaHistoryEntry, QaHistoryPage, QaNativeHistory } from "@mc/core";
import { qaReportFixture } from "./qaReportFixture.ts";

/** Each index row and its linked detail share the same fictional repo/PR/head/reviewer. */
export function qaHistorySavedReport(index = 0) {
  const r = qaReportFixture();
  if (index === 0) return r;
  const id = (index + 1).toString(16).padStart(64, "0");
  const headSha = (index + 1).toString(16).padStart(8, "0").repeat(5);
  const prNumber = r.prNumber + index;
  return {
    ...r,
    id,
    headSha,
    prNumber,
    prUrl: `https://github.com/o/mc/pull/${prNumber}`,
    reviewer: { id: `reviewer-${index}`, label: "Independent reviewer" },
    ci: { ...r.ci, headSha },
    permalink: `/qa?repo=${r.repoId}&pr=${prNumber}&report=${id}`,
  };
}
export function qaHistoryFixture(count = 3): QaHistoryPage {
  const r = qaReportFixture();
  return {
    entries: Array.from({ length: count }, (_, i): QaHistoryEntry => {
      const report = qaHistorySavedReport(i);
      const native = i % 2 === 1;
      return {
        key: native ? `n:${i + 1}` : `r:${report.id}`,
        kind: native ? "native" : "report",
        source: native ? "native" : "controller",
        repoId: report.repoId,
        prNumber: report.prNumber,
        headSha: report.headSha,
        title: native ? `Native review · round ${i + 1}` : report.prTitle,
        reviewer: native ? { id: `retro-${i + 1}`, label: `RETRO-${i + 1}` } : report.reviewer,
        reviewedAt: i === 1 ? null : r.reviewedAt,
        recordedAt: r.registeredAt - i * 1000,
        state: native ? (i === 1 ? "failed" : "reported") : "saved",
        verdict: i === 1 ? null : report.verdict,
        evidence: native ? "legacy" : "complete",
        ci: native ? "unavailable" : "passing",
        visual: native ? "unknown" : "required",
        pairCount: native ? 0 : report.visual.pairs.length,
        screenshotCount: native ? 1 : 0,
        permalink: native
          ? `/qa?view=history&native=${i + 1}&identity=${"d".repeat(64)}`
          : report.permalink,
      };
    }),
    repositories: [{ id: "mission-control" }, { id: "sample" }],
    limit: 50,
    nextCursor: count === 50 ? "fixture-next-cursor" : null,
    limitations: [
      "Retained saved reports and completed native records only. Older records and images may have been pruned. Historical verdicts do not approve a newer head.",
    ],
  };
}
export function nativeQaFixture(index = 1): QaNativeHistory {
  const entry = qaHistoryFixture(index + 1).entries[index];
  if (entry.kind !== "native") throw new Error("Choose a native fixture entry");
  return {
    entry,
    prUrl: `https://github.com/o/mc/pull/${entry.prNumber}`,
    headUrl: `https://github.com/o/mc/commit/${entry.headSha}`,
    review: {
      id: index + 1,
      authorRunId: `author-${index + 1}`,
      repoId: entry.repoId,
      seatId: entry.reviewer.id,
      prNumber: entry.prNumber,
      sha: entry.headSha,
      epoch: 1,
      attempt: 1,
      round: index + 1,
      state: entry.state === "failed" ? "failed" : "reported",
      runId: `review-${index + 1}`,
      verdict: entry.verdict,
      summary: entry.verdict ? "Original fictional review summary." : null,
      blocking: 0,
      minor: 0,
      failure: entry.verdict ? null : "No verdict recorded before the review ended.",
      createdAt: entry.recordedAt - 1000,
      startedAt: entry.recordedAt - 500,
      endedAt: entry.recordedAt,
    },
    findings: [],
    coverage: [],
    tests: [
      {
        command: "pnpm test",
        file: null,
        passed: entry.verdict ? 3 : 2,
        failed: entry.verdict ? 0 : 1,
        skipped: 0,
        duration: 24,
      },
    ],
    screenshots: [
      {
        id: "f".repeat(32),
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
export function qaHistoryApi(count = 3): Record<string, unknown> {
  const page = qaHistoryFixture(count);
  const api: Record<string, unknown> = { "/api/qa/history?limit=50": page };
  for (let i = 0; i < count; i++) {
    if (page.entries[i].kind === "report") {
      const report = qaHistorySavedReport(i);
      api[`/api/qa-reports/${report.id}`] = report;
    } else api[`/api/qa/history/native/${i + 1}?identity=${"d".repeat(64)}`] = nativeQaFixture(i);
  }
  return api;
}
