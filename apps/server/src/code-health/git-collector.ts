import type { ChangeBus } from "../bus.ts";
import type { CcConfig } from "../config.ts";
import { type GitExec, realGitExec } from "../files.ts";
import type { Store } from "../store.ts";
import { collectGitFileSource, gitFileHead } from "./git-source.ts";
import { collectFileSizes, SIZE_SCOPE_VERSION } from "./size-source.ts";

/** One serial background reader. No fetch, checkout, branch, index or observed worktree write. */
export function createGitFileCollector(deps: {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  now?: () => number;
  exec?: GitExec;
}) {
  const now = deps.now ?? Date.now,
    exec = deps.exec ?? realGitExec;
  let stopped = false,
    running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const repos = deps.config.repos.slice(0, 20);
      for (const repo of repos) {
        if (stopped) break;
        const checkout = deps.config.crew?.sessions.find(
          (session) => session.repoId === repo.id,
        )?.checkout;
        if (!checkout) continue;
        let sha: string | null = null;
        try {
          sha = await gitFileHead(checkout, exec);
          if (stopped) break;
          const previous = deps.store.codeHealthGitSource(repo.id, checkout),
            at = now();
          if (
            previous?.status === "available" &&
            previous.version === 1 &&
            previous.analysedSha === sha
          ) {
            deps.store.markCodeHealthGitChecked(repo.id, checkout, sha, at);
          } else {
            const source = await collectGitFileSource(
              checkout,
              exec,
              Math.floor(at / 86400000) * 86400000 - 91 * 86400000,
              sha,
            );
            if (stopped) break;
            deps.store.recordCodeHealthGitSource(repo.id, checkout, source, now());
          }
          deps.bus.emit("health");
        } catch {
          if (stopped) break;
          deps.store.failCodeHealthGitSource(repo.id, checkout, sha, now());
          deps.bus.emit("health");
        }
        try {
          if (!sha) {
            deps.store.failCodeHealthSizes(repo.id, checkout, null, now());
            continue;
          }
          const previous = deps.store.codeHealthSizeSnapshot(repo.id, checkout);
          if (
            previous?.status === "available" &&
            previous.version === SIZE_SCOPE_VERSION &&
            previous.analysedSha === sha
          ) {
            deps.store.checkCodeHealthSizes(repo.id, checkout, sha, now());
          } else {
            const snapshot = await collectFileSizes(checkout, sha, { exec });
            if (stopped) break;
            deps.store.recordCodeHealthSizeSnapshot(repo.id, checkout, snapshot, now());
          }
          deps.bus.emit("health");
        } catch {
          if (stopped) break;
          deps.store.failCodeHealthSizes(repo.id, checkout, sha, now());
          deps.bus.emit("health");
        }
      }
    })().finally(() => {
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
      initial = setTimeout(() => {
        void tick().catch(() => {});
      }, 120000);
      initial.unref();
      interval = setInterval(() => {
        void tick().catch(() => {});
      }, 300000);
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
