import {
  type CodeHealthCoverage,
  type CodeHealthEvidenceRef,
  type CodeHealthView,
  codeHealthFileIncidence,
} from "@mc/core";
import type { Store } from "../store.ts";
import { riskFile } from "./risk.ts";
import type { CodeHealthEvidenceKind } from "./source.ts";

type Query = {
  repoId: string;
  from: number;
  until: number;
  revision: string;
  kind: CodeHealthEvidenceKind;
  file?: string;
  otherFile?: string;
  sha?: string;
};
export function buildRiskTab(input: {
  store: Store;
  checkout?: string;
  repoId: string;
  base: { repoId: string; from: number; until: number; revision: string };
  describe: (
    source: string,
    first: number | null,
    last: number | null,
    note: string,
    state?: CodeHealthCoverage["state"],
    sha?: string | null,
  ) => CodeHealthCoverage;
  reference: (
    query: Query,
    label: string,
    definition: string,
    coverage: CodeHealthCoverage,
  ) => CodeHealthEvidenceRef;
}) {
  const { store, checkout, repoId, base, describe, reference } = input;
  const bounds = base;
  const evidence: CodeHealthEvidenceRef[] = [];
  const sizes = checkout ? store.codeHealthSizes(checkout) : null;
  const reviews = store.codeHealthReviews(repoId, bounds.from, bounds.until);
  const dated = store.codeHealthDatedRisk(repoId, bounds.from, bounds.until);
  const membership = store.codeHealthReviewedFiles(repoId, bounds.from, bounds.until);
  const findingCoverage = describe(
    "reviewed file membership and findings",
    reviews.observedFrom,
    reviews.observedUntil,
    membership.complete
      ? "Distinct reported PRs changing each file form the incidence denominator. Findings outside those diffs are counted separately."
      : "At least one reported head lacks complete captured file membership. Incidence and outside-diff counts are unknown.",
    reviews.reviews.length ? "available" : "empty",
  );
  const datedCoverage = describe(
    "dated merged-PR file membership",
    dated.observedFrom,
    dated.observedUntil,
    `${dated.prs} observed merged PRs in the exact selected window. This is not a claim of complete GitHub history. ${dated.complete ? "All observed diffs are captured." : "Some observed diffs lack complete SHA-matched membership; touches and coupling are unknown."} File scope v1 excludes vendor, generated, build, lock and known binary paths.`,
    dated.prs ? "available" : "empty",
  );
  datedCoverage.complete = false; // No persisted ingestion watermark proves all GitHub history.
  datedCoverage.collectedAt = dated.collectedAt;
  const couplingCoverage = describe(
    "selected-window coupling",
    dated.observedFrom,
    dated.observedUntil,
    dated.pairLimit
      ? "Coupling is unavailable: the bounded 20,000-pair calculation was exceeded. An empty list does not mean no coupled files."
      : !dated.complete
        ? "Coupling is unavailable because observed merged PRs lack complete captured file membership."
        : "Map thresholds apply to this selected-window observed PR cohort. Broad diffs over 25 paths are excluded; at most 600 pairs are returned.",
    dated.pairLimit || !dated.complete ? "not-collected" : dated.prs ? "available" : "empty",
  );
  couplingCoverage.complete = false;
  couplingCoverage.collectedAt = dated.collectedAt;
  const mergedRef = reference(
    { ...base, kind: "merged-files" },
    "Dated merged PR cohort",
    "Half-open merge dates within the requested window. Head-diff and first-parent merge-diff sources are identified separately. PR membership is not line churn.",
    datedCoverage,
  );
  evidence.push(mergedRef);
  const sizeCoverage = describe(
    "cached file-size snapshot",
    null,
    null,
    sizes
      ? "Largest 50 files at the analysed SHA. Snapshot collection time is not recorded."
      : "A file-size snapshot has not been collected for this repo.",
    sizes ? "available" : "not-collected",
    sizes?.analysedSha ?? null,
  );
  const sizeRef = sizes
    ? reference(
        { ...base, kind: "sizes", sha: sizes.analysedSha },
        "File-size snapshot",
        "Current line counts at one SHA; size alone does not establish growth or risk.",
        sizeCoverage,
      )
    : undefined;
  if (sizeRef) evidence.push(sizeRef);
  const sizeByPath = new Map(sizes?.files.map((file) => [file.path, file.lines]));
  const findingsByPath = new Map<string, typeof reviews.findings>();
  for (const finding of reviews.findings) {
    if (!riskFile(finding.file)) continue;
    const group = findingsByPath.get(finding.file) ?? [];
    group.push(finding);
    findingsByPath.set(finding.file, group);
  }
  const findingPaths = [...findingsByPath.keys()];
  const touchedPaths = [...dated.touches]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([path]) => path);
  const paths = [
    ...new Set([...sizeByPath.keys(), ...touchedPaths, ...findingPaths.sort().slice(0, 50)]),
  ].filter(riskFile);
  describe(
    "git numstats and comparable size history",
    null,
    null,
    "Per-file additions/deletions and comparable size history are not collected. Merged-PR counts are not line churn.",
    "not-collected",
  );
  const data: Extract<CodeHealthView["data"], { tab: "risk" }> = {
    tab: "risk",
    files: paths.map((path) => {
      const changedPrs = membership.eligiblePrs.filter((row) =>
        membership.files.get(row.pr)?.has(path),
      );
      const incidence = codeHealthFileIncidence({
        repoId,
        file: path,
        eligiblePrs: membership.eligiblePrs,
        changedPrs,
        findings: findingsByPath.get(path) ?? [],
        changedFilesComplete: membership.complete,
      });
      const refs = sizeRef && sizeByPath.has(path) ? [sizeRef] : [];
      refs.push(
        reference(
          { ...base, kind: "merged-files", file: path },
          `Merged changes: ${path}`,
          "Observed merged PRs with captured membership for this path. Touches are unknown if any observed PR lacks a complete diff.",
          datedCoverage,
        ),
      );
      if (reviews.reviews.length) {
        refs.push(
          reference(
            { ...base, kind: "findings", file: path },
            `Findings: ${path}`,
            "Distinct finding identities on this path in reported reviews, including findings outside the PR diff.",
            findingCoverage,
          ),
        );
        refs.push(
          reference(
            { ...base, kind: "reviewed-files", file: path },
            `Incidence denominator: ${path}`,
            "Each captured reported head is listed with its SHA and membership status. Distinct PRs changing the file form the denominator. All heads must be complete before a percentage is published.",
            findingCoverage,
          ),
        );
      }
      return {
        path,
        lines: sizeByPath.get(path) ?? null,
        analysedSha: sizeByPath.has(path) ? (sizes?.analysedSha ?? null) : null,
        mergedPrTouches: dated.complete && dated.prs ? (dated.touches.get(path)?.size ?? 0) : null,
        additions: null,
        deletions: null,
        findings: reviews.reviews.length ? incidence.findings : null,
        outsideDiffFindings: reviews.reviews.length ? incidence.outsideDiffFindings : null,
        incidence: reviews.reviews.length ? incidence.incidence : null,
        evidence: refs,
      };
    }),
    sizeHistory: [],
    coupling: dated.coupling.map((pair) => ({
      ...pair,
      evidence: [
        reference(
          { ...base, kind: "merged-files", file: pair.left, otherFile: pair.right },
          `Shared PRs: ${pair.left} / ${pair.right}`,
          "Map formula: at least four shared PRs and half the less frequently changed file's eligible PRs. Diffs over 25 paths are excluded before scope filtering. Selected-window observed PR cohort; at most 600 pairs.",
          couplingCoverage,
        ),
      ],
    })),
  };
  return { data, evidence };
}
