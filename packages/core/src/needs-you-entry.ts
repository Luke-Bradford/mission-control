import { FLIGHT_LEFT_NOTE_KEY, FLIGHT_NOT_TRIAGING_KEY } from "./flight.ts";
import { GUARD_ACK_PREFIX } from "./guard.ts";
import type { AttentionItem } from "./types.ts";

/**
 * The entry check for Needs you (#1543). The rules are written once, in the Needs you design spec
 * (docs/superpowers/specs/2026-11-06-comms-needs-you-flight-design.md, "Entry rules"); this is
 * their code. An item counts in the operator's list only when it is a hub alert the operator alone
 * can act on, or FLIGHT's complete question. Anything else goes back to FLIGHT with these reasons.
 */

/** Item keys of the hub's own alerts. Their words are fixed in hub code, not written by an agent. */
const ALERT_KEYS = new Set([
  FLIGHT_NOT_TRIAGING_KEY,
  `note:${FLIGHT_LEFT_NOTE_KEY}`,
  // apps/server/src/update.ts HUB_UPDATE_HELD_KEY; the server test pins the two together
  "note:hub-update-held",
]);

/** A hub alert: the operator alone can act on it, and hub code wrote its words. */
export function needsYouAlert(item: Pick<AttentionItem, "key" | "kind">): boolean {
  return (
    ALERT_KEYS.has(item.key) ||
    item.key.startsWith(`note:${GUARD_ACK_PREFIX}`) ||
    item.kind === "ratelimit"
  );
}

export const NEEDS_YOU_ASK_MAX = 300;

/** brief_item's refusal of an operator brief that fails the entry check; the faults follow. */
export const BRIEF_ENTRY_REFUSED =
  "Not briefed: Needs you takes only a complete question (docs/superpowers/specs/2026-11-06-comms-needs-you-flight-design.md, Entry rules). Fix: ";

/** Text that means an agent pasted machine output instead of writing for a person. */
const RAW_TEXT: readonly [RegExp, string][] = [
  [/https?:\/\//i, "a web address (put links in the ticket or PR, not the question)"],
  [/\b[\w-]+:[\w./#-]+:\d{10,}\b/, "a raw signal id such as kind:key:1793825335003"],
  [/\b\d{12,}\b/, "a raw timestamp"],
  [/^\s*\[[^\]]+\]/, "a [tag] prefix"],
];

/**
 * Why an item may not count in Needs you, in words FLIGHT can act on in one try. Empty when it
 * passes. `at` is the item's raised time; 0 means the hub does not know it.
 */
export function needsYouEntryFaults(
  item: Pick<AttentionItem, "key" | "kind" | "at" | "ticket" | "url" | "brief">,
): string[] {
  if (needsYouAlert(item)) return [];
  const brief = item.brief;
  if (brief === undefined || brief.for !== "operator")
    return ["no brief for the operator: FLIGHT writes one with brief_item, or keeps the item"];
  const faults: string[] = [];
  const ask = brief.ask?.trim() ?? "";
  if (ask === "") faults.push("no question: say in one sentence what the operator must decide");
  else {
    if (!ask.includes("?")) faults.push("the question does not ask anything: end it with ?");
    if (ask.length > NEEDS_YOU_ASK_MAX)
      faults.push(`the question is over ${NEEDS_YOU_ASK_MAX} characters: one sentence`);
    for (const [re, what] of RAW_TEXT) if (re.test(ask)) faults.push(`the question has ${what}`);
  }
  const replies = brief.person?.replies?.length ?? 0;
  const n = brief.options.length;
  if (replies === 0 && (n < 2 || n > 4))
    faults.push(`${n} options: give 2 to 4, each with what happens if chosen`);
  if (brief.options.some((o) => o.label.trim() === "" || o.answer.trim() === ""))
    faults.push("an option has no label or no answer");
  if (brief.recommendation.trim() === "")
    faults.push("no recommendation: say which option FLIGHT would pick, and why");
  if (item.ticket === null && item.url === null)
    faults.push("no ticket or PR: name what the question is about");
  if (item.at <= 0) faults.push("no time raised");
  return faults;
}
