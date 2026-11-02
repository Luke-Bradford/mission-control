import type { QaReport, QaTestReceipt } from "./qa-report.ts";
import type {
  FindingResolution,
  ReportedTest,
  ReviewCheck,
  ReviewRow,
  StoredFinding,
} from "./review.ts";
import type { ReviewShotView } from "./views.ts";

/** A small index entry. It contains no image URLs, report body, or live approval. */
export interface QaHistoryEntry {
  key: string;
  kind: "report" | "native";
  source: QaReport["source"];
  repoId: string;
  prNumber: number;
  headSha: string;
  title: string;
  reviewer: QaReport["reviewer"];
  reviewedAt: number | null;
  /** Index order: report registration or native completion (creation when unknown). */
  recordedAt: number;
  state: string;
  verdict: QaReport["verdict"] | null;
  evidence: "complete" | "incomplete" | "legacy";
  ci: "passing" | "failing" | "pending" | "unavailable";
  visual: QaReport["visual"]["applicability"];
  pairCount: number;
  screenshotCount: number;
  permalink: string;
}

export interface QaHistoryPage {
  entries: QaHistoryEntry[];
  repositories: { id: string }[];
  nextCursor: string | null;
  limit: number;
  /** History includes retained records only; it cannot recover records already pruned. */
  limitations: string[];
}

/** An original stored record, not a retrospectively generated immutable report. */
export interface QaNativeHistory {
  entry: QaHistoryEntry;
  review: ReviewRow;
  prUrl: string;
  headUrl: string | null;
  findings: StoredFinding[];
  coverage: ReviewCheck[];
  receipts: QaTestReceipt[];
  resolutions: FindingResolution[];
  tests: (Omit<ReportedTest, "file"> & { file: string | null })[];
  screenshots: ReviewShotView[];
  limitations: string[];
}
