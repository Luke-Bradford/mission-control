import { type CrewRow, ENGINE_NOT_RUNNING, type RunLoopView } from "@mc/core";
import { LOOP_PATH, LOOP_PHASE_LABEL } from "../crew.ts";
import type { Resource } from "../data.ts";
import { barClass, barPlace, loopSpan, stepTries, tryMinutes, tryText } from "./loopView.ts";

const LEGEND = [
  ["tl-pass", "passed"],
  ["tl-fail", "failed"],
  ["tl-fix", "fix"],
  ["tl-run", "running"],
  ["tl-wait", "waiting or parked"],
] as const;

/** One bar per try of the run's loop, a row per step, placed by time across the whole run. */
export function LoopTimeline({
  row,
  loopView,
  now,
}: {
  row: CrewRow;
  loopView: Resource<RunLoopView>;
  now: number;
}) {
  if (!row.loop || !row.run) return <p className="s muted">{ENGINE_NOT_RUNNING}</p>;
  const view = loopView.data;
  if (!view) {
    return loopView.error ? (
      <p className="s crit-t">Could not load the loop: {loopView.error.message}</p>
    ) : (
      <p className="s muted">Loading…</p>
    );
  }
  const start = row.run.startedAt;
  const { end, total } = loopSpan(start, row.run.endedAt, now);
  return (
    <>
      {LOOP_PATH.map((step) => (
        <div className="tlrow" key={step}>
          <span className="ellip">{LOOP_PHASE_LABEL[step]}</span>
          <span className="tlbars">
            {stepTries(view.tries, step).map((t) => {
              const { left, width } = barPlace(t, start, end, total);
              return (
                <i
                  key={`${t.fix ? "fix" : "try"}${t.n}:${t.startedAt}`}
                  className={barClass(t)}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${t.fix ? "fix" : LOOP_PHASE_LABEL[step]} try ${t.n} · ${tryText(t)} · ${tryMinutes(t, now)} min`}
                />
              );
            })}
          </span>
        </div>
      ))}
      <div className="legend" style={{ marginTop: 8 }}>
        {LEGEND.map(([cls, label]) => (
          <span key={cls}>
            <i className={cls} />
            {label}
          </span>
        ))}
      </div>
      <p className="note xs">
        Time runs left to right across the whole loop ({Math.round(total / 60_000)} min). A step
        that ran twice shows two bars on its row.
      </p>
    </>
  );
}
