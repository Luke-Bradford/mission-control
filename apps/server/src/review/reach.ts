/** What a review brief says a change reaches: its files and the files that import them. */

/** The most files each list in the brief names; the rest are counted. */
export const REVIEW_REACH_MAX = 20;

export interface ReviewReach {
  changed: string[];
  changedMore: number;
  importers: string[];
  importersMore: number;
}

/**
 * The changed files and the files that import any of them (not changed themselves), each list sorted
 * and cut at REVIEW_REACH_MAX with the rest counted. Null when nothing changed.
 */
export function reviewReach(
  imports: readonly { from: string; to: string }[],
  changed: readonly string[],
): ReviewReach | null {
  if (changed.length === 0) return null;
  const files = [...new Set(changed)].sort();
  const own = new Set(files);
  const importers = [
    ...new Set(imports.filter((e) => own.has(e.to) && !own.has(e.from)).map((e) => e.from)),
  ].sort();
  return {
    changed: files.slice(0, REVIEW_REACH_MAX),
    changedMore: Math.max(0, files.length - REVIEW_REACH_MAX),
    importers: importers.slice(0, REVIEW_REACH_MAX),
    importersMore: Math.max(0, importers.length - REVIEW_REACH_MAX),
  };
}
