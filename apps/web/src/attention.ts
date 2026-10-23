import type { AttentionItem, AttentionOwner } from "@mc/core";

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
