import { clockHm } from "./hud.ts";

/** The weekly projection above which the budget brake stops new crew runs on an account. */
export const BUDGET_BRAKE_PCT = 100;

/** Note key of the one hub alert while the brake is on (it counts in Needs you as a hub alert). */
export const BUDGET_BRAKE_KEY = "budget-brake";

/** One braked account: its weekly projection at reset and when that week resets (epoch ms). */
export interface BudgetBrakeReading {
  accountId: string;
  projected: number;
  resetAt: number;
}

/** "Sat 8 Nov 09:00" in the operator's timezone. */
export function brakeWhen(at: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(at);
  return `${day} ${clockHm(at, timeZone)}`;
}

/** Why a new start or deal is refused: it names the brake, the projection and the reset. */
export const budgetBrakeText = (call: string, b: BudgetBrakeReading, timeZone: string): string =>
  `Not started: the budget brake is on. ${call}'s account ${b.accountId} is on course for ${Math.round(b.projected)}% of its weekly quota by its reset on ${brakeWhen(b.resetAt, timeZone)}. New runs wait; the brake lifts when the projection falls back under ${BUDGET_BRAKE_PCT}% or the week resets.`;

/** The hub alert in Needs you while the brake is on. */
export function budgetBrakeAlertText(
  brakes: readonly BudgetBrakeReading[],
  timeZone: string,
): string {
  const parts = brakes.map(
    (b) =>
      `${b.accountId} is on course for ${Math.round(b.projected)}% of its weekly quota by its reset on ${brakeWhen(b.resetAt, timeZone)}`,
  );
  const lifts = Math.min(...brakes.map((b) => b.resetAt));
  return `Budget brake is on: ${parts.join("; ")}. New developer and review runs on ${brakes.length === 1 ? "that account" : "those accounts"} are paused and FLIGHT keeps running; runs already going finish their step. It lifts when the projection falls back under ${BUDGET_BRAKE_PCT}%, or at the latest when the week resets (${brakeWhen(lifts, timeZone)}).`;
}
