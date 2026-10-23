import { METER_FULL_PCT, METER_WARN_PCT } from "@mc/core";

/** The class a meter's bar takes: ` full` from METER_FULL_PCT, ` hi` from METER_WARN_PCT, judged on the rounded value. */
export function meterLevel(pct: number | null): "" | " hi" | " full" {
  const n = pct === null ? null : Math.round(pct);
  return n === null ? "" : n >= METER_FULL_PCT ? " full" : n >= METER_WARN_PCT ? " hi" : "";
}

/**
 * A small bar and `{label} {n}%`. The value is rounded first and the colour judged on the rounded
 * number: amber from METER_WARN_PCT, red from METER_FULL_PCT (fixed for every meter; an account's
 * own alert/stop levels show in Setup › Accounts). `—` and no bar when there is no value.
 */
export function Meter({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number | null;
  /** Text after the percentage, e.g. ` used · resets 17:20`. */
  detail?: string;
}) {
  const n = pct === null ? null : Math.round(pct);
  return (
    <span className={`meter${meterLevel(pct)}`}>
      <span className="track">
        {pct !== null && <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
      </span>
      <span className="num xs">{`${label} ${n === null ? "—" : `${n}%`}${detail ?? ""}`}</span>
    </span>
  );
}
