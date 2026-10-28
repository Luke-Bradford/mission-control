import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type AttentionOwner,
} from "@mc/core";
import { RESOURCES, useResource } from "./data.ts";
import { PAGE_PATHS } from "./router.ts";

/**
 * Needs you's home, where the header's button, the FLIGHT pulse and every "all of it" link lead.
 * FLIGHT › Needs you does not exist until #766 builds it; until then it is Plan › Operator actions.
 */
export const NEEDS_YOU_PATH = `${PAGE_PATHS.flight}#askP`;

/** The owner of an item from a hub that predates `owner`: the operator's. */
const DEFAULT_OWNER: AttentionOwner = "operator";

/** Prefix of a work lane's owner, `lane:<login>`. */
const LANE_PREFIX = "lane:";

export function itemOwner(i: AttentionItem): AttentionOwner {
  return i.owner ?? DEFAULT_OWNER;
}

/** Whether the item is the operator's to act on (an item with no `owner` is). */
export function isOperatorItem(i: AttentionItem): boolean {
  return itemOwner(i) === DEFAULT_OWNER;
}

/** The operator's items, for the counts. */
export function operatorItems(items: AttentionItem[]): AttentionItem[] {
  return items.filter(isOperatorItem);
}

/**
 * The one "Needs you" set: the operator's items, one per key. It is the operator's whole inbox, so
 * the header's session filter does not narrow it (nothing waiting on them hides behind a filter);
 * `inRepo` is for a panel that deliberately lists a subset, which must not call itself Needs you.
 * Every surface that says Needs you renders this set: the header button and FLIGHT chat badge, the
 * dock's and Comms' "Waiting on you", Comms' Decisions, FLIGHT's pulse, Stand-up focus and Operator
 * actions, the Overview banner and KPI, and the Board's "You:" chips and Needs-me filter.
 */
export function needsYouItems(
  items: readonly AttentionItem[] | undefined,
  inRepo: (repoId: string) => boolean = () => true,
): AttentionItem[] {
  const seen = new Set<string>();
  return (items ?? []).filter((i) => {
    if (!isOperatorItem(i) || (i.repoId !== null && !inRepo(i.repoId)) || seen.has(i.key)) {
      return false;
    }
    seen.add(i.key);
    return true;
  });
}

/** `needsYouItems` over the live attention list. */
export function useNeedsYou(): AttentionItem[] {
  return needsYouItems(useResource<AttentionItem[]>(RESOURCES.attention).data);
}

/** Sort order of a Needs-you list (catalogue 2.5.1): by kind, the most urgent first. */
export function sortNeeds(items: readonly AttentionItem[]): AttentionItem[] {
  const rank = (i: AttentionItem) => ATTENTION_KINDS.indexOf(i.kind);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** The server words a PR item `PR #n · You: {action}`. */
const PR_ACTION = /^PR #\d+ · You: (.+)$/s;

/** A PR item's action (`decide on the draft`, `review`, `merge`); null for any other item. */
export function prAction(i: AttentionItem): string | null {
  return i.kind === "pr" ? (PR_ACTION.exec(i.text)?.[1] ?? null) : null;
}

/** What an item asks of the operator, in a few words: a PR's action, else its kind (`decision`). */
export function youAction(i: AttentionItem): string {
  return prAction(i) ?? ATTENTION_LABEL[i.kind].toLowerCase();
}

/** Who is handling an item that is not the operator's. */
export function ownerLabel(owner: AttentionOwner): string {
  if (owner.startsWith(LANE_PREFIX)) return "work lane";
  switch (owner) {
    case "flight":
      return "FLIGHT";
    case "controller":
      return "controller";
    case "loop":
      return "loop";
    default:
      return "you";
  }
}
