import { ATTENTION_KINDS, type AttentionItem, needsYouAlert } from "@mc/core";
import { askerOf, titleOf } from "./QuestionBand.tsx";

/** The orders the open-question list can take. */
export const NEEDS_ORDERS = ["default", "oldest", "newest", "deadline"] as const;
export type NeedsOrder = (typeof NEEDS_ORDERS)[number];
export const ORDER_LABEL: Record<NeedsOrder, string> = {
  default: "Most urgent first",
  oldest: "Oldest first",
  newest: "Newest first",
  deadline: "Soonest deadline",
};

/** The filters; an empty string means no filter. */
export interface NeedsFilters {
  repo: string;
  asker: string;
  text: string;
}
export const NO_FILTERS: NeedsFilters = { repo: "", asker: "", text: "" };

/** A hub alert: the hub raised it and only the operator can fix it. It is not a question. */
export const isAlert = (i: AttentionItem): boolean => i.alert === true || needsYouAlert(i);

/** Who asked, as the row says it (a call sign when the caller knows it). */
export type Asker = (i: AttentionItem) => string;

const FAR = Number.POSITIVE_INFINITY;

/** The server's deadline for an item: FLIGHT's default time. Items without one sort last. */
export const deadlineOf = (i: AttentionItem): number => i.defaultDueAt ?? FAR;

/** Keep the items that match every filter. Text matches the title, question and ticket. */
export function filterNeeds(
  items: readonly AttentionItem[],
  f: NeedsFilters,
  asker: Asker = (i) => askerOf(i),
): AttentionItem[] {
  const q = f.text.trim().toLowerCase();
  return items.filter((i) => {
    if (f.repo !== "" && i.repoId !== f.repo) return false;
    if (f.asker !== "" && asker(i) !== f.asker) return false;
    if (q === "") return true;
    return `${titleOf(i)}\n${i.text}\n${i.ticket ?? ""}`.toLowerCase().includes(q);
  });
}

const cmp = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** Order the items: by kind then oldest (default), oldest, newest, or soonest deadline. */
export function orderNeeds(items: readonly AttentionItem[], order: NeedsOrder): AttentionItem[] {
  const oldest = (i: AttentionItem) => (i.at > 0 ? i.at : FAR);
  const newest = (i: AttentionItem) => (i.at > 0 ? i.at : 0);
  const kind = (i: AttentionItem) => ATTENTION_KINDS.indexOf(i.kind);
  const by: Record<NeedsOrder, (a: AttentionItem, b: AttentionItem) => number> = {
    default: (a, b) => cmp(kind(a), kind(b)) || cmp(oldest(a), oldest(b)),
    oldest: (a, b) => cmp(oldest(a), oldest(b)),
    newest: (a, b) => cmp(newest(b), newest(a)),
    deadline: (a, b) => cmp(deadlineOf(a), deadlineOf(b)) || cmp(oldest(a), oldest(b)),
  };
  return [...items].sort(by[order]);
}

/** The distinct values of a field, for a filter's choices. */
export const distinct = (values: readonly (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => !!v))].sort();
