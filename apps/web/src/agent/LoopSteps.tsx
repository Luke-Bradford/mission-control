import type { CrewRow, PullRequestView, RunLoop, RunLoopView } from "@mc/core";
import { useState } from "react";
import { loopSteps, NO_LOOP, type StepMark, stepMarks } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { cutText, firstLine } from "../fmt.ts";
import { RepoRef } from "../hud/RepoRef.tsx";
import {
  CHECK_CLASS,
  CHECK_ICON,
  heldStep,
  type LoopLimits,
  minutesText,
  parkNote,
  STEP_REASON_MAX,
  stepChecks,
  stepTokens,
  stepTries,
  tokenText,
  tryLines,
  tryMinutes,
} from "./loopView.ts";
import { Reason } from "./Reason.tsx";
import { reviewPark, WaiveReviewFindings } from "./reviewPark.tsx";
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

/** The current step's reason: a park in numbers, else the loop's own text cut to one line. */
function currentReason(loop: CrewRow["loop"] & object, runLoop: RunLoop | null | undefined) {
  if (loop.phase === "parked") {
    const note = parkNote(
      runLoop?.parked?.reason ?? loop.parked ?? loop.text,
      runLoop?.parked?.kind,
      runLoop?.pushFor,
    );
    return { line: note.step, full: note.full };
  }
  const line = cutText(firstLine(loop.text), STEP_REASON_MAX);
  return { line, full: line === loop.text ? null : loop.text };
}

/** A step's tries, one line each, a run of identical outcomes counted as one. */
function Tries({
  tries,
  now,
  parkKind,
}: {
  tries: Parameters<typeof tryLines>[0];
  now: number;
  parkKind: string | null | undefined;
}) {
  return (
    <div className="atts">
      {tryLines(tries, now, parkKind).map((l) => (
        <div className="att" key={l.key}>
          <span className={l.code === "pass" && l.label === "fix" ? "ok-t" : "fg2"}>{l.label}</span>
          <span className={l.tone}>
            {l.code}
            {l.count > 1 && <span className="titer">×{l.count}</span>}
          </span>
          <span className="num muted">{minutesText(l.minutes)}</span>
          <span className="num muted">{tokenText(l.tokens)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Where a looped run is, as a list of steps: state, tries, time and tokens each, and for the
 * current step one short reason. `parked` is a held state, not a step. `view` is the run's loop
 * view: without tries (or while it loads) the row's own loop is all there is to show. Tries and
 * long text stay folded until asked for.
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
  const loop = row.loop;
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  if (!loop) return <p className="s muted">{NO_LOOP}</p>;
  const steps = loopSteps(loop);
  const runLoop = view?.loop;
  const reviewParked = reviewPark(runLoop);
  const tries = view?.tries ?? [];
  const endAside = row.run && row.run.endedAt === null && (
    <EndAsideRun row={row} runId={row.run.id} />
  );
  const prRef = loop.prNumber !== null && (
    <div className="vnow">
      <RepoRef repoId={row.repoId} number={loop.prNumber} kind="pr" bare />
    </div>
  );
  const reason = currentReason(loop, runLoop);

  if (!runLoop || tries.length === 0) {
    // a parked loop does not say which step it held at: its held line stands, and no step is current
    const marks = stepMarks(loop, row.hudState).map((mark) =>
      loop.phase === "parked" && mark === "held" ? "todo" : mark,
    );
    const n = loop.tries?.n ?? 0;
    return (
      <>
        {loop.phase === "parked" && (
          <div className="vhold s">
            <span className="tdot sm">!</span>
            <Reason line={reason.line} full={reason.full} className="vholdtext" />
          </div>
        )}
        {endAside}
        {reviewParked && row.run && (
          <WaiveReviewFindings runId={row.run.id} park={reviewParked} findings={false} />
        )}
        <div className="vsteps">
          {steps.map((step, i) => {
            const mark = marks[i] as StepMark;
            const current = mark === "cur" || mark === "held";
            return (
              <div
                className={`vstep ${mark === "held" ? "warn" : mark}`}
                // biome-ignore lint/suspicious/noArrayIndexKey: Profile step order is fixed; names may repeat.
                key={`${i}:${step.name}`}
                aria-current={current ? "step" : undefined}
              >
                <span className="tdot">{dotOf(mark, i)}</span>
                <div className="vhead">
                  <span className="vname">
                    {step.name}
                    {current && n > 1 && <span className="titer">{n} tries</span>}
                  </span>
                </div>
                {current && loop.phase !== "parked" && (
                  <Reason line={reason.line} full={reason.full} />
                )}
                {current && prRef}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  const marks = stepMarks(
    loop,
    row.hudState,
    loop.phase === "parked" ? (heldStep(tries) ?? undefined) : undefined,
  );
  const toggle = (i: number) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  return (
    <>
      {endAside}
      {reviewParked && row.run && (
        <WaiveReviewFindings runId={row.run.id} park={reviewParked} findings={false} />
      )}
      <div className="vsteps">
        {steps.map((step, i) => {
          const mark = marks[i] as StepMark;
          const current = mark === "cur" || mark === "held";
          const own = step.phase === null ? [] : stepTries(tries, step.phase);
          const count = own.filter((t) => !t.fix).length;
          const minutes = own.reduce((sum, t) => sum + tryMinutes(t, now), 0);
          const failure = own.findLast((t) => t.outcome === "fail" || t.outcome === "stopped");
          const checks =
            current && step.phase !== null
              ? stepChecks(step.phase, runLoop, view?.review ?? null, prs)
              : [];
          const round =
            step.phase === "review" && current ? Math.min(view?.round ?? 1, limits.rounds) : null;
          const open = shown.has(i);
          const last = failure ? tryLines([failure], now)[0] : undefined;
          return (
            <div
              className={`vstep ${mark === "held" ? "warn" : mark}`}
              // biome-ignore lint/suspicious/noArrayIndexKey: Profile step order is fixed; names may repeat.
              key={`${i}:${step.name}`}
              aria-current={current ? "step" : undefined}
            >
              <span className="tdot">{dotOf(mark, i)}</span>
              <button
                type="button"
                className="vhead"
                aria-expanded={own.length > 0 ? open : undefined}
                disabled={own.length === 0}
                onClick={() => toggle(i)}
              >
                <span className="vname">
                  {step.name}
                  {round !== null ? (
                    <span className="titer">{`round ${round}/${limits.rounds}`}</span>
                  ) : (
                    count > 1 && <span className="titer">{count} tries</span>
                  )}
                </span>
                {own.length > 0 && (
                  <span className="vmeta">
                    {minutesText(minutes)} · {tokenText(stepTokens(own))}
                  </span>
                )}
              </button>
              {current && <Reason line={reason.line} full={reason.full} />}
              {!current && last && <div className="vfail">last: {last.code}</div>}
              {current && prRef}
              {open && (
                <Tries tries={own} now={now} parkKind={current ? runLoop.parked?.kind : null} />
              )}
              {checks.length > 0 && (
                <div style={{ marginTop: "var(--sp-1)" }}>
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
    </>
  );
}
