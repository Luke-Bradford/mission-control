/** The guard's second look at a whole-file read: has this run already read that large file, unchanged? */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type GuardEvent, REREAD_MIN_BYTES, rereadVerdict, wholeFileRead } from "@mc/core";
import type { Store } from "../store.ts";

/**
 * The refusal text when `event` is a whole read of a file of REREAD_MIN_BYTES or more that the run
 * already read whole and that has not changed since; else null. A first read, or one of a changed
 * file, is remembered. A refusal is counted toward the run's saved tokens. A file that cannot be
 * statted passes: the read itself will say why.
 */
export function rereadDenial(
  store: Store,
  run: { runId: string; toolUseId: string; agentId: string },
  worktree: string | undefined,
  event: GuardEvent,
  at: number,
): string | null {
  const named = wholeFileRead(event);
  if (named === null) return null;
  const path = resolve(worktree ?? "/", named);
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(path));
  } catch {
    return null;
  }
  if (size < REREAD_MIN_BYTES) return null;
  const now = { size, mtimeMs, compactions: store.digest(run.runId)?.compactions ?? 0 };
  const verdict = rereadVerdict(named, now, store.runRead(run.runId, run.agentId, path));
  if (verdict.kind === "deny") {
    store.addReread(run.runId, verdict.tokensSaved);
    return verdict.text;
  }
  store.setRunRead(run.runId, run.agentId, path, { ...now, toolUseId: run.toolUseId, at });
  return null;
}
