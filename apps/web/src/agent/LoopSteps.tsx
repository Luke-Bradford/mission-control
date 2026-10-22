import { type CrewRow, ENGINE_NOT_RUNNING, type RunLoop } from "@mc/core";
import { useState } from "react";
import { LOOP_PATH, LOOP_PHASE_LABEL, loopMarks } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { RepoRef } from "../hud/RepoRef.tsx";
import { endAsideConfirm, endAsideRun, seatError } from "./seat.ts";

/** End run for a run set aside in review (its PR in review, its seat free); nothing otherwise. */
function EndAsideRun({ row, runId }: { row: CrewRow; runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aside = useResource<{ loop: RunLoop | null }>(RESOURCES.runLoop(runId)).data?.loop?.aside;
  if (!aside) return null;
  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      await endAsideRun(runId);
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="s">
      <button
        type="button"
        className="sm warn"
        disabled={busy}
        onClick={() => {
          if (window.confirm(endAsideConfirm(row))) void end();
        }}
      >
        End run
      </button>
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Where a looped run is, as a vertical stepper; `parked` is a held state, not a step. */
export function LoopSteps({ row }: { row: CrewRow }) {
  const loop = row.loop;
  if (!loop) return <p className="s muted">{ENGINE_NOT_RUNNING}</p>;
  // a parked loop does not say which step it held at: its held line stands, and no step is current
  const marks =
    loop.phase === "parked" ? LOOP_PATH.map(() => "todo" as const) : loopMarks(loop, row.hudState);
  return (
    <>
      {loop.phase === "parked" && (
        <div className="vhold s">
          <span className="tdot sm">!</span>
          <span>{loop.text}</span>
        </div>
      )}
      {row.run && <EndAsideRun row={row} runId={row.run.id} />}
      <div className="vsteps">
        {LOOP_PATH.map((step, i) => {
          const mark = marks[i];
          const state = mark === "held" ? "warn" : mark;
          const current = mark === "cur" || mark === "held";
          return (
            <div
              className={`vstep ${state}`}
              key={step}
              aria-current={current ? "step" : undefined}
            >
              <span className="tdot">
                {mark === "done" ? "✓" : mark === "cur" ? "●" : mark === "held" ? "!" : i + 1}
              </span>
              <div className="vhead">
                <span className="vname">{LOOP_PHASE_LABEL[step]}</span>
              </div>
              {current && <div className="vnow">{loop.text}</div>}
              {current && loop.prNumber !== null && (
                <div className="vnow">
                  <RepoRef repoId={row.repoId} number={loop.prNumber} kind="pr" bare />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
