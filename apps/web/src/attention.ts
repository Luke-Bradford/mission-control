import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type AttentionKind,
  type AttentionOwner,
  isOperatorItem,
  type NeedsYou,
  needsYouItems,
} from "@mc/core";
import { RESOURCES, useResource } from "./data.ts";
import { NEEDS_YOU_PATH, navigate, needsYouPath } from "./router.ts";
import { openItem } from "./shell/overlays.ts";

/** Go to the Needs you page. */
export function openNeedsYou(): void {
  navigate(NEEDS_YOU_PATH);
}

/**
 * Open one waiting item: on the Needs you page when it is the operator's (or not yet triaged),
 * else in the flyout, as before.
 */
export function openNeed(item: AttentionItem): void {
  if (isOperatorItem(item) || item.notTriaging) navigate(needsYouPath(item.key));
  else openItem(item.key);
}

/** Lives in @mc/core so the server's Overview history counts the same set (#762). */
export { isOperatorItem, itemOwner, type NeedsYou, needsYouItems } from "@mc/core";

/** Prefix of a work lane's owner, `lane:<login>`. */
const LANE_PREFIX = "lane:";

/** `needsYouItems` over the live attention list. */
export function useNeedsYou(): NeedsYou {
  return needsYouItems(useResource<AttentionItem[]>(RESOURCES.attention).data);
}

/** The Needs you count as every page shows it; an unknown count is never 0. */
export type NeedsCount =
  | { state: "loading" | "error"; items: readonly AttentionItem[]; n: null }
  | { state: "ready"; items: readonly AttentionItem[]; n: number };

export function useNeedsCount(): NeedsCount {
  const res = useResource<AttentionItem[]>(RESOURCES.attention);
  if (res.data === undefined) return { state: res.error ? "error" : "loading", items: [], n: null };
  const items = needsYouItems(res.data);
  return { state: "ready", items, n: items.length };
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

/** What the operator does about an item, by kind; a kind not listed is named by its label. */
const YOU_VERB: Partial<Record<AttentionKind, string>> = {
  question: "answer",
  decision: "decide",
  approval: "approve",
  person: "reply",
  message: "read",
  tag: "read",
  blocked: "unblock",
  parked: "unblock",
  stalled: "check",
  error: "check",
  review: "review",
  ready: "merge",
  pr: "check the PR",
};

/** What an item asks of the operator, as a verb: a PR's own action, else its kind's (`decide`). */
export function youAction(i: AttentionItem): string {
  return prAction(i) ?? YOU_VERB[i.kind] ?? ATTENTION_LABEL[i.kind].toLowerCase();
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
