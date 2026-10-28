import type { AttentionItem, AttentionOwner } from "@mc/core";
import { RESOURCES, useResource } from "./data.ts";

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
 * The header button, FLIGHT's pulse, Stand-up focus, Comms › Needs you and the Overview banner all
 * count this set.
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
