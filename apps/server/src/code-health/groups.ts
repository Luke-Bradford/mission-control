import type { RecommendationRecord } from "./recommendations.ts";

export interface RecommendationGroup {
  rule: string;
  /** What the group's proposals share, e.g. the finding category their PRs were reworked for. */
  cause: string;
  prs: number[];
  proposalIds: string[];
}

/** One-per-PR proposals with the same rule and cause read as one group listing each PR. */
export function groupRecommendations(rows: readonly RecommendationRecord[]): RecommendationGroup[] {
  const groups = new Map<string, RecommendationGroup>();
  for (const row of rows) {
    const pr = row.scope?.pr,
      cause = row.scope?.cause;
    if (pr === undefined || cause === undefined) continue;
    const key = JSON.stringify([row.rule, cause]);
    const group = groups.get(key) ?? { rule: row.rule, cause, prs: [], proposalIds: [] };
    group.prs.push(pr);
    group.proposalIds.push(row.id);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.prs.sort((a, b) => a - b);
  return [...groups.values()].sort(
    (a, b) => b.prs.length - a.prs.length || a.cause.localeCompare(b.cause),
  );
}
