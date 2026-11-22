import { AUDIT_EVERY_HOURS_DEFAULT, auditStartedKey, seatDef } from "@mc/core";
import { runAccountId } from "../accounts/bindings.ts";
import { activeAway } from "../away.ts";
import { pausedSeat } from "../config/crew-pause.ts";
import type { CcConfig } from "../config.ts";
import { accountAtStop, awayQuotaReserve, awayQuotaUnknown } from "../engine/queue.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";

const HOUR_MS = 3_600_000;
/** How often the timer looks at whether the auditor is due. */
export const AUDIT_TICK_MS = 60_000;

/** How often the AUDIT seat runs: the config's `audit.report_every_hours`, else 4 hours. */
export const auditIntervalMs = (config: CcConfig): number =>
  (config.audit?.reportEveryHours ?? AUDIT_EVERY_HOURS_DEFAULT) * HOUR_MS;

/** The first AUDIT seat of each session (one auditor per session). */
const auditSeats = (config: CcConfig) =>
  (config.crew?.sessions ?? []).flatMap((session) => {
    const seat = session.seats.find((s) => !s.retiring && seatDef(s).loop === "audit");
    return seat === undefined ? [] : [seat];
  });

/** When the auditor of a repo's session next runs; null without an AUDIT seat or before a first start. */
export function nextAuditDueAt(config: CcConfig, store: Store, repoId: string): number | null {
  const seat = config.crew?.sessions
    .filter((s) => s.repoId === repoId)
    .flatMap((s) => s.seats)
    .find((s) => !s.retiring && seatDef(s).loop === "audit");
  if (seat === undefined) return null;
  const started = Number(store.getSetting(auditStartedKey(seat.id)));
  return Number.isFinite(started) && started > 0 ? started + auditIntervalMs(config) : 0;
}

/**
 * One timer pass: start each AUDIT seat that is due. A seat is skipped while the crew is paused
 * for it, while it has a run, or while its account is at its stop. The start time is written
 * before the start, so a start that fails waits a full interval.
 */
export async function auditTick(i: {
  config: CcConfig;
  store: Store;
  supervisor: Pick<Supervisor, "startAudit" | "busy" | "endRunByEngine">;
  now: number;
  log?: (line: string) => void;
}): Promise<string[]> {
  const { config, store, supervisor, now } = i;
  const started: string[] = [];
  for (const seat of auditSeats(config)) {
    if (pausedSeat(store, seat.id, null) !== null) continue;
    if (supervisor.busy().some((b) => b.seatId === seat.id)) continue;
    const session = store.seatSession(seat.id);
    // The operator stopped this seat: it stays stopped until they start it.
    if (session?.state === "stopped") continue;
    const runId = session?.runId ?? null;
    const open = runId === null ? undefined : store.run(runId);
    if (runId !== null && open?.endedAt === null) {
      // A run that ended its turn without report_audit never exits by itself: end it after one
      // interval, so the no-report flag is recorded and the next pass can start a new run.
      if (now - open.startedAt >= auditIntervalMs(config) && store.auditReportOfRun(runId) === null)
        await supervisor.endRunByEngine(runId).catch(() => {});
      continue;
    }
    const accountId = runAccountId(store, null, seat.accountId);
    if (accountAtStop(config, store, accountId, now)) continue;
    // Away, the auditor spends no reserve: the test startRun applies to every other non-operator start.
    if (
      activeAway(store, now, config.operator.timezone) &&
      (awayQuotaUnknown(config, store, accountId, now) ||
        awayQuotaReserve(config, store, accountId, now))
    )
      continue;
    const last = Number(store.getSetting(auditStartedKey(seat.id)));
    if (Number.isFinite(last) && last > 0 && now - last < auditIntervalMs(config)) continue;
    store.setSetting(auditStartedKey(seat.id), String(now));
    try {
      await supervisor.startAudit(seat.id);
      started.push(seat.id);
    } catch (e) {
      i.log?.(`audit: could not start ${seat.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return started;
}
