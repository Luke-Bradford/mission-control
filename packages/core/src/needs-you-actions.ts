import { WAITING_OPERATOR_LABEL } from "./flight.ts";

/** What the operator can do with a question on Needs you besides pick an option or hold it. */
export const NEEDS_YOU_OFFERS = ["not-now", "drop"] as const;
export type NeedsYouOffer = (typeof NEEDS_YOU_OFFERS)[number];

/** The colour of the `waiting:operator` label when the hub creates it (GitHub's hex, no #). */
export const WAITING_OPERATOR_COLOR = "fbca04";

/**
 * The one comment Not now posts on the ticket: the question, its options and the date. It names
 * no other item and mentions nobody, so GitHub notifies no one.
 */
export function notNowComment(
  question: string,
  options: readonly { label: string; answer: string }[],
  at: number,
): string {
  const lines = [
    `Set aside on ${new Date(at).toISOString().slice(0, 10)}. This ticket waits on a question for the operator:`,
    "",
    ...question.split("\n").map((l) => `> ${l}`),
  ];
  if (options.length > 0) {
    lines.push("", "Options:", ...options.map((o) => `- ${o.label}: ${o.answer}`));
  }
  lines.push(
    "",
    `The ${WAITING_OPERATOR_LABEL} label keeps FLIGHT from promoting this ticket. Remove it and move the card when you are ready. (Mission Control)`,
  );
  return lines.join("\n");
}

/** The one comment Drop posts when it closes the ticket as not planned. */
export const dropComment = (at: number): string =>
  `Dropped by the operator on ${new Date(at).toISOString().slice(0, 10)}: not planned. Reopen if wrong. (Mission Control)`;

export const NOT_NOW_REFUSED = "Not set aside:";
export const DROP_REFUSED = "Not dropped:";
