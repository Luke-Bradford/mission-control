import { COMMS_OPEN_PREFIX } from "@mc/core";
import type { Store } from "../store.ts";

/** The tag is legacy only; both keys name one stored labelled FLIGHT question. */
export function flightQuestionKeys(messageId: string, flightId: string): readonly [string, string] {
  return [`tag:${flightId}:${messageId}`, `${COMMS_OPEN_PREFIX}${messageId}`];
}

/** The stored Comms source named by either projection, if it is a labelled question alias. */
export function flightQuestionMessageId(key: string, flightId: string): string | null {
  const tag = `tag:${flightId}:comms:`;
  if (key.startsWith(tag)) return `comms:${key.slice(tag.length)}`;
  const open = `${COMMS_OPEN_PREFIX}comms:`;
  if (key.startsWith(open)) return `comms:${key.slice(open.length)}`;
  return null;
}

/**
 * A real answer remains attached to its old key. Otherwise retain the first bound brief, falling
 * back to the durable Comms item for new questions.
 */
export function canonicalFlightQuestionKey(
  store: Store,
  messageId: string,
  flightId: string,
): string {
  const keys = flightQuestionKeys(messageId, flightId);
  const briefs = store.briefs();
  for (const key of keys) {
    const brief = briefs.get(key);
    if (brief && store.choice(key, brief.at)) return key;
  }
  for (const key of keys) if (briefs.has(key)) return key;
  return keys[1];
}

/** A durable receipt closes either legacy projection without treating an acknowledgement as consent. */
export function flightQuestionChoice(store: Store, messageId: string, flightId: string) {
  const briefs = store.briefs();
  for (const key of flightQuestionKeys(messageId, flightId)) {
    const brief = briefs.get(key);
    if (brief) {
      const choice = store.choice(key, brief.at);
      if (choice) return choice;
    }
  }
  return null;
}

/** Whether this stored line is FLIGHT's labelled question to the operator. */
export function isFlightOperatorQuestion(
  store: Store,
  messageId: string,
  flightId: string | null,
): boolean {
  if (flightId === null) return false;
  const message = store.commsMessage(messageId);
  return message?.from === flightId && message.to === "CAPCOM" && message.label === "question";
}
