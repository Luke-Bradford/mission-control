import { CODE_HEALTH_RULES } from "@mc/core";
import type { Store } from "../store.ts";
import { recommendationHash as hash } from "./proposal-hash.ts";
import type { Proposal } from "./recommendations.ts";

/** File size is a triage observation, never a defect or an instruction to split the file. */
export function fileRecommendationProposals(
  store: Store,
  repoId: string,
  at: number,
  checkout?: string,
) {
  const missing: string[] = [];
  if (!checkout) return { proposals: [] as Proposal[], missing: ["configured file checkout"] };
  const from = at - 30 * 86400000,
    dated = store.codeHealthDatedRisk(repoId, from, at);
  const sizes = store.codeHealthSizeSnapshot(repoId, checkout);
  const current =
    sizes?.status === "available" &&
    sizes.analysedSha &&
    sizes.checkedAt <= at &&
    at - sizes.checkedAt < 15 * 60000 &&
    sizes.collectedAt !== null &&
    sizes.collectedAt <= at;
  if (!dated.complete) missing.push("complete dated PR/file membership");
  if (!current) missing.push("current regular-text file sizes");
  const git = store.codeHealthGitMetrics(repoId, checkout, from, at, at);
  if (!git.complete) missing.push("complete per-file git numstats");
  if (!current || !dated.complete || !sizes?.analysedSha)
    return { proposals: [] as Proposal[], missing };
  const rule = CODE_HEALTH_RULES.repeatedlyChangedLargeFile;
  const paths = [...dated.touches]
    .filter(([, prs]) => prs.size >= rule.mergedPrTouches)
    .map(([path]) => path);
  const files = store.codeHealthSizedPaths(repoId, checkout, sizes.analysedSha, paths, rule.lines);
  const proposals: Proposal[] = files.map((file) => {
    const prs = [...(dated.touches.get(file.path) ?? [])].sort((a, b) => a - b),
      name = "repeatedly-changed-large-file";
    return {
      id: `chr_${hash([repoId, name, CODE_HEALTH_RULES.version, file.path])}`,
      repoId,
      rule: name,
      ruleVersion: CODE_HEALTH_RULES.version,
      causeId: `file-change-boundary:${hash([file.path, sizes.analysedSha, prs])}`,
      title: `Bring ${file.path} under ${rule.lines} lines: ${file.lines} lines now, touched by ${prs.length} merged PRs in 30 days`,
      scope: {
        kind: "file-risk",
        file: file.path,
        from,
        until: at,
        observedFrom: dated.observedFrom,
        observedUntil: dated.observedUntil,
        sizeSha: sizes.analysedSha ?? undefined,
        sizeCapturedAt: sizes.collectedAt ?? undefined,
        sizeVersion: sizes.version,
      },
      evidenceFingerprint: hash([file.path, file.lines, sizes.analysedSha, sizes.version, prs]),
      observation: `${file.path} has ${file.lines} measured lines at ${sizes.analysedSha?.slice(0, 12)} and changed in ${prs.length} observed merged PRs in 30 days.`,
      proposal:
        "Investigate change boundaries and shared invariants. Propose a narrow improvement only if the evidence supports it.",
      uncertainty:
        "Size alone is not risk. Observed PR history may omit uncollected work; this is an investigation proposal, not a confirmed defect or an automatic refactor.",
      rankingReason: `Conservative file triage: at least ${rule.lines} measured lines and ${rule.mergedPrTouches} dated merged-PR touches in 30 days.`,
      target: {
        metric: "measured regular-text lines in this file",
        direction: "decrease",
        baseline: file.lines,
        value: rule.lines,
        source: "CODE_HEALTH_RULES.repeatedlyChangedLargeFile.lines",
        policy: `Existing file-triage line threshold: ${rule.lines} measured lines.`,
      },
      measure: {
        current: file.lines,
        unit: "lines",
        window: "current snapshot; 30d touches",
        sourceAt: sizes.collectedAt,
        coverage: `${prs.length} observed merged PR touches in the recorded 30-day window.`,
      },
      decision: { owner: "FLIGHT", tier: "flight" },
    };
  });
  return { proposals, missing };
}
