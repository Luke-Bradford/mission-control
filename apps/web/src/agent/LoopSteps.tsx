import { type CrewRow, ENGINE_NOT_RUNNING } from "@mc/core";
import { LOOP_PATH, LOOP_PHASE_LABEL, loopMarks } from "../crew.ts";
import { RepoRef } from "../hud/RepoRef.tsx";

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
