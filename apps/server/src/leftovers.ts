import type { BoardItem } from "@mc/core";
import type { CcConfig } from "./config.ts";
import { endedWorkOver, runSubjectGone } from "./hud.ts";
import type { Store } from "./store.ts";

/** How often the hub clears leftovers; the pass is idempotent, so a missed or repeated one is harmless. */
export const LEFTOVERS_EVERY_MS = 60 * 60_000;

/**
 * Clears what finished work left on the hub: a seat question set aside, a merge hold released and a
 * parked state closed, each on an ended run whose work is over. Each gets a hub event. Local only:
 * no model run and no GitHub write. Returns the hub event texts, for the log.
 */
export function clearLeftovers(deps: { store: Store; config: CcConfig; now: number }): string[] {
  const { store, config, now } = deps;
  const boards = new Map<string, BoardItem[]>();
  const boardOf = (repoId: string): BoardItem[] => {
    let b = boards.get(repoId);
    if (!b) {
      b = store.board(repoId);
      boards.set(repoId, b);
    }
    return b;
  };
  const cleared: string[] = [];
  const record = (text: string) => {
    store.addHubEvent(text, now);
    cleared.push(text);
  };

  for (const q of store.openQuestions()) {
    const asker = store.run(q.runId);
    if (asker === null || !endedWorkOver(config, store, asker, boardOf, now)) continue;
    if (store.setQuestionAside(q.id, now))
      record(`cleared ${q.agentId}'s question ${q.id}: its run ended and the work is over`);
  }

  for (const run of store.endedRunsWithHoldOrPark()) {
    const loop = run.loop;
    if (!loop || !runSubjectGone(config, store, run, boardOf)) continue;
    const next = { ...loop, mergeHold: null, parked: null };
    if (loop.phase === "parked") next.phase = "done";
    store.setRunLoop(run.id, next, now);
    if (loop.mergeHold) record(`released the merge hold on ended run ${run.id}: its work is over`);
    if (loop.parked) record(`cleared the parked state on ended run ${run.id}: its work is over`);
  }
  return cleared;
}
