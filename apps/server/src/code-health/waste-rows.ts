import {
  CODE_HEALTH_WASTE_FAMILIES,
  type CodeHealthWasteAlarmRow,
  WASTE_CHECK_TITLES,
  WASTE_THRESHOLDS,
  type WasteAlarm,
  wasteThresholdText,
} from "@mc/core";
import type { Store } from "../store.ts";

const HOUR_MS = 3_600_000;
/** FLIGHT or the operator decides on every alarm; none of these checks holds work itself. */
const OWNER = "FLIGHT";

type Family = CodeHealthWasteAlarmRow["check"];

/** What an alarm's level counts, per family. */
const MEASURE_UNIT: Record<Family, string> = {
  "cost-without-output": "x the median cost of its size",
  "coordination-overhead": "USD FLIGHT spent in a day",
  "ticket-churn": "tickets opened in a day",
  "runs-per-ticket": "runs without a merge",
  "failed-review-rounds": "failed review rounds",
  "clearance-waiting": "hours waiting on clearance",
};

/** Ticket churn has three causes, told apart by the subject's suffix; each counts something different. */
const churnUnit = (subject: string): string =>
  subject.endsWith(":restarted")
    ? "runs since it was parked"
    : subject.endsWith(":split")
      ? "ticket that reads as split work"
      : MEASURE_UNIT["ticket-churn"];

const isFamily = (check: string): check is Family =>
  (CODE_HEALTH_WASTE_FAMILIES as readonly string[]).includes(check);

function toRow(a: WasteAlarm, check: Family): CodeHealthWasteAlarmRow {
  return {
    id: `${a.check}:${a.subject}`,
    check,
    title: WASTE_CHECK_TITLES[check],
    scope: { repoId: a.repoId, ticket: a.ticket, runId: a.runId, seatId: a.seatId },
    evidence: a.evidence,
    measure: {
      value: a.level,
      unit: check === "ticket-churn" ? churnUnit(a.subject) : MEASURE_UNIT[check],
    },
    threshold: wasteThresholdText(check),
    // Only FLIGHT's own spend is recorded in dollars on the alarm; the others do not say.
    costUsd: check === "coordination-overhead" ? a.level : null,
    owner: OWNER,
    state: "open",
    openedAt: a.openedAt,
  };
}

/**
 * The repo's open waste alarms as Do next rows, from the stored alarm records. One row per
 * check-and-subject cause (the worse, then the newer alarm wins), so a cause that clears and
 * returns keeps its id. No scan runs here.
 */
export function wasteAlarmRows(
  store: Store,
  repoId: string,
  _at: number,
): CodeHealthWasteAlarmRow[] {
  const byCause = new Map<string, WasteAlarm>();
  const open = store.waste.alarms(
    "WHERE closed_at IS NULL AND resolved_at IS NULL AND repo_id = ? ORDER BY opened_at DESC, id DESC",
    repoId,
  );
  for (const a of open) {
    if (!isFamily(a.check)) continue;
    // a clearance wait shows on the Audit page from a day, as on the waste route
    if (a.check === "clearance-waiting" && a.level * HOUR_MS < WASTE_THRESHOLDS.clearanceAuditMs)
      continue;
    const key = `${a.check}\0${a.subject}`;
    const had = byCause.get(key);
    if (had === undefined || a.level > had.level) byCause.set(key, a);
  }
  return [...byCause.values()].map((a) => toRow(a, a.check as Family));
}
