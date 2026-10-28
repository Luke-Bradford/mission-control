import type { AttentionItem, AttentionOwner } from "@mc/core";
import { RESOURCES, useResource } from "./data.ts";
import { useSessionScope } from "./shell/session.ts";

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
 * The one "Needs you" set: the operator's items in the session's view (an item with no repo
 * belongs to no session, so it stays in view), one per key. The header button, FLIGHT's pulse and
 * Stand-up focus all count this; a panel listing a different subset must not call it Needs you.
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

/** `needsYouItems` over the live attention list and the header's session filter. */
export function useNeedsYou(): AttentionItem[] {
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const { inRepo } = useSessionScope();
  return needsYouItems(attention, inRepo);
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
