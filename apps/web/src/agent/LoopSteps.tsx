import {
  type CrewRow,
  ENGINE_NOT_RUNNING,
  type PullRequestView,
  type RunLoop,
  type RunLoopView,
} from "@mc/core";
import { useState } from "react";
import { LOOP_PATH, LOOP_PHASE_LABEL, loopMarks, type StepMark } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { RepoRef } from "../hud/RepoRef.tsx";
import {
  CHECK_CLASS,
  CHECK_ICON,
  heldStep,
  type LoopLimits,
  type LoopStep,
  loopNote,
  loopRule,
  stepChecks,
  stepTries,
  tryClass,
  tryMinutes,
  tryText,
} from "./loopView.ts";
import { endAsideConfirm, endAsideRun, seatError } from "./seat.ts";

/** End run for a run already known to be set aside; the server still refuses if it is not. */
export function EndAsideButton({ row, runId }: { row: CrewRow; runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

/** End run for a run set aside in review (its PR in review, its seat free); nothing otherwise. */
function EndAsideRun({ row, runId }: { row: CrewRow; runId: string }) {
  const aside = useResource<{ loop: RunLoop | null }>(RESOURCES.runLoop(runId)).data?.loop?.aside;
  return aside ? <EndAsideButton row={row} runId={runId} /> : null;
}

const dotOf = (mark: StepMark, i: number): string | number =>
  mark === "done" ? "✓" : mark === "cur" ? "●" : mark === "held" ? "!" : i + 1;

/**
 * Where a looped run is, as a vertical stepper; `parked` is a held state, not a step. `view` is the
 * run's loop view: without tries (or while it loads) the row's own loop is all there is to show.
 */
export function LoopSteps({
  row,
  view,
  prs,
  limits,
  now,
}: {
  row: CrewRow;
  view: RunLoopView | undefined;
  prs: readonly PullRequestView[] | undefined;
  limits: LoopLimits;
  now: number;
}) {
  const [toggled, setToggled] = useState<ReadonlySet<LoopStep>>(new Set());
  const loop = row.loop;
  if (!loop) return <p className="s muted">{ENGINE_NOT_RUNNING}</p>;
  const runLoop = view?.loop;
  const tries = view?.tries ?? [];
  const endAside = row.run && row.run.endedAt === null && (
    <EndAsideRun row={row} runId={row.run.id} />
  );
  const prRef = loop.prNumber !== null && (
    <div className="vnow">
      <RepoRef repoId={row.repoId} number={loop.prNumber} kind="pr" bare />
    </div>
  );

  if (!runLoop || tries.length === 0) {
    // a parked loop does not say which step it held at: its held line stands, and no step is current
    const marks =
      loop.phase === "parked"
        ? LOOP_PATH.map(() => "todo" as const)
        : loopMarks(loop, row.hudState);
    const n = loop.tries?.n ?? 0;
    return (
      <>
        {loop.phase === "parked" && (
          <div className="vhold s">
            <span className="tdot sm">!</span>
            <span>{loop.text}</span>
          </div>
        )}
        {endAside}
        <div className="vsteps">
          {LOOP_PATH.map((step, i) => {
            const mark = marks[i] as StepMark;
            const current = mark === "cur" || mark === "held";
            return (
              <div
                className={`vstep ${mark === "held" ? "warn" : mark}`}
                key={step}
                aria-current={current ? "step" : undefined}
              >
                <span className="tdot">{dotOf(mark, i)}</span>
                <div className="vhead">
                  <span className="vname">
                    {LOOP_PHASE_LABEL[step]}
                    {current && n > 1 && <span className="titer">×{n}</span>}
                  </span>
                </div>
                {current && <div className="vnow">{loop.text}</div>}
                {current && prRef}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  const marks = loopMarks(
    loop,
    row.hudState,
    loop.phase === "parked" ? (heldStep(tries) ?? undefined) : undefined,
  );
  const toggle = (step: LoopStep) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(step)) next.add(step);
      return next;
    });
  return (
    <>
      {endAside}
      <div className="vsteps">
        {LOOP_PATH.map((step, i) => {
          const mark = marks[i] as StepMark;
          const current = mark === "cur" || mark === "held";
          const open = current || toggled.has(step);
          const own = stepTries(tries, step);
          const count = own.filter((t) => !t.fix).length;
          const minutes = own.reduce((sum, t) => sum + tryMinutes(t, now), 0);
          const failure = own.findLast((t) => t.outcome === "fail" && t.reason);
          const rule = loopRule(step, limits);
          const checks = current ? stepChecks(step, runLoop, view?.review ?? null, prs) : [];
          return (
            <div
              className={`vstep ${mark === "held" ? "warn" : mark}`}
              key={step}
              aria-current={current ? "step" : undefined}
            >
              <span className="tdot">{dotOf(mark, i)}</span>
              <button
                type="button"
                className="vhead"
                aria-expanded={open}
                onClick={() => toggle(step)}
              >
                <span className="vname">
                  {LOOP_PHASE_LABEL[step]}
                  {count > 1 && <span className="titer">×{count}</span>}
                </span>
                {own.length > 0 && <span className="vmeta">{minutes}m</span>}
              </button>
              {current && <div className="vnow">{loop.text}</div>}
              {current && prRef}
              {failure && <div className="vfail">Last failure: {failure.reason}</div>}
              {rule && <div className="vrule">{rule}</div>}
              {open && own.length > 0 && (
                <div className="atts">
                  {own.map((t) => (
                    <div className="att" key={`${t.fix ? "fix" : "try"}${t.n}:${t.startedAt}`}>
                      <span className={t.fix ? "ok-t" : "fg2"}>{t.fix ? "fix" : `try ${t.n}`}</span>
                      <span className={tryClass(t)}>{tryText(t)}</span>
                      <span className="num muted">{tryMinutes(t, now)}m</span>
                    </div>
                  ))}
                </div>
              )}
              {checks.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {checks.map((c) => (
                    <div className="check" key={c.text}>
                      <span className={CHECK_CLASS[c.state]}>{CHECK_ICON[c.state]}</span>
                      <span className={c.state === "wait" ? "muted" : undefined}>{c.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="note xs">{loopNote(limits)}</p>
    </>
  );
}
