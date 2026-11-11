import type { FlightDecision } from "../flightTypes.ts";

/**
 * What the hub writes when a FLIGHT tool call did nothing: a refusal, a missing item, or a save of
 * FLIGHT's own notes (headline, brief, ledger). They stay in the log (Records); Recent decisions is
 * for what changed something. The hub does not record whether a decision had an effect, so this
 * reads the words it wrote (`headlineSavedText`, the ledger texts and the dismiss refusals).
 */
const NO_EFFECT = [
  /^No open item with that key/i,
  /^Not (?:saved|tracked|closed|dismissed)\b/i,
  /^This item (?:is|belongs|was)\b/i,
  /^This is your own question\b/i,
  /^Saved your headline\b/i,
  /^(?:Tracked|Updated|Closed) \S+ in your ledger\b/i,
];

/** Kinds that only keep FLIGHT's own notes. */
const NOTE_KINDS: readonly FlightDecision["kind"][] = ["brief", "memory"];

/** True when the decision changed something the operator would care about. */
export function changedSomething(d: FlightDecision): boolean {
  if (NOTE_KINDS.includes(d.kind)) return false;
  const text = d.decision.trim();
  return text !== "" && !NO_EFFECT.some((re) => re.test(text));
}
