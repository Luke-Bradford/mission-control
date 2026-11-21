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

/**
 * Sends `body` to the target. Resolves to an error message to show, or null when it went through.
 * `picked` is the option of the item's brief that `body` answers with: the hub stores the pick
 * with the message, so the FLIGHT thread draws it as the choice.
 */
export async function sendAnswer(
  target: AnswerTarget,
  flight: FlightSeat | null,
  item: AttentionItem,
  body: string,
  picked?: BriefOption,
): Promise<string | null> {
  if (target.to === "github") return null;
  // A brief the hub wrote acts through its own buttons: the hub takes no pick for it, so its
  // option goes as the plain message it always was.
  const place =
    picked === undefined || item.brief?.by === "hub"
      ? -1
      : (item.brief?.options.indexOf(picked) ?? -1);
  // The item names the message, so it and every reply show in the one FLIGHT thread beside it.
  const thread = {
    itemKey: item.key,
    ...(item.brief && place >= 0 ? { choice: { briefAt: item.brief.at, option: place } } : {}),
  };
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

/** Why `option` cannot be sent now, or null when the server bound it to an action on a current brief. */
export function choiceBlocker(item: AttentionItem, option: BriefOption): string | null {
  const brief = item.brief;
  if (!brief || brief.id === undefined || !brief.binding)
    return "Needs a refreshed brief: this one is not bound to an action.";
  if (brief.state?.freshness !== "current") {
    const reason = brief.state?.reason;
    return brief.state?.freshness === "stale"
      ? `Stale. ${reason ?? ""}`.trim()
      : `Needs a refreshed brief. ${reason ?? ""}`.trim();
  }
  if (item.hold) return "This item is held. Release the hold before choosing.";
  if (option.id === undefined || !brief.binding.actions.some((a) => a.optionId === option.id))
    return "This option has no prepared action.";
  return null;
}

/**
 * The brief and source the server bound `option` to. Only a current, unheld brief whose binding
 * holds an action for the option qualifies; no label, item kind or prose grants it. The page sends
 * only these ids; the server holds the action.
 */
export function boundChoice(
  item: AttentionItem,
  option: BriefOption,
): { briefId: number; sourceRevision: string } | null {
  const brief = item.brief;
  if (choiceBlocker(item, option) !== null || !brief?.binding || brief.id === undefined)
    return null;
  return { briefId: brief.id, sourceRevision: brief.binding.sourceRevision };
}

/** Whether a receipt means the choice stands (or may yet), so its options stay shut. */
export const boundChoiceStands = (r: BriefChoiceReceipt): boolean =>
  r.state !== "refused" && r.state !== "stale";

/** The receipt line: a choice the server has not confirmed says so first. */
export const receiptLine = (r: BriefChoiceReceipt): string =>
  r.state === "pending" || r.state === "dispatching" || r.state === "unknown"
    ? `Not confirmed yet: ${r.text}`
    : r.text;

/**
 * A fresh request id. crypto.randomUUID is missing on a hub served over plain http from a
 * non-local address, so fall back to random bytes; the server accepts letters, digits, `:_-`.
 */
export const newRequestId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `req-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Picks `option` through the bound choice route under `requestId`. Resolves to the server's
 * receipt (the caller reads its state), or the text of why the request did not get an answer.
 */
export async function sendBoundChoice(
  item: AttentionItem,
  option: BriefOption,
  requestId: string,
): Promise<{ receipt: BriefChoiceReceipt } | { error: string }> {
  const bound = boundChoice(item, option);
  if (!bound || option.id === undefined) return { error: "That option cannot be picked here." };
  try {
    const receipt = await apiPost<BriefChoiceReceipt>(ACTIONS.briefChoice(item.key), {
      ...bound,
      optionId: option.id,
      requestId,
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
