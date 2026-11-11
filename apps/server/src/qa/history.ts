import type { QaHistoryPage, QaNativeHistory } from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { qaNativeIdentity } from "./history-key.ts";

const LIMITATIONS = [
  "History covers retained saved reports and completed native review records, including older heads and merged or closed PRs. It is not current deployment readiness.",
  "Native records predating saved reports remain subject to review retention. Already pruned reviews cannot be recovered here; an empty history does not mean no review ever occurred.",
];
const LEGACY_LIMITATIONS = [
  "This is an original stored native review record, not an immutable saved report. Findings show their currently retained resolution state.",
  "No historical CI snapshot or immutable before/after archive was saved with this record. Current CI is not substituted for past CI.",
  "Test counts are reviewer-reported, separate from any retained hub command records. Hub records keep their own timestamps and limits; they are not an immutable review snapshot. Missing coverage and unknown verdicts are not a pass.",
  "Recorded screenshots may have expired. Opening one checks availability; it does not recreate or retain missing bytes.",
];

export function qaHistoryPage(
  store: Store,
  config: CcConfig,
  query: { repoId?: unknown; cursor?: unknown; limit?: unknown },
): QaHistoryPage | null {
  if (
    (query.repoId !== undefined &&
      (typeof query.repoId !== "string" || !config.repos.some((r) => r.id === query.repoId))) ||
    (query.limit !== undefined &&
      (typeof query.limit !== "string" || !/^(?:[1-9]|[1-4]\d|50)$/.test(query.limit)))
  )
    return null;
  let cursor: { at: number; key: string } | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 256) return null;
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      if (
        !Number.isSafeInteger(decoded.at) ||
        decoded.at < 0 ||
        typeof decoded.key !== "string" ||
        !/^(r:[a-f0-9]{64}|n:[1-9]\d*)$/.test(decoded.key)
      )
        return null;
      cursor = { at: decoded.at, key: decoded.key };
    } catch {
      return null;
    }
  }
  const limit = Number(query.limit ?? 50);
  const repos = config.repos.filter((r) => query.repoId === undefined || r.id === query.repoId);
  const rows = store.qaHistory(
    repos.map((r) => r.id),
    limit + 1,
    cursor,
  );
  const entries = rows.slice(0, limit);
  const last = entries.at(-1);
  return {
    entries,
    repositories: config.repos.map((r) => ({ id: r.id })),
    limit,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ at: last.recordedAt, key: last.key })).toString("base64url")
        : null,
    limitations: LIMITATIONS,
  };
}

export function qaNativeHistory(
  store: Store,
  config: CcConfig,
  id: number,
  identity: string,
): QaNativeHistory | null {
  const review = store.review(id);
  if (
    !review ||
    qaNativeIdentity(review) !== identity ||
    !config.repos.some((r) => r.id === review.repoId) ||
    !["reported", "failed", "superseded"].includes(review.state)
  )
    return null;
  const repo = config.repos.find((r) => r.id === review.repoId);
  if (!repo) return null;
  const run = review.runId ? store.run(review.runId) : null;
  // Do not materialize, register, or fetch fresh CI for historical records on a read.
  return {
    entry: {
      key: `n:${review.id}`,
      kind: "native",
      source: "native",
      repoId: review.repoId,
      prNumber: review.prNumber,
      headSha: review.sha,
      title: `Native review · round ${review.round}`,
      reviewer: {
        id: review.seatId,
        label: review.seatId,
        ...(run?.model ? { model: run.model } : {}),
      },
      reviewedAt: review.state === "reported" ? review.endedAt : null,
      recordedAt: review.endedAt ?? review.createdAt,
      state: review.state,
      verdict: review.verdict,
      evidence: "legacy",
      ci: "unavailable",
      visual: "unknown",
      pairCount: 0,
      screenshotCount: store.reviewShots(id).length,
      permalink: `/qa?view=history&native=${id}&identity=${identity}`,
    },
    review,
    prUrl: `https://github.com/${repo.github}/pull/${review.prNumber}`,
    headUrl: /^[a-f0-9]{40}$/.test(review.sha)
      ? `https://github.com/${repo.github}/commit/${review.sha}`
      : null,
    findings: store.findingsOf(id),
    coverage: store.reviewChecks(id),
    tests: store.reviewTests(id),
    receipts: (review.runId ? store.qaCheckReceipts(review.runId, review.sha) : []).map(
      (check) => ({
        command: check.command,
        origin: "hub-receipt",
        outcome: check.ok === null ? "unknown" : check.ok ? "passed" : "failed",
        at: check.at,
        exitCode: check.exitCode,
        evidence: check.evidence,
      }),
    ),
    resolutions: store.reviewResolutions(id).map((item) => ({
      findingRef: { reviewId: item.reviewId, pos: item.pos },
      outcome: item.outcome,
    })),
    screenshots: store.reviewShots(id),
    limitations: LEGACY_LIMITATIONS,
  };
}
