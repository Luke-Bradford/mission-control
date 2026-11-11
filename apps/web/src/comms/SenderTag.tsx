import type { CommsSenderKind } from "@mc/core";
import { useSeatName } from "../crew.ts";

/** The word each kind of sender is tagged with; a seat is tagged with its own name. */
export const SENDER_TAG_WORD: Record<Exclude<CommsSenderKind, "seat">, string> = {
  operator: "YOU",
  controller: "CONTROLLER",
  flight: "FLIGHT",
  hub: "HUB",
};

/**
 * Who sent a message, as a tag from the stored sender kind. A message stored before senders were
 * recorded has no kind and gets no tag: the existing end label is its only attribution, because
 * its sender id cannot say which kind it was.
 */
export function SenderTag({
  from,
  senderKind,
}: {
  from: string;
  senderKind?: CommsSenderKind | null;
}) {
  const nameOf = useSeatName();
  if (!senderKind) return null;
  const word = senderKind === "seat" ? nameOf(from) : SENDER_TAG_WORD[senderKind];
  return (
    <span className="comms-sender-tag" data-testid="sender-tag" data-kind={senderKind}>
      {word}
    </span>
  );
}
