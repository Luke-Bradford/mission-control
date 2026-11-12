import type { BoardItem } from "@mc/core";
import { priorityRank } from "./cards.ts";

/**
 * The Board view: a display filter kept in this browser. It narrows which cards the Board draws and
 * nothing else: no issue changes, no dispatch changes, nothing reaches GitHub.
 */
export type Choice = { kind: "any" } | { kind: "none" } | { kind: "some"; values: string[] };

export interface BoardView {
  labels: Choice;
  /** With several labels chosen: a card needs one of them (any) or every one of them (all). */
  labelMatch: "any" | "all";
  priority: Choice;
  assignee: Choice;
  milestone: Choice;
}

export type ViewField = "labels" | "priority" | "assignee" | "milestone";
export const VIEW_FIELDS: readonly ViewField[] = ["labels", "priority", "assignee", "milestone"];

export const ANY: Choice = { kind: "any" };
export const DEFAULT_VIEW: BoardView = {
  labels: ANY,
  labelMatch: "any",
  priority: ANY,
  assignee: ANY,
  milestone: ANY,
};

export const VIEW_UNREADABLE_TEXT = "The saved Board view could not be read. Showing all cards.";
export const VIEW_NOT_SAVED_TEXT =
  "Not saved: this browser refused storage. The view applies until you reload.";
export const VIEW_QUERY_NOTE = "Lane query; Board view not included";

/** Logins are case-insensitive on GitHub; every other value matches exactly. */
const same = (field: ViewField, a: string, b: string): boolean =>
  field === "assignee" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The values a card has for a field. */
export function valuesOf(field: ViewField, item: BoardItem): string[] {
  switch (field) {
    case "labels":
      return item.labels;
    case "assignee":
      return item.assignees ?? [];
    case "priority":
      return item.priority === null ? [] : [item.priority];
    case "milestone":
      return item.milestone === null ? [] : [item.milestone];
  }
}

function fits(view: BoardView, field: ViewField, item: BoardItem): boolean {
  const choice = view[field];
  if (choice.kind === "any") return true;
  const have = valuesOf(field, item);
  if (choice.kind === "none") return have.length === 0;
  const has = (want: string) => have.some((h) => same(field, h, want));
  return field === "labels" && view.labelMatch === "all"
    ? choice.values.every(has)
    : choice.values.some(has);
}

export const matchesView = (view: BoardView, item: BoardItem): boolean =>
  VIEW_FIELDS.every((field) => fits(view, field, item));

/** How many of the four groups narrow the Board. */
export const activeGroups = (view: BoardView): number =>
  VIEW_FIELDS.filter((field) => view[field].kind !== "any").length;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function parseChoice(raw: unknown): Choice | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "any" || raw.kind === "none") return { kind: raw.kind };
  if (
    raw.kind === "some" &&
    Array.isArray(raw.values) &&
    raw.values.length > 0 &&
    raw.values.every((v) => typeof v === "string")
  )
    return { kind: "some", values: raw.values as string[] };
  return null;
}

/** Null: nothing saved. "unreadable": something is saved that is not a Board view. */
export function parseView(raw: string | null): BoardView | "unreadable" | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!isRecord(json)) return "unreadable";
  const labels = parseChoice(json.labels);
  const priority = parseChoice(json.priority);
  const assignee = parseChoice(json.assignee);
  const milestone = parseChoice(json.milestone);
  if (!labels || !priority || !assignee || !milestone) return "unreadable";
  if (json.labelMatch !== "any" && json.labelMatch !== "all") return "unreadable";
  return { labels, labelMatch: json.labelMatch, priority, assignee, milestone };
}

/** What the editor offers for each field: the values on the cards it was given. */
export function optionsFrom(items: BoardItem[]): Record<ViewField, string[]> {
  const collect = (field: ViewField): string[] => {
    const seen = new Map<string, string>();
    for (const item of items)
      for (const v of valuesOf(field, item)) {
        const key = field === "assignee" ? v.toLowerCase() : v;
        if (!seen.has(key)) seen.set(key, v);
      }
    return [...seen.values()];
  };
  return {
    labels: collect("labels").sort((a, b) => a.localeCompare(b)),
    priority: collect("priority").sort(
      (a, b) => priorityRank(a) - priorityRank(b) || a.localeCompare(b),
    ),
    assignee: collect("assignee").sort((a, b) => a.localeCompare(b)),
    milestone: collect("milestone").sort((a, b) => a.localeCompare(b)),
  };
}
