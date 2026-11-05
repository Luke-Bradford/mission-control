import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";
import type { Remeasure } from "./recommendations.ts";
import { recommendationRow } from "./recommendations.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const WINDOW_MS = 30 * 86_400_000;
/** A measure that is unavailable for now is retried each pass, then stored as unmeasured after this long. */
const RETRY_FOR_MS = 7 * 86_400_000;
const RETRY = "retry";

/** The target metric as it reads now, with a note when it cannot be read. */
function measure(
  store: Store,
  repoId: string,
  row: NonNullable<ReturnType<typeof recommendationRow>>,
  at: number,
  checkout: string | undefined,
): { current: number | null; note: string } | typeof RETRY {
  if (row.rule === "recurring-correction" && row.scope?.file && row.scope.category) {
    const source = store.codeHealthReviews(repoId, at - WINDOW_MS, at);
    if (source.observedFrom === null) return RETRY;
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
  if (row.rule === "repeatedly-changed-large-file" && row.scope?.file) {
    if (!checkout) return RETRY;
    try {
      const sizes = store.codeHealthSizeSnapshot(repoId, checkout);
      if (sizes?.status !== "available" || !sizes.analysedSha) return RETRY;
      const found = store.codeHealthSizedPaths(
        repoId,
        checkout,
        sizes.analysedSha,
        [row.scope.file],
        0,
      );
      // A file gone from a current snapshot was broken up or removed: the best result.
      return found[0]
        ? { current: found[0].lines, note: "Measured lines at the latest size snapshot." }
        : { current: 0, note: "File no longer exists at the latest size snapshot." };
    } catch {
      return RETRY;
    }
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
    const measured = measure(store, repoId, row, at, checkout);
    if (measured === RETRY && at < (row.reviewAt ?? 0) + RETRY_FOR_MS) continue;
    const { current, note } =
      measured === RETRY
        ? {
            current: null,
            note: "The measure stayed unavailable for 7 days after the review date.",
          }
        : measured;
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
