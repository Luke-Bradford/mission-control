import type { Crew, LimitRow, MachineView } from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { quotaWarnings } from "../quota.ts";

/** Exceptional source facts stay visible above the monitoring canvas even while FLIGHT covers
 * the analytical column. Healthy operation adds no heading or banner height.
 */
export function OverviewConstraints() {
  const limits = useResource<LimitRow[]>(RESOURCES.limits),
    machine = useResource<MachineView>(RESOURCES.machine).data,
    crew = useResource<Crew>(RESOURCES.crew).data,
    lock = useTestLock(),
    now = useNow(),
    tz = useTz();
  const binding =
    limits.data?.filter(
      (row) => row.used >= 100 || (row.fullAt !== null && row.fullAt < row.resetAt),
    ) ?? [];
  const stale =
    !!limits.error || binding.some((row) => row.stale || now - row.sampledAt > 60 * 60_000);
  const warnings = tz ? quotaWarnings(binding, now, tz) : [];
  const stalled =
    lock?.holder &&
    crew?.rows.find((row) => row.id === lock.holder?.seatId)?.hudState === "stalled";
  if (!warnings.length && !machine?.warning && !stalled) return null;
  return (
    <aside className="overview-constraints" aria-label="Current operational constraints">
      {warnings.map((warning) => (
        <span key={warning.text} role="status" className={warning.crit ? "crit-t" : "warn-t"}>
          {warning.text}
          {stale ? " · last received reading; stale" : ""}
        </span>
      ))}
      {machine?.warning && (
        <span role="status" className="warn-t">
          Holding new work · {machine.warning}
        </span>
      )}
      {stalled && lock?.holder && (
        <span role="status" className="warn-t">
          Test lock holder {lock.holder.seatId} has no output · {lock.holder.command}
        </span>
      )}
    </aside>
  );
}
