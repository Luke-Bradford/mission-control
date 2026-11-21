import { runAccountId } from "../accounts/bindings.ts";
import { readCrewPause } from "../config/crew-pause.ts";
import type { CcConfig } from "../config.ts";
import { flightState } from "../flight/state.ts";
import type { Store } from "../store.ts";
import { accountAtStop } from "./queue.ts";

/** The accounts of idle build seats that Ready work fits; empty when no Ready work waits. */
function readyWorkIdleAccounts(store: Store, config: CcConfig, at: number): string[] {
  const state = flightState({ config, store, busy: [], now: at });
  const seats = config.crew?.sessions.flatMap((s) => s.seats) ?? [];
  return state.seats
    .filter(
      (seat) =>
        seat.loop === "build" &&
        seat.free &&
        (state.wake?.fit?.[seat.id]?.length ?? state.tickets.some((ticket) => ticket.ready)),
    )
    .map((seat) => seats.find((s) => s.id === seat.id)?.accountId)
    .filter((id): id is string => id !== undefined);
}

/** Local only: no GitHub write and no network fetch. */
export function runSilenceCheck(deps: { store: Store; config: CcConfig; now(): number }): void {
  const { store, config } = deps;
  const at = deps.now();
  // A seat is working when its session holds an open ticket run that is not parked or set aside;
  // FLIGHT, watch and observed-loop runs carry no ticket or no seat session.
  const working: { runId: string; accountId: string; budgetParked: boolean }[] = [];
  for (const session of store.activeSeatSessions()) {
    const run = session.runId === null ? null : store.run(session.runId);
    const hold = run?.loop?.hold;
    if (run === null || run.endedAt !== null || run.ticket === null || hold?.worktree != null)
      continue;
    const seat = config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === run.agentId);
    if (seat === undefined) continue;
    if (hold?.kind != null && hold.kind !== "budget") continue;
    working.push({
      runId: run.id,
      accountId: runAccountId(store, run.id, seat.accountId),
      budgetParked: hold?.kind === "budget",
    });
  }
  const idleAccounts = readyWorkIdleAccounts(store, config, at);
  // an idle seat whose account is at its stop cannot start the Ready work
  const startable = idleAccounts.filter((id) => !accountAtStop(config, store, id, at));
  const readyWork = startable.length > 0;
  store.checkSilenceAlarms(at, {
    crewPaused: readCrewPause(store) !== null,
    noSeatRan: working.length === 0 && !readyWork,
    readyWorkForIdleSeat: readyWork,
    // the budget stops the crew only when every working seat is parked on it or at its account's stop
    budgetStopped:
      working.length + idleAccounts.length > 0 &&
      startable.length === 0 &&
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
