import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type AttentionKind,
  type AttentionOwner,
} from "@mc/core";
import { RESOURCES, useResource } from "./data.ts";
import { NEEDS_YOU_PANEL, NEEDS_YOU_PATH, navigate } from "./router.ts";

/**
 * Go to Needs you's home. Already there (the URL is the same, so navigating does nothing), it
 * brings the panel back into view instead.
 */
export function openNeedsYou(): void {
  if (window.location.pathname + window.location.hash === NEEDS_YOU_PATH) {
    document.getElementById(NEEDS_YOU_PANEL)?.scrollIntoView?.({ block: "nearest" });
  } else navigate(NEEDS_YOU_PATH);
}

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
 * filter.
 */
export function needsYouItems(items: readonly AttentionItem[] | undefined): NeedsYou {
  const seen = new Set<string>();
  return (items ?? []).filter((i) => {
    if (!isOperatorItem(i) || seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  }) as unknown as NeedsYou;
}

/** `needsYouItems` over the live attention list. */
export function useNeedsYou(): NeedsYou {
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
