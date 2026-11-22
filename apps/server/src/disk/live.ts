/** Which merged PRs are not live yet: their change has merged, but the running hub does not hold it. */

export interface MergedPr {
  key: string;
  mergeSha: string | null;
}

/**
 * The merged PRs whose pictures and work files must stay: the merge commit is not in the history of
 * the code the hub runs, in the hub's own repo only. With no running SHA, or no merge commit on record, nothing is held (the
 * PR counts as finished, as it did before this rule).
 */
export async function notLivePrKeys(
  hubRepoId: string | undefined,
  merged: readonly MergedPr[],
  runningSha: string | null,
  inRunning: (mergeSha: string, runningSha: string) => Promise<boolean>,
): Promise<Set<string>> {
  const held = new Set<string>();
  if (runningSha === null || hubRepoId === undefined) return held;
  // only the hub's own repo has its commits in the hub checkout; other repos' PRs finish at merge
  for (const pr of merged.filter((p) => p.key.startsWith(`${hubRepoId}#`)))
    if (pr.mergeSha !== null && !(await inRunning(pr.mergeSha, runningSha))) held.add(pr.key);
  return held;
}
