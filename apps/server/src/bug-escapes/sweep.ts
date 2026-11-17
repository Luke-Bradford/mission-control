import type { CcConfig } from "../config.ts";
import { type GitExec, realGitExec } from "../repo/files.ts";
import type { Store } from "../store.ts";
import { classifyMissed } from "./classify.ts";
import { traceFix } from "./trace.ts";

/** Bugs traced per repo in one pass; the rest wait for the next. */
export const BUG_ESCAPE_BATCH = 10;

/** Repos visited per pass. */
export const BUG_ESCAPE_REPOS_PER_PASS = 20;

/**
 * Traces each closed bug with a merged fix to the commit and PR that introduced it, and records
 * why it was missed. Local git only, read-only; no network and no GitHub write. A bug git cannot
 * trace stores nothing and is tried again. Returns how many rows it added.
 */
export async function sweepBugEscapes(deps: {
  config: Pick<CcConfig, "repos" | "crew">;
  store: Store;
  exec?: GitExec;
  stopped?: () => boolean;
  /** Where the next pass starts; kept between passes so every repo is reached. */
  cursor?: { next: number };
  now?: () => number;
}): Promise<number> {
  const exec = deps.exec ?? realGitExec;
  let added = 0;
  const all = deps.config.repos;
  const cursor = deps.cursor ?? { next: 0 };
  const visit = Math.min(all.length, BUG_ESCAPE_REPOS_PER_PASS);
  const first = all.length === 0 ? 0 : cursor.next % all.length;
  cursor.next = all.length === 0 ? 0 : (first + visit) % all.length;
  for (let i = 0; i < visit; i++) {
    const repo = all[(first + i) % all.length];
    const checkout = deps.config.crew?.sessions.find((s) => s.repoId === repo.id)?.checkout;
    if (checkout === undefined) continue;
    for (const bug of deps.store.bugFixCandidates(repo.id, BUG_ESCAPE_BATCH)) {
      if (deps.stopped?.() === true) return added;
      const trace = await traceFix(checkout, bug.fixSha, exec);
      if (trace === null) {
        // move this bug behind the others, so ten untraceable ones cannot starve the rest
        deps.store.noteBugTraceTried(repo.id, bug.issue, (deps.now ?? Date.now)());
        continue;
      }
      const facts =
        trace.prNumber === null
          ? { mergedAt: null, hasReview: false, doneWhen: [] }
          : deps.store.introducingPrFacts(repo.id, trace.prNumber);
      deps.store.recordBugEscape({
        repoId: repo.id,
        issue: bug.issue,
        filedAt: bug.filedAt,
        fixPr: bug.fixPr,
        commit: trace.commit,
        introducedPr: trace.prNumber,
        mergedAt: facts.mergedAt ?? trace.mergedAt,
        missed: classifyMissed({
          hasReview: facts.hasReview,
          doneWhen: facts.doneWhen,
          bugTitle: bug.title,
          fixedFiles: trace.fixedFiles,
          introFiles: trace.introFiles,
        }),
      });
      added += 1;
    }
  }
  return added;
}

/** One serial background pass over the repos, started with the hub. */
export function createBugEscapeCollector(deps: {
  config: Pick<CcConfig, "repos" | "crew">;
  store: Store;
  exec?: GitExec;
}) {
  let stopped = false,
    running: Promise<void> | null = null;
  const cursor = { next: 0 };
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = sweepBugEscapes({ ...deps, cursor, stopped: () => stopped })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
    return running;
  };
  let interval: ReturnType<typeof setInterval> | undefined,
    initial: ReturnType<typeof setTimeout> | undefined;
  return {
    tick,
    start() {
      if (interval || stopped) return;
      initial = setTimeout(() => void tick(), 180_000);
      initial.unref();
      interval = setInterval(() => void tick(), 600_000);
      interval.unref();
    },
    async stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
      await running;
    },
  };
}
