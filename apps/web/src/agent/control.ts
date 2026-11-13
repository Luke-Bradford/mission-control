/** The Agents control room's rules: silence, stops, thresholds and the figures each band shows. */
import { type CrewRow, type LiveTask, type RunView, STALL_MS } from "@mc/core";
import { stopLine } from "../crew.ts";
import { shortAge } from "./roster.ts";

/** A working seat with no output for this long shows "Silent". */
export const SILENT_AFTER_MS = STALL_MS;
/** The context bar and ring turn amber from here: the point where the seat hands over. */
export const CONTEXT_HANDOVER_PCT = 75;
/** Figures turn amber past these. */
export const ROUNDS_PER_PR_WARN = 2.1;
export const SHARE_3_PLUS_ROUNDS_WARN_PCT = 30;
export const BLOCKING_PER_REVIEW_WARN = 2.0;

/** How long a working seat has been silent, or null when it is not (or is not working). */
export function silentFor(
  row: Pick<CrewRow, "kind" | "hudState" | "lastOutputAt" | "stateSince">,
  now: number,
): number | null {
  if (row.kind !== "crew" || (row.hudState !== "running" && row.hudState !== "stalled"))
    return null;
  const since = row.lastOutputAt ?? row.stateSince;
  const quiet = now - since;
  return quiet >= SILENT_AFTER_MS ? quiet : null;
}

/** Why a stopped seat is stopped, in words; null when it is not stopped. */
export function stoppedReason(row: CrewRow, now: number, tz: string | null): string | null {
  if (row.hudState !== "stopped") return null;
  if (row.crewPause) return row.crewPause.reason;
  if (row.stop) return stopLine(row.stop, now, tz);
  return row.note ?? row.loop?.parked ?? "Stopped by you.";
}

/** "last output 4m ago", or null when the seat has never produced any. */
export function lastOutputText(row: Pick<CrewRow, "lastOutputAt">, now: number): string | null {
  if (row.lastOutputAt === null) return null;
  const quiet = Math.max(0, now - row.lastOutputAt);
  return quiet < 60_000 ? "last output just now" : `last output ${shortAge(quiet)} ago`;
}

export interface PlanProgress {
  done: number;
  total: number;
}

/** The seat's own task list as progress; null when it has none (the bar and tab then hide). */
export function planProgress(tasks: readonly LiveTask[]): PlanProgress | null {
  if (tasks.length === 0) return null;
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length };
}

export type RunOutcome = "now" | "finished" | "parked" | "ended" | "stopped";

/** A run's outcome in the words the operator uses. */
export function runOutcome(run: Pick<RunView, "status" | "loop">): {
  word: string;
  kind: RunOutcome;
} {
  switch (run.status) {
    case "running":
      return { word: "now", kind: "now" };
    case "ok":
      return { word: "finished", kind: "finished" };
    case "blocked":
      return {
        word: run.loop?.parked ? `parked: ${run.loop.parked}` : "parked",
        kind: "parked",
      };
    case "failed":
      return { word: "stopped by a limit or error", kind: "stopped" };
    default:
      return { word: "ended by you", kind: "ended" };
  }
}

export interface AllTime {
  runs: number;
  firstRunAt: number | null;
  tickets: number;
  hoursInRuns: number;
  costUsd: number | null;
}

/** All-time figures from the runs list the page already loads (its newest runs only). */
export function allTime(runs: readonly RunView[]): AllTime {
  const tickets = new Set(runs.map((r) => r.ticket).filter((t): t is string => t !== null));
  const ms = runs.reduce((sum, r) => sum + (r.endedAt !== null ? r.endedAt - r.startedAt : 0), 0);
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return {
    runs: runs.length,
    firstRunAt: runs.length ? Math.min(...runs.map((r) => r.startedAt)) : null,
    tickets: tickets.size,
    hoursInRuns: ms / 3_600_000,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}
