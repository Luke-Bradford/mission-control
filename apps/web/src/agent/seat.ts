import type { CrewRow } from "@mc/core";
import { ApiError, apiPost } from "../api.ts";
import { callSign } from "../crew.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";

/** The server's own refusal text, else a fixed line. */
export const seatError = (e: unknown): string =>
  e instanceof ApiError ? e.message : "server unreachable";

const done = (): void => hub.refetch(RESOURCES.crew.path);

/** Stop the seat's current turn. */
export async function interruptSeat(row: Pick<CrewRow, "id">): Promise<void> {
  try {
    await apiPost(ACTIONS.seatInterrupt(row.id), {});
  } finally {
    done();
  }
}

/** End the seat's run; the checkout and branch stay. */
export async function endSeat(row: Pick<CrewRow, "id">, hold = false): Promise<void> {
  try {
    await apiPost(ACTIONS.seatEnd(row.id), hold ? { hold: true } : {});
  } finally {
    done();
  }
}

/** End a run set aside in review, without waking its CLI; the server refuses (409) if it is not aside. */
export async function endAsideRun(runId: string): Promise<void> {
  try {
    await apiPost(ACTIONS.runEnd(runId), {});
  } finally {
    done();
    hub.refetch(RESOURCES.runLoop(runId).path);
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

export const endAsideConfirm = (row: Pick<CrewRow, "id" | "kind">): string =>
  `End ${callSign(row)}'s set-aside run? Its CLI is not woken; the checkout and branch stay.`;

export const endConfirm = (row: Pick<CrewRow, "id" | "kind">, hold = false): string =>
  `${hold ? "Stop" : "End"} ${callSign(row)}'s run? ${hold ? "Its area stays reserved until you remove it. " : ""}The checkout and branch stay; nothing is pushed.`;
