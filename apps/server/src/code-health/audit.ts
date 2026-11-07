import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";

/** How often the hub runs the audit; both steps are idempotent, so a missed or repeated pass is harmless. */
export const CODE_HEALTH_AUDIT_EVERY_MS = 60 * 60_000;

/** The audit's unprompted work: record merged PRs' reviews, and re-measure accepted proposals that are due. */
export function runCodeHealthAudit(deps: {
  store: Store;
  config: Pick<CcConfig, "repos"> & Partial<Pick<CcConfig, "crew">>;
  now(): number;
}) {
  const at = deps.now();
  for (const repo of deps.config.repos) {
    deps.store.recordCodeHealthMergedReviews(repo.id, at);
    deps.store.remeasureCodeHealth(
      repo.id,
      at,
      deps.config.crew?.sessions.find((row) => row.repoId === repo.id)?.checkout,
    );
  }
}
