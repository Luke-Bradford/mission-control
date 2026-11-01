import { OWNER_OPERATOR } from "./hud.ts";
import type { AttentionOwner } from "./hud-model.ts";
import type { AttentionItem } from "./types.ts";

/** The owner of an item from a hub that predates `owner`: the operator's. */
export function itemOwner(i: AttentionItem): AttentionOwner {
  return i.owner ?? OWNER_OPERATOR;
}

/** Whether the item is the operator's to act on (an item with no `owner` is). */
export function isOperatorItem(i: AttentionItem): boolean {
  return itemOwner(i) === OWNER_OPERATOR;
}

declare const NEEDS_YOU: unique symbol;

/**
 * `needsYouItems` output, and only that: a function that takes `NeedsYou` (the Board's
 * `cardNeeds`, `needsMe`) is handed the canonical set, never a raw or session-narrowed list.
 */
export type NeedsYou = readonly AttentionItem[] & { readonly [NEEDS_YOU]: true };

/**
 * The one "Needs you" set: the operator's items, one per key. It is the operator's whole inbox, so
 * the header's session filter never narrows it (nothing waiting on them hides behind a filter).
 * Every surface that says Needs you renders this set: the header button and FLIGHT chat badge, the
 * dock's and Comms' "Waiting on you", Comms' Decisions, FLIGHT's pulse, Stand-up focus and Operator
 * actions, the Overview banner, KPI and Live log filter, and the Board's "You:" chips and Needs-me
 * filter. The metric registry's Needs you (`METRICS.needsYou`) is its length, and the server's
 * Overview history (apps/server/src/overview.ts) counts the same set.
 */
export function needsYouItems(items: readonly AttentionItem[] | undefined): NeedsYou {
  const seen = new Set<string>();
  return (items ?? []).filter((i) => {
    if (!isOperatorItem(i) || seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  }) as unknown as NeedsYou;
}
