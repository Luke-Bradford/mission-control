import { COMMS_CAPCOM, COMMS_MC, type CommsMessage, type CommsSenderKind } from "@mc/core";
import { useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";

/** The word each kind of sender is tagged with; a seat is tagged with its own name. */
export const SENDER_TAG_WORD: Record<Exclude<CommsSenderKind, "seat">, string> = {
  operator: "YOU",
  controller: "CONTROLLER",
  flight: "FLIGHT",
  hub: "HUB",
};

/**
 * The kind of sender of a message: the stored kind, else (a message stored before senders were
 * recorded) what its sender id says.
 */
export function senderKindOf(
  message: Pick<CommsMessage, "from" | "senderKind">,
  flightId: string | undefined,
): CommsSenderKind {
  if (message.senderKind) return message.senderKind;
  if (message.from === COMMS_CAPCOM) return "operator";
  if (message.from === COMMS_MC) return "hub";
  if (message.from === flightId) return "flight";
  return "seat";
}

/** Who sent a message, as a tag from the stored sender kind. */
export function SenderTag({ message }: { message: Pick<CommsMessage, "from" | "senderKind"> }) {
  const nameOf = useSeatName();
  const flightId = useResource<{ seat: FlightSeat | null }>(RESOURCES.flight).data?.seat?.id;
  const kind = senderKindOf(message, flightId);
  const word = kind === "seat" ? nameOf(message.from) : SENDER_TAG_WORD[kind];
  return (
    <span className="comms-sender-tag" data-testid="sender-tag" data-kind={kind}>
      {word}
    </span>
  );
}
