import type {
  CodeHealthFigure,
  CodeHealthFigureState,
  CodeHealthRecommendation,
  CodeHealthRecommendationState,
} from "@mc/core";
import { percent } from "../fmt.ts";
import { label } from "./format.ts";

const number = (value: number) =>
  value.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1 });

/** A day and month in UTC, with the year only when it is not this one. */
export function shortDate(at: number, now = Date.now()): string {
  const date = new Date(at);
  const same = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(same ? {} : { year: "numeric" }),
  });
}

/** A value with its unit; null is unknown and shows `—`, never zero. */
export function measureValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (unit.startsWith("%")) return percent(value, 1);
  if (unit.startsWith("USD")) return `$${value.toFixed(2)}`;
  return unit ? `${number(value)} ${unit}` : number(value);
}

/** The row's "now → target" in words a person can read, with unknown ends named. */
export function nowToTarget(row: CodeHealthRecommendation) {
  const unit = row.measure?.unit ?? "";
  const now = row.measure?.current ?? null;
  const target = row.target.value ?? null;
  return {
    metric: row.target.metric,
    now: measureValue(now, unit),
    target: measureValue(target, unit),
    known: now !== null,
    text: `${now === null ? "not measured" : measureValue(now, unit)} → ${target === null ? "no target set" : measureValue(target, unit)}`,
  };
}

export type Decider = { who: string; owner: string | null; tier: "operator" | "flight" | null };
export function decider(row: CodeHealthRecommendation): Decider {
  const tier = row.decision?.tier ?? null;
  return {
    who: tier === "operator" ? "You" : tier === "flight" ? "FLIGHT" : "Unknown",
    owner: row.decision?.owner ?? null,
    tier,
  };
}

/** The actual accepted review date, or a plain statement that none is set. */
export function reviewDate(state: CodeHealthRecommendationState): string {
  if (state.kind === "accepted") return `Review ${shortDate(state.reviewAt)}`;
  if (state.kind === "snoozed") return `Back ${shortDate(state.until)}`;
  return "Review date unset";
}

export const stateWord = (state: CodeHealthRecommendationState) => {
  const text = label(state.kind);
  return text[0]?.toUpperCase() + text.slice(1);
};

/** The path a proposal takes; the current step is marked in the row's detail. */
export const PATH_STEPS = ["Proposed", "Accepted", "Ticket linked", "Measured"] as const;
export function pathIndex(state: CodeHealthRecommendationState): number {
  if (state.kind === "accepted") return state.linkedWork ? 2 : 1;
  if (state.kind === "paid-off" || state.kind === "no-effect") return 3;
  return 0;
}

export const FIGURE_STATE_WORD: Record<CodeHealthFigureState, string> = {
  available: "Measured",
  partial: "Partly measured",
  unknown: "Unknown",
  "not-collected": "Not collected",
  "not-available": "Not available",
};

/** Whether a rise is good or bad, per figure; null where no direction is better. */
export const BETTER: Record<string, "up" | "down" | null> = {
  merged: null,
  "hub-review": "up",
  rework: "down",
  cost: "down",
};

export function change(figure: CodeHealthFigure): {
  arrow: "▲" | "▼" | "•";
  word: string;
  tone: "ok" | "warn" | "plain";
} {
  const before = figure.comparison?.value ?? null;
  if (figure.value === null || before === null)
    return { arrow: "•", word: "No earlier value", tone: "plain" };
  const delta = figure.value - before;
  const relative = before === 0 ? (delta === 0 ? 0 : 1) : Math.abs(delta) / Math.abs(before);
  if (relative < 0.02) return { arrow: "•", word: "No change", tone: "plain" };
  const up = delta > 0;
  const better = BETTER[figure.id];
  const pct = before === 0 ? "" : `${Math.round(relative * 100)}% `;
  if (better === null || better === undefined)
    return { arrow: up ? "▲" : "▼", word: `${pct}${up ? "more" : "fewer"}`, tone: "plain" };
  const good = (better === "up") === up;
  return { arrow: up ? "▲" : "▼", word: good ? "Better" : "Worse", tone: good ? "ok" : "warn" };
}

export const OUTCOME_WORD = {
  worked: "Worked",
  "no-effect": "No effect",
  worse: "Worse",
  unchanged: "Unchanged",
  unmeasured: "Not measured",
  waiting: "Waiting",
} as const;
