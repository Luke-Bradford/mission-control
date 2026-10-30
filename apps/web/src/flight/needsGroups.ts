import type { AttentionItem } from "@mc/core";
import { isOperatorItem, needsYouItems, sortNeeds } from "../attention.ts";

export interface NeedsGroups {
  /** Asks only the operator can settle, FLIGHT's default aside. */
  asks: AttentionItem[];
  /** Asks FLIGHT will settle by its recommended option unless the operator objects. */
  defaulted: AttentionItem[];
  /** Items FLIGHT owns: handling them, or yet to triage them. */
  handling: AttentionItem[];
  /** Items someone else (a controller, a loop, a work lane) owns. */
  waiting: AttentionItem[];
}

/** Each open item in exactly one group, so no tab lists it twice. */
export function needsGroups(
  attention: readonly AttentionItem[] | undefined,
  keep: (i: AttentionItem) => boolean = () => true,
): NeedsGroups {
  const operator = sortNeeds(needsYouItems(attention));
  const others = (attention ?? []).filter((i) => !isOperatorItem(i) && keep(i));
  return {
    asks: operator.filter((i) => i.defaultDueAt === undefined),
    defaulted: operator.filter((i) => i.defaultDueAt !== undefined),
    handling: others.filter((i) => (i.owner ?? "operator") === "flight"),
    waiting: others.filter((i) => (i.owner ?? "operator") !== "flight"),
  };
}
