/** The Telemetry health band's rules: the crew verdict and the figures it is built from. */
import type { CrewRow, Telemetry } from "@mc/core";

export type Verdict = "Needs attention" | "Watch" | "Healthy";

export interface QuotaWindow {
  /** `account · window`, e.g. `acct-a · 7d`. */
  name: string;
  /** Used share, 0 to 100 and past. */
  pct: number;
  alertAt: number;
  stopAt: number;
  /** When the provider's window resets (epoch ms), or null when not recorded. */
  resetAt: number | null;
}

export interface CrewCounts {
  /** Seats with a live run. */
  running: number;
  /** Seats configured. */
  configured: number;
  /** Open questions waiting on the operator (Needs you), not seats queued for the test lock. */
  waiting: number;
  /** Seats stalled or in error. */
  stalled: number;
}

/** The latest reading of each account window the hub tracks. */
export function quotaWindows(t: Telemetry | undefined): QuotaWindow[] {
  return (t?.series?.quota ?? []).flatMap((q) => {
    const last = q.points.at(-1);
    if (!last) return [];
    return [
      {
        name: `${q.accountId} · ${q.window}`,
        pct: last.pct,
        alertAt: q.alertAt,
        stopAt: q.stopAt,
        resetAt: q.resets.at(-1)?.resetAt ?? null,
      },
    ];
  });
}

/** The window with the highest used share; null when none is tracked. */
export const tightestQuota = (windows: QuotaWindow[]): QuotaWindow | null =>
  windows.reduce<QuotaWindow | null>((a, w) => (a === null || w.pct > a.pct ? w : a), null);

export function crewCounts(rows: CrewRow[], questions: number): CrewCounts {
  return {
    running: rows.filter((r) => r.hudState === "running").length,
    configured: rows.length,
    waiting: questions,
    stalled: rows.filter((r) => r.hudState === "stalled" || r.hudState === "error").length,
  };
}

const seatsText = (c: CrewCounts): string => `${c.running} of ${c.configured} seats running`;

/**
 * Needs attention: a quota at its stop level, a machine capacity warning, or a stalled or errored
 * seat. Watch: a quota at its alert level, or a seat question waiting. Otherwise Healthy.
 */
export function crewVerdict(input: {
  quotas: QuotaWindow[];
  machineWarning: string | null;
  crew: CrewCounts;
}): { word: Verdict; reason: string } {
  const { quotas, machineWarning, crew } = input;
  const stopped = quotas.find((q) => q.pct >= q.stopAt);
  if (stopped) return { word: "Needs attention", reason: `${stopped.name} at stop level` };
  if (machineWarning) return { word: "Needs attention", reason: "machine at its capacity warning" };
  if (crew.stalled > 0)
    return {
      word: "Needs attention",
      reason: `${crew.stalled} ${crew.stalled === 1 ? "seat" : "seats"} stalled or in error`,
    };
  const alert = quotas.find((q) => q.pct >= q.alertAt);
  if (alert) return { word: "Watch", reason: `${alert.name} at alert level` };
  if (crew.waiting > 0)
    return {
      word: "Watch",
      reason: `${crew.running} of ${crew.configured} running · ${crew.waiting} ${crew.waiting === 1 ? "question" : "questions"} waiting`,
    };
  return { word: "Healthy", reason: seatsText(crew) };
}
