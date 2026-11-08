import type { AttentionItem, BriefOption, ChoiceReceipt, CrewRow, ItemDiscussion } from "@mc/core";
import { ApiError, apiPost, errorNote } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightSeat } from "../flight/flightTypes.ts";
import { toggleDock } from "../shell/overlays.ts";

const ASK_PREFIX = "ask:";

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
  return about.trim() === "" ? `Re: ${key}` : `Re: ${key} · ${about}`;
}

export function flightText(key: string, about: string, body: string): string {
  return `${itemLead(key, about)}\n\n${body}`;
}

/** The question id behind an `ask:<id>` item, or null for any other kind. */
export function askedQuestion(key: string): number | null {
  const match = /^ask:(\d+)$/.exec(key);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
      // Name the question, so the answer reaches the run that asked it even if another run is on the seat now.
      const question = askedQuestion(item.key);
      await apiPost(
        ACTIONS.seatMessage(target.seatId),
        question === null ? { text: body } : { text: body, question },
      );
    } else {
      // FLIGHT may be stopped: the hub keeps the message and FLIGHT reads it when it starts.
      if (flight === null) return FLIGHT_NO_SEAT;
      await apiPost(ACTIONS.seatMessage(flight.id), { text: flightText(item.key, about, body) });
      toggleDock(true);
    }
    hub.refetch(RESOURCES.attention.path);
    return null;
  } catch (e) {
    return e instanceof ApiError ? (errorNote(e) ?? e.message) : failure(e);
  }
}

/** Item chat is persisted separately from the global FLIGHT conversation. */
export const askFlight = (
  key: string,
  version: string,
  messageId: string,
  text: string,
): Promise<ItemDiscussion> => apiPost(RESOURCES.discussion(key).path, { version, messageId, text });

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

/**
 * Whether an option can be picked through the choose route: the brief is FLIGHT's (the hub's own
 * briefs act through their own buttons) and the option carries the id the route binds the choice to.
 */
export function choosable(item: AttentionItem, option: BriefOption): boolean {
  const brief = item.brief;
  return (
    brief !== undefined &&
    brief.by !== "hub" &&
    brief.for === "operator" &&
    option.id !== undefined &&
    item.escalationId === null
  );
}

/** Picks `option` on the item's brief. Resolves to the server's receipt, or the text of its refusal. */
export async function sendChoice(
  item: AttentionItem,
  option: BriefOption,
): Promise<{ receipt: ChoiceReceipt } | { error: string }> {
  if (!item.brief || option.id === undefined)
    return { error: "That option cannot be picked here." };
  try {
    const receipt = await apiPost<ChoiceReceipt>(ACTIONS.choose(item.key), {
      optionId: option.id,
      briefAt: item.brief.at,
    });
    hub.refetch(RESOURCES.attention.path);
    return { receipt };
  } catch (e) {
    return { error: e instanceof ApiError ? (errorNote(e) ?? e.message) : failure(e) };
  }
}

/** The line under a recorded choice: where it went and whether the recipient has it yet. */
export function choiceLine(r: ChoiceReceipt, timeZone: string): string {
  const where = r.target === "flight-for-next-run" ? "FLIGHT, for the next run" : r.to;
  if (r.deliveredAt === null) return `Recorded. Stored for ${where}.`;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(r.deliveredAt));
  return `Recorded. ${where} took it at ${time}.`;
}
