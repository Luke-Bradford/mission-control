import { type CmuxSessionRow, type SeatWaiting, seatWaiting } from "@mc/core";
import type { Store } from "../store.ts";

/** The seat's `seatWaiting`, read from its stored row, held run and that run's digest. */
export function storedSeatWaiting(
  store: Pick<Store, "seatSession" | "run" | "digest">,
  seatId: string,
): SeatWaiting | null {
  const row = store.seatSession(seatId);
  const run = row?.runId ? store.run(row.runId) : null;
  return seatWaiting(row, run, run ? (store.digest(run.id)?.lastText ?? null) : null);
}

/** A crew workspace's (`<seat> · …`) waiting line for cmux's sidebar; null for any other. */
export function workspaceWaitingText(
  store: Pick<Store, "seatSession" | "run" | "digest">,
  seatIds: readonly string[],
  row: Pick<CmuxSessionRow, "owner" | "name">,
): string | null {
  if (row.owner !== "crew") return null;
  const seat = seatIds.find((id) => row.name.startsWith(`${id} · `));
  return seat === undefined ? null : (storedSeatWaiting(store, seat)?.text ?? null);
}
