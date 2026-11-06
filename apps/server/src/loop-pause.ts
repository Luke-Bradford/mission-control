import { isPaused } from "./collectors/ta-loop.ts";
import type { AdoptedLoop } from "./config.ts";
import { existsNoted } from "./file-deps.ts";
import type { Store } from "./store.ts";

/** Whether a watched loop is paused, and the issue that pauses it when its config names one. */
export interface LoopPause {
  paused: boolean;
  /** The configured pause issue as `repo#number`, while it holds; else null. */
  by: string | null;
}

/**
 * A loop is paused by its TA PAUSE file, or by what its config says pauses it: a stop file that
 * exists, or an issue that is still open (a pause issue the board has seen closed no longer holds).
 */
export function loopPause(loop: AdoptedLoop, store: Store): LoopPause {
  const file = loop.kind === "ta-loop" && isPaused(loop);
  const by = loop.pausedBy;
  if (by === undefined) return { paused: file, by: null };
  if ("stopFile" in by) return { paused: file || existsNoted(by.stopFile), by: null };
  const { repoId, number } = by.issue;
  const board = store.board(repoId);
  const open =
    !board.some((b) => b.issueNumber === number && b.closed) &&
    (store.escalations().some((e) => e.repoId === repoId && e.issueNumber === number) ||
      board.some((b) => b.issueNumber === number));
  return { paused: file || open, by: open ? `${repoId}#${number}` : null };
}
