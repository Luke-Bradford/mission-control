/** The test for a branch that only holds the hub's own merges of main: shared by the publish step and the push gate. */
import { MC_MERGE_AUTHOR } from "../runtime/checkouts.ts";

/** A git call in the run's clone; rejects with the process's exit `code`. */
export type G = (args: string[]) => Promise<string>;

/** Whether a git command exits 0; exit 1 is "no", anything else throws. */
export async function yes(g: G, args: string[]): Promise<boolean> {
  try {
    await g(args);
    return true;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 1) return false;
    throw e;
  }
}

/** The tree of a clean merge of two commits, or null when they conflict. */
export async function mergeTree(g: G, [a, b]: string[]): Promise<string | null> {
  try {
    return (await g(["merge-tree", "--write-tree", a as string, b as string])).trim();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 1) return null;
    throw e;
  }
}

/**
 * Whether every commit on `tip` beyond `merged` is a hub-made `Merge main into <branch>`:
 * two parents, each on main or another such commit (or one of `trusted`), and a tree that is
 * exactly the clean merge of its parents. Nothing unmerged is in them.
 */
export async function onlyHubMerges(
  g: G,
  branch: string,
  merged: string,
  tip: string,
  mainSha: string,
  trusted: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (!(await yes(g, ["merge-base", "--is-ancestor", merged, tip]))) return false;
  const rows = (await g(["log", "--format=%H%x09%an%x09%P%x09%s", tip, "--not", merged, mainSha]))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));
  const inRange = new Set(rows.map((r) => r[0]));
  for (const [commit, author, parents, subject] of rows) {
    const ps = (parents ?? "").split(" ").filter((p) => p !== "");
    if (author !== MC_MERGE_AUTHOR || subject !== `Merge main into ${branch}`) return false;
    if (ps.length !== 2) return false;
    for (const p of ps) {
      if (
        !inRange.has(p) &&
        !trusted.has(p) &&
        !(await yes(g, ["merge-base", "--is-ancestor", p, mainSha]))
      ) {
        return false;
      }
    }
    // the tree must be the clean merge of the parents, so no edit rides along
    if ((await mergeTree(g, ps)) !== (await g(["rev-parse", `${commit}^{tree}`])).trim()) {
      return false;
    }
  }
  return true;
}
