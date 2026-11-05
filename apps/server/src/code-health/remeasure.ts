import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";
import type { Remeasure } from "./recommendations.ts";
import { recommendationRow } from "./recommendations.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const WINDOW_MS = 30 * 86_400_000;

/** The target metric as it reads now, with a note when it cannot be read. */
function measure(
  store: Store,
  repoId: string,
  row: NonNullable<ReturnType<typeof recommendationRow>>,
  at: number,
  checkout: string | undefined,
): { current: number | null; note: string } {
  if (row.rule === "recurring-correction" && row.scope?.file && row.scope.category) {
    const source = store.codeHealthReviews(repoId, at - WINDOW_MS, at);
    if (source.observedFrom === null)
      return { current: null, note: "No reviews were reported in the last 30 days." };
    const ids = new Set(
      source.findings
        .filter((f) => f.file === row.scope?.file && f.category === row.scope?.category)
        .map((f) => f.findingId),
    );
    return {
      current: ids.size,
      note: "Distinct findings in this category and file, last 30 days.",
    };
  }
  if (row.rule === "repeatedly-changed-large-file" && row.scope?.file && checkout) {
    const sizes = store.codeHealthSizeSnapshot(repoId, checkout);
    if (sizes?.status !== "available" || !sizes.analysedSha)
      return { current: null, note: "File sizes are not currently collected." };
    const found = store.codeHealthSizedPaths(
      repoId,
      checkout,
      sizes.analysedSha,
      [row.scope.file],
      0,
    );
    return found[0]
      ? { current: found[0].lines, note: "Measured lines at the latest size snapshot." }
      : { current: null, note: "The file is not in the latest size snapshot." };
  }
  return { current: null, note: "This rule has no repeatable measure." };
}

function compare(
  baseline: number | null,
  current: number | null,
  direction: "increase" | "decrease",
): Remeasure["change"] {
  if (baseline === null || current === null) return "unmeasured";
  if (current === baseline) return "unchanged";
  return current < baseline === (direction === "decrease") ? "improved" : "worse";
}

/**
 * Measures every accepted proposal whose review date has passed and has no result yet against its
 * baseline, and records it once. It never ends the work: assessing stays an evidence-backed decision.
 */
export function remeasureDue(
  store: Store,
  db: Db,
  repoId: string,
  at: number,
  checkout: string | undefined,
): string[] {
  const due = db
    .prepare(
      `SELECT id FROM code_health_recommendations WHERE repo_id = ? AND remeasure IS NULL
       AND json_extract(state,'$.kind') = 'accepted' AND review_at IS NOT NULL AND review_at <= ?
       ORDER BY review_at, id LIMIT 100`,
    )
    .all(repoId, at);
  const done: string[] = [];
  for (const { id } of due) {
    const row = recommendationRow(db, repoId, String(id));
    if (!row?.baseline) continue;
    const { current, note } = measure(store, repoId, row, at, checkout);
    const baseline = row.baseline.target.baseline;
    const result: Remeasure = {
      at,
      baseline,
      current,
      change: compare(baseline, current, row.baseline.target.direction),
      note,
    };
    if (
      Number(
        db
          .prepare(
            "UPDATE code_health_recommendations SET remeasure = ? WHERE repo_id = ? AND id = ? AND remeasure IS NULL",
          )
          .run(JSON.stringify(result), repoId, row.id).changes,
      ) === 1
    )
      done.push(row.id);
  }
  return done;
}
