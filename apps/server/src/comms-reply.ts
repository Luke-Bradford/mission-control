import type { CommsReplyRoute } from "@mc/core";
import { commsTicketForm } from "./comms.ts";
import type { CcConfig } from "./config.ts";
import { flightSeat } from "./flight/seat.ts";
import type { Store } from "./store.ts";

/**
 * Where the operator's reply to a seat's message goes. When the run that wrote it has ended, the
 * reply goes to the seat now on that ticket, or to FLIGHT when none is. Replies only: an answer
 * to a question never takes this path (it is bound to the run that asked, or goes to FLIGHT).
 * Null when the message is unknown.
 */
export function replyRoute(
  d: { config: CcConfig; store: Store; crew: () => readonly string[] },
  messageId: string,
): CommsReplyRoute | null {
  const { store } = d;
  const original = store.commsMessage(messageId);
  if (original === null) return null;
  const writerRun = store.commsStamp(original.id).runId;
  const run = writerRun === null ? null : store.run(writerRun);
  if (!d.crew().includes(original.from) || run === null || run.endedAt === null)
    return { to: original.from, redirected: false, note: "" };
  const ticket = commsTicketForm(original.ticket ?? run.ticket);
  const now = ticket === null ? undefined : seatOnTicket(d, ticket);
  const flightId = flightSeat(d.config)?.seat.id ?? null;
  const to = now ?? flightId ?? original.from;
  const where = now !== undefined ? `${now}, now on ${ticket}` : "FLIGHT, as no seat is on it now";
  return {
    to,
    redirected: true,
    note: `The run that wrote this has ended. Your reply goes to ${where}.`,
  };
}

/** The crew seat whose live run is on the ticket, if any. */
function seatOnTicket(
  d: { store: Store; crew: () => readonly string[] },
  ticket: string,
): string | undefined {
  return d.crew().find((seatId) => {
    const runId = d.store.seatSession(seatId)?.runId;
    const run = runId == null ? null : d.store.run(runId);
    return run !== null && run.endedAt === null && commsTicketForm(run.ticket) === ticket;
  });
}
