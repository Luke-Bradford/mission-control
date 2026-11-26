import { type BoardItem, liftPark } from "@mc/core";
import type { CcConfig } from "../config.ts";
import { endedWorkOver, runSubjectGone } from "../hud/hud.ts";
import type { Store } from "../store.ts";
import { type CrewLeftoverInput, cleanupCrewLeftovers } from "./crew-leftovers.ts";

/** How often the hub clears leftovers; the pass is idempotent, so a missed or repeated one is harmless. */
export const LEFTOVERS_EVERY_MS = 60 * 60_000;

type PreviewCloser = {
  list(): { pr: number; repoId?: string }[];
  close(pr: number, repoId?: string): Promise<boolean>;
};

/** Stops previews when the cached board proves their PR or ticket is finished. */
export async function closeFinishedPreviews(deps: {
  previews: PreviewCloser | undefined;
  store: Pick<Store, "pullRequest" | "board">;
  config: Pick<CcConfig, "hubRepo">;
}): Promise<number> {
  if (deps.previews === undefined) return 0;
  let closed = 0;
  for (const preview of deps.previews.list()) {
    const repoId = preview.repoId ?? deps.config.hubRepo;
    if (repoId === undefined || repoId === null) continue;
    const pr = deps.store.pullRequest(repoId, preview.pr);
    if (pr === null) continue;
    const ticket = pr.ticket?.startsWith(`${repoId}#`)
      ? Number(pr.ticket.slice(repoId.length + 1))
      : null;
    const ticketClosed =
      ticket !== null &&
      Number.isSafeInteger(ticket) &&
      deps.store.board(repoId).some((item) => item.issueNumber === ticket && item.closed);
    if (pr.state === "open" && !ticketClosed) continue;
    if (await deps.previews.close(preview.pr, preview.repoId)) closed++;
  }
  return closed;
}

/**
 * Clears what finished work left on the hub: a seat question set aside, a merge hold released and a
 * parked state closed, each on an ended run whose work is over. Each gets a hub event. Local only:
 * no model run and no GitHub write. Returns the hub event texts, for the log.
 */
export function clearLeftovers(deps: {
  store: Store;
  config: CcConfig;
  now: number;
  /** External paths are supplied by the hub entrypoint, never inferred by unit callers. */
  crewLeftovers?: Omit<CrewLeftoverInput, "now" | "liveWorktrees">;
}): string[] {
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
    const next = { ...loop, mergeHold: null, hold: liftPark(loop.hold) };
    if (loop.phase === "parked") next.phase = "done";
    store.setRunLoop(run.id, next, now);
    if (loop.mergeHold) record(`released the merge hold on ended run ${run.id}: its work is over`);
    if (loop.hold?.kind)
      record(`cleared the parked state on ended run ${run.id}: its work is over`);
  }
  if (deps.crewLeftovers) {
    const browser = cleanupCrewLeftovers({
      ...deps.crewLeftovers,
      now,
      worktrees: config.crew?.worktrees,
      liveWorktrees: new Set(
        store
          .activeSeatSessions()
          .map((seat) => seat.worktree)
          .filter((path): path is string => path !== null),
      ),
    });
    if (browser.gzipped || browser.deleted || browser.browserRemoved)
      record(
        `cleaned crew leftovers: ${browser.gzipped} transcripts gzipped, ${browser.deleted} deleted, ${browser.browserRemoved} browser entries removed`,
      );
  }
  return cleared;
}
