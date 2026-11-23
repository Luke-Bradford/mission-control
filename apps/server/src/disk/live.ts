/** Which merged PRs are not live yet: their change has merged, but the running hub does not hold it. */

/** A merged PR older than this counts as live; the hourly scan reads no further back. */
export const NOT_LIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface MergedPr {
  key: string;
  mergeSha: string | null;
}

/**
 * The merged PRs whose pictures and work files must stay: the merge commit is not in the history of
 * the code the hub runs, in the hub's own repo only. With no running SHA, no readable history (no
 * hub checkout, or git failing), or no merge commit on record, nothing is held (the PR counts as
 * finished, as it did before this rule). The history is read once, not once per PR.
 */
export async function notLivePrKeys(
  hubRepoId: string | undefined,
  merged: readonly MergedPr[],
  runningSha: string | null,
  historyOf: (runningSha: string) => Promise<ReadonlySet<string> | null>,
): Promise<Set<string>> {
  const held = new Set<string>();
  if (runningSha === null || hubRepoId === undefined) return held;
  const history = await historyOf(runningSha);
  if (history === null) return held;
  // only the hub's own repo has its commits in the hub checkout; other repos' PRs finish at merge
  for (const pr of merged.filter((p) => p.key.startsWith(`${hubRepoId}#`)))
    if (pr.mergeSha !== null && !history.has(pr.mergeSha)) held.add(pr.key);
  return held;
}
