import type {
  AttentionItem,
  BriefChoiceReceipt,
  BriefOption,
  ChoiceReceipt,
  CrewRow,
} from "@mc/core";
import { ApiError, apiPost, errorNote } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { FLIGHT_NO_SEAT, type FlightSeat } from "../flight/flightTypes.ts";

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
  body: string,
): Promise<string | null> {
  if (target.to === "github") return null;
  // The item names the message, so it and every reply show in the one FLIGHT thread beside it.
  const thread = { itemKey: item.key };
  try {
    if (target.to === "seat") {
      // Name the question, so the answer reaches the run that asked it even if another run is on the seat now.
      const question = askedQuestion(item.key);
      await apiPost(
        ACTIONS.seatMessage(target.seatId),
        question === null ? { text: body, ...thread } : { text: body, question, ...thread },
      );
    } else {
      // FLIGHT may be stopped: the hub keeps the message and FLIGHT reads it when it starts.
      if (flight === null) return FLIGHT_NO_SEAT;
      await apiPost(ACTIONS.seatMessage(flight.id), { text: body, ...thread });
    }
    hub.refetch(RESOURCES.attention.path);
    hub.refetchTopic("agents");
    return null;
  } catch (e) {
    return e instanceof ApiError ? (errorNote(e) ?? e.message) : failure(e);
  }
}

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

/**
 * The brief and source the server bound `option` to, when it prepared a typed action for it and
 * the plain choose route would refuse the item: an escalation, or a brief the hub wrote (a hold
 * or a protected decision). The page sends only these ids; the server holds the action.
 */
export function boundChoice(
  item: AttentionItem,
  option: BriefOption,
): { briefId: number; sourceRevision: string } | null {
  const brief = item.brief;
  if (!brief || brief.id === undefined || !brief.binding || option.id === undefined) return null;
  if (item.escalationId === null && brief.by !== "hub") return null;
  const id = option.id;
  if (!brief.binding.actions.some((a) => a.optionId === id)) return null;
  return { briefId: brief.id, sourceRevision: brief.binding.sourceRevision };
}

/** Whether a receipt means the choice stands (or may yet), so its options stay shut. */
export const boundChoiceStands = (r: BriefChoiceReceipt): boolean =>
  r.state !== "refused" && r.state !== "stale";

/**
 * A fresh request id. crypto.randomUUID is missing on a hub served over plain http from a
 * non-local address, so fall back to random bytes; the server accepts letters, digits, `:_-`.
 */
const requestId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `req-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Picks `option` through the bound choice route. Resolves to the server's receipt, or the text
 * of its refusal. A refused or stale receipt comes back as an error so the options stay open.
 */
export async function sendBoundChoice(
  item: AttentionItem,
  option: BriefOption,
): Promise<{ receipt: BriefChoiceReceipt } | { error: string }> {
  const bound = boundChoice(item, option);
  if (!bound || option.id === undefined) return { error: "That option cannot be picked here." };
  try {
    const receipt = await apiPost<BriefChoiceReceipt>(ACTIONS.briefChoice(item.key), {
      ...bound,
      optionId: option.id,
      requestId: requestId(),
    });
    hub.refetch(RESOURCES.attention.path);
    hub.refetchTopic("agents");
    return boundChoiceStands(receipt) ? { receipt } : { error: receipt.text };
  } catch (e) {
    return { error: e instanceof ApiError ? (errorNote(e) ?? e.message) : failure(e) };
  }
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
    hub.refetchTopic("agents");
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
