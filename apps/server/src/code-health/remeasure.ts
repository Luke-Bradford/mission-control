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
  if (row.rule === "recurring-correction" && row.scope?.category) {
    const source = store.codeHealthReviews(repoId, at - WINDOW_MS, at);
    if (source.observedFrom === null) return RETRY;
    const matching = source.findings.filter(
      (f) =>
        f.category === row.scope?.category &&
        (row.scope?.findingSummary === undefined || f.summary === row.scope.findingSummary) &&
        (row.scope?.findingFix === undefined || f.fix === row.scope.findingFix),
    );
    // Legacy accepted records have no recorded lineage or exact-head source. Preserve their
    // immutable-baseline re-measure behaviour; new projections never take this path.
    const legacy = row.scope.findingSummary === undefined;
    const exactHead =
      legacy ||
      [...new Set(matching.map((f) => f.pr))].every((pr) => {
        const currentHead = matching.find((f) => f.pr === pr)?.currentHeadSha;
        return (
          currentHead !== null &&
          currentHead !== undefined &&
          source.reviews.some((review) => review.pr === pr && review.headSha === currentHead)
        );
      });
    if (!exactHead) return { current: null, note: "A newer PR head has no matching review." };
    const ids = new Set(
      matching
        .filter(
          (f) =>
            f.category === row.scope?.category &&
            f.resolution === null &&
            (legacy || f.currentHeadSha === f.headSha) &&
            (row.scope?.findingSummary === undefined || f.summary === row.scope.findingSummary) &&
            (row.scope?.findingFix === undefined || f.fix === row.scope.findingFix) &&
            (row.scope?.files === undefined ||
              (f.file !== null && row.scope.files.includes(f.file))) &&
            (row.scope?.files !== undefined ||
              row.scope?.file === undefined ||
              f.file === row.scope.file),
        )
        .map((f) => f.findingId),
    );
    return {
      current: ids.size,
      note: "Unresolved findings for the recorded cause, last 30 days.",
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
