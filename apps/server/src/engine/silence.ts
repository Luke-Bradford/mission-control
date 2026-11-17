import { runAccountId } from "../accounts/bindings.ts";
import { readCrewPause } from "../config/crew-pause.ts";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { accountAtStop } from "./queue.ts";

/** Local only: no GitHub write and no network fetch. */
export function runSilenceCheck(deps: { store: Store; config: CcConfig; now(): number }): void {
  const { store, config } = deps;
  const at = deps.now();
  // A seat is working when its session holds an open ticket run that is not parked or set aside;
  // FLIGHT, watch and observed-loop runs carry no ticket or no seat session.
  const working: { runId: string; accountId: string; budgetParked: boolean }[] = [];
  for (const session of store.activeSeatSessions()) {
    const run = session.runId === null ? undefined : store.run(session.runId);
    if (run === undefined || run.endedAt !== null || run.ticket === null || run.loop?.aside)
      continue;
    const seat = config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === run.agentId);
    if (seat === undefined) continue;
    const parked = run.loop?.parked;
    if (parked && parked.kind !== "budget") continue;
    working.push({
      runId: run.id,
      accountId: runAccountId(store, run.id, seat.accountId),
      budgetParked: parked?.kind === "budget",
    });
  }
  store.checkSilenceAlarms(at, {
    crewPaused: readCrewPause(store) !== null,
    noSeatRan: working.length === 0,
    // the budget stops the crew only when every working seat is parked on it or at its account's stop
    budgetStopped:
      working.length > 0 &&
      working.every((w) => w.budgetParked || accountAtStop(config, store, w.accountId, at)),
  });
}

/** Wraps a screenshot save so each saved shot counts as a capture. */
export function recordingShotSaves(
  store: Store,
  save: (png: Buffer) => string,
  now: () => number,
): (png: Buffer) => string {
  return (png) => {
    const id = save(png);
    store.recordSilenceEvent("screenshot-captured", now());
    return id;
  };
}
