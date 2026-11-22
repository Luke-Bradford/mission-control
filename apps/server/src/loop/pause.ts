import { isPaused } from "../collectors/ta-loop.ts";
import type { AdoptedLoop } from "../config.ts";
import { existsNoted } from "../repo/file-deps.ts";
import type { Store } from "../store.ts";

/** Whether a watched loop is paused, and the issue that pauses it when its config names one. */
export interface LoopPause {
  paused: boolean;
  /** The configured pause issue as `repo#number`, while it holds; else null. */
  by: string | null;
  /** The pause issue's page, from its repo's GitHub slug; null when the repo is not configured. */
  url: string | null;
}

/**
 * A loop is paused by its TA PAUSE file, or by what its config says pauses it: a stop file that
 * exists, or an issue that is still open (a pause issue the board has seen closed no longer holds).
 */
export function loopPause(
  loop: AdoptedLoop,
  store: Store,
  github?: (repoId: string) => string | undefined,
): LoopPause {
  const file = loop.kind === "ta-loop" && isPaused(loop);
  const by = loop.pausedBy;
  if (by === undefined) return { paused: file, by: null, url: null };
  if ("stopFile" in by) return { paused: file || existsNoted(by.stopFile), by: null, url: null };
  const { repoId, number } = by.issue;
  const card = store.boardItem(repoId, number);
  const open =
    card?.closed !== true &&
    (store.escalations().some((e) => e.repoId === repoId && e.issueNumber === number) ||
      card !== null);
  const slug = github?.(repoId);
  return {
    paused: file || open,
    by: open ? `${repoId}#${number}` : null,
    url: open && slug ? `https://github.com/${slug}/issues/${number}` : null,
  };
}
