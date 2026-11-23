/** Which merged PRs are not live yet: their change has merged, but the running hub does not hold it. */

export interface MergedPr {
  key: string;
  mergeSha: string | null;
}

/**
 * The merged PRs whose pictures and work files must stay: the merge commit is not (confirmed) in the
 * history of the code the hub runs, in the hub's own repo only. Pictures go only on positive
 * confirmation: when the running SHA or its history cannot be read, every merged PR with a merge
 * commit is held and the next sweep tries again. A PR with no merge commit on record is not held.
 * The history is read once, not once per PR. A caller with no hub checkout passes no `hubRepoId`.
 */
export async function notLivePrKeys(
  hubRepoId: string | undefined,
  merged: readonly MergedPr[],
  runningSha: string | null,
  historyOf: (runningSha: string) => Promise<ReadonlySet<string> | null>,
): Promise<Set<string>> {
  const held = new Set<string>();
  if (hubRepoId === undefined) return held;
  const history = runningSha === null ? null : await historyOf(runningSha);
  // only the hub's own repo has its commits in the hub checkout; other repos' PRs finish at merge
  for (const pr of merged.filter((p) => p.key.startsWith(`${hubRepoId}#`)))
    if (pr.mergeSha !== null && (history === null || !history.has(pr.mergeSha))) held.add(pr.key);
  return held;
}
