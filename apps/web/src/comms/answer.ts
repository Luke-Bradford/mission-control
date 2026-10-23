import { type AttentionItem, type CrewRow, FLIGHT_NOT_RUNNING } from "@mc/core";
import { ApiError, apiPost, errorNote } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import { toggleDock } from "../shell/overlays.ts";

/** Where an answer to a Needs-you item goes. */
export type AnswerTarget =
  | { to: "github"; url: string | null }
  | { to: "seat"; seatId: string }
  | { to: "flight" };

/** An escalation is answered on GitHub, a crew seat's item by that seat, anything else by FLIGHT. */
export function answerTarget(
  item: AttentionItem,
  rows: CrewRow[] | undefined,
  flight: FlightSeat | null,
): AnswerTarget {
  if (item.escalationId !== null) return { to: "github", url: item.url };
  if (item.agentId !== null && item.agentId === flight?.id) return { to: "flight" };
  const row = rows?.find((r) => r.id === item.agentId);
  if (row?.kind === "crew") return { to: "seat", seatId: row.id };
  return { to: "flight" };
}

/** The line that tells FLIGHT which item a message is about. */
export function itemLead(key: string, about: string): string {
  return about === "" ? `Re: ${key}` : `Re: ${key} · ${about}`;
}

export function flightText(key: string, about: string, body: string): string {
  return `${itemLead(key, about)}\n\n${body}`;
}

const failure = (e: unknown): string => (e instanceof ApiError ? e.message : "server unreachable");

/** Sends `body` to the target. Resolves to an error message to show, or null when it went through. */
export async function sendAnswer(
  target: AnswerTarget,
  flight: FlightSeat | null,
  item: AttentionItem,
  about: string,
  body: string,
): Promise<string | null> {
  if (target.to === "github") return null;
  try {
    if (target.to === "seat") {
      await apiPost(ACTIONS.seatMessage(target.seatId), { text: body });
    } else {
      if (!flight?.live) return FLIGHT_NOT_RUNNING;
      await apiPost(ACTIONS.seatMessage(flight.id), { text: flightText(item.key, about, body) });
      toggleDock(true);
    }
    hub.refetch(RESOURCES.attention.path);
    return null;
  } catch (e) {
    return e instanceof ApiError ? (errorNote(e) ?? e.message) : failure(e);
  }
}

/** Opens a chat with FLIGHT about the item, in the dock. */
export const askFlight = (
  flight: FlightSeat | null,
  item: AttentionItem,
  about: string,
  body: string,
): Promise<string | null> => sendAnswer({ to: "flight" }, flight, item, about, body);

/** Sets the item aside. Resolves to the server's refusal text to show, or null on success. */
export async function dismissItem(key: string): Promise<string | null> {
  try {
    await apiPost(ACTIONS.dismiss(key), {});
    hub.refetch(RESOURCES.attention.path);
    return null;
  } catch (e) {
    return failure(e);
  }
}
