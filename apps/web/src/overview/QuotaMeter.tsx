import { type HealthRow, type LimitRow, usageCollector } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { Meter } from "../hud/Meter.tsx";

const MINUTE_MS = 60_000;

export function QuotaMeter({
  row,
  accountId,
  window,
  now,
  showAge = false,
  compact = false,
}: {
  row: LimitRow | null;
  accountId?: string;
  window?: "5h" | "7d";
  now: number;
  showAge?: boolean;
  compact?: boolean;
}) {
  const health = useResource<HealthRow[]>(RESOURCES.health).data;
  const note = health?.find(
    (h) => h.collector === usageCollector(accountId ?? row?.accountId ?? ""),
  )?.error;
  const stale = !!note || (!!row && (row.stale || now - row.sampledAt > 60 * 60_000));
  const minutes = row ? Math.max(0, Math.floor((now - row.sampledAt) / MINUTE_MS)) : 0;
  const age = minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
  const nextTry =
    row?.nextTryAt && row.nextTryAt > now
      ? `next try in ${Math.ceil((row.nextTryAt - now) / MINUTE_MS)}m`
      : null;
  return (
    <span
      role={compact ? "cell" : undefined}
      className={compact && stale ? "quota-compact stale" : undefined}
      title={[
        accountId ?? row?.accountId,
        row ? `${row.window} · ${row.used}% used` : null,
        row ? `Last reading ${age} ago` : "No reading yet",
        nextTry,
        note,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Meter
        label={compact ? "" : (row?.window ?? window ?? "Quota")}
        pct={row?.used ?? null}
        projected={
          row?.projected ??
          (row?.fullAt && row.fullAt > row.sampledAt
            ? row.used +
              ((100 - row.used) * (row.resetAt - row.sampledAt)) / (row.fullAt - row.sampledAt)
            : null)
        }
        detail={
          row && !compact && (showAge || row.stale || note)
            ? ` · ${age} ago${nextTry ? ` · ${nextTry}` : ""}`
            : undefined
        }
      />
    </span>
  );
}
