import type { CrewRow } from "@mc/core";
import { ApiError, apiPost } from "../api.ts";
import { callSign } from "../crew.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";

/** The server's own refusal text, else a fixed line. */
export const seatError = (e: unknown): string =>
  e instanceof ApiError ? e.message : "server unreachable";

const done = (): void => hub.refetch(RESOURCES.crew.path);

/** Stop the seat's current turn. Both control routes require a `{}` body. */
export async function interruptSeat(row: Pick<CrewRow, "id">): Promise<void> {
  try {
    await apiPost(ACTIONS.seatInterrupt(row.id), {});
  } finally {
    done();
  }
}

/** End the seat's run; the checkout and branch stay. */
export async function endSeat(row: Pick<CrewRow, "id">): Promise<void> {
  try {
    await apiPost(ACTIONS.seatEnd(row.id), {});
  } finally {
    done();
  }
}

export async function messageSeat(
  row: Pick<CrewRow, "id">,
  text: string,
  interrupt: boolean,
): Promise<void> {
  try {
    await apiPost(ACTIONS.seatMessage(row.id), interrupt ? { text, interrupt } : { text });
  } finally {
    done();
  }
}

export const endConfirm = (row: Pick<CrewRow, "id" | "kind">): string =>
  `End ${callSign(row)}'s run? The checkout and branch stay; nothing is pushed.`;
