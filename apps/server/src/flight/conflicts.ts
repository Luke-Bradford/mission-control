import type { PullRequestView } from "@mc/core";
import type { MapConflicts } from "../map/conflicts.ts";

/**
 * The files whose merge conflicts between open PRs, with the PRs: each pair's `git merge-tree`
 * result, so a file two PRs change in separate places is not listed. Undefined when the checkout
 * cannot be read; FLIGHT's state then carries no list rather than failing to build.
 */
export async function flightConflicts(
  conflicts: MapConflicts,
  checkout: string,
  prs: readonly Pick<PullRequestView, "branch" | "headSha" | "state" | "number">[],
): Promise<{ file: string; prs: number[] }[] | undefined> {
  try {
    const { conflicts: found } = await conflicts.check(checkout, prs);
    const byFile = new Map<string, Set<number>>();
    for (const c of found) {
      const set = byFile.get(c.file) ?? new Set<number>();
      for (const n of c.prs ?? []) if (n !== null) set.add(n);
      byFile.set(c.file, set);
    }
    return [...byFile]
      .map(([file, nums]) => ({ file, prs: [...nums].sort((a, b) => a - b) }))
      .sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return undefined;
  }
}
