import { type CmuxSessionRow, lastMessageOf, type SeatWaiting, seatWaiting } from "@mc/core";
import type { Store } from "../store.ts";

/** cmux's sidebar holds one short line: the waiting text is cut here, with an ellipsis. */
export const SIDEBAR_WAITING_MAX = 200;

/** The seat's `seatWaiting`, read from its stored row, held run and that run's digest. */
export function storedSeatWaiting(
  store: Pick<Store, "seatSession" | "run" | "digest">,
  seatId: string,
): SeatWaiting | null {
  const row = store.seatSession(seatId);
  const run = row?.runId ? store.run(row.runId) : null;
  return seatWaiting(row, run, run ? lastMessageOf(store.digest(run.id)) : null);
}

/** A crew workspace's (`<seat> · …`) waiting line for cmux's sidebar; null for any other. */
export function workspaceWaitingText(
  store: Pick<Store, "seatSession" | "run" | "digest">,
  seatIds: readonly string[],
  row: Pick<CmuxSessionRow, "owner" | "name">,
): string | null {
  if (row.owner !== "crew") return null;
  const seat = seatIds.find((id) => row.name.startsWith(`${id} · `));
  const text = seat === undefined ? null : (storedSeatWaiting(store, seat)?.text ?? null);
  if (text === null || text.length <= SIDEBAR_WAITING_MAX) return text;
  return `${text.slice(0, SIDEBAR_WAITING_MAX - 1).trimEnd()}…`;
}
