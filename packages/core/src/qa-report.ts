/** Durable, immutable QA evidence. A report verdict is a historical statement, not live readiness. */
import type { EvidenceManifest } from "./pr-evidence.ts";
import type { FindingResolution, ReviewCheck, ReviewFinding, ReviewVerdict } from "./review.ts";
import type { PrCheck } from "./types.ts";

export interface QaTestReceipt {
  command: string;
  origin: "hub-receipt" | "reviewer-reported" | "controller-recorded";
  outcome: "passed" | "failed" | "not-run" | "unknown";
  at?: number | null;
  exitCode?: number | null;
  passed?: number;
  failed?: number;
  skipped?: number;
  duration?: number;
  /** Receipt URL, retained log excerpt or an exact receipt description; counts alone are not proof. */
  evidence?: string;
  file?: string;
}

export interface QaFollowUp {
  text: string;
  disposition: "fixed" | "ticket" | "accepted" | "pending";
  ticket?: string;
  basis?: string;
}

export interface QaImageRef {
  url: string;
  /** Portable immutable Git source, when the displayed bytes were retained locally by hash. */
  sourceUrl?: string;
  source: "native-capture" | "controlled-fixture" | "controller-link";
  sha256?: string;
  capturedAt?: number | null;
  commitSha?: string;
  provenance?: string;
}

export interface QaVisualPair {
  label: string;
  before: QaImageRef;
  after: QaImageRef;
  diff?: QaImageRef;
}

export interface QaVisualEvidence {
  applicability: "required" | "not_applicable" | "unknown";
  reason?: string;
  pairs: QaVisualPair[];
  /** The original native manifest, retained independently of the three-head evidence sweep. */
  manifest?: EvidenceManifest;
  /** Additional review-browser captures, also retained independently of review-shot expiry. */
  screenshots?: (QaImageRef & { label: string })[];
}

export interface QaReport {
  schemaVersion: 1;
  /** SHA-256 of canonical report content. Existing content is never rewritten. */
  id: string;
  repoId: string;
  github: string;
  prNumber: number;
  headSha: string;
  prTitle: string;
  prUrl: string;
  branch?: string;
  source: "native" | "controller";
  reviewer: { id: string; label: string; model?: string };
  /** Null means the exact original review time is not known. Registration never backdates it. */
  reviewedAt: number | null;
  registeredAt: number;
  nativeReviewId?: number;
  nativeRunId?: string;
  sourceRef?: string;
  verdict: ReviewVerdict;
  summary: string;
  worksWell: string[];
  coverage: ReviewCheck[];
  findings: ReviewFinding[];
  resolutions: FindingResolution[];
  tests: QaTestReceipt[];
  ci: {
    observedAt: number;
    headSha: string;
    source: "github" | "hub-cache" | "unavailable";
    checks: PrCheck[];
    limitation?: string;
  };
  limitations: string[];
  followUps: QaFollowUp[];
  visual: QaVisualEvidence;
  completeness: { state: "complete" | "incomplete"; missing: string[] };
  permalink: string;
}

export interface QaReportImport {
  repoId: string;
  prNumber: number;
  headSha: string;
  reviewer: QaReport["reviewer"];
  reviewedAt: number | null;
  sourceRef: string;
  verdict: ReviewVerdict;
  summary: string;
  worksWell?: string[];
  coverage?: ReviewCheck[];
  findings?: ReviewFinding[];
  resolutions?: FindingResolution[];
  tests?: QaTestReceipt[];
  limitations?: string[];
  followUps?: QaFollowUp[];
  visual?: Omit<QaVisualEvidence, "manifest">;
}

export const qaReportPermalink = (repoId: string, prNumber: number, id: string): string =>
  `/qa?repo=${encodeURIComponent(repoId)}&pr=${prNumber}&report=${id}`;
