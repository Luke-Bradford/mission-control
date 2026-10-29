import type { CrewLoop, HudState, RunDigest } from "@mc/core";
import {
  LOOP_PATH,
  LOOP_PATH_TITLE,
  loopMarks,
  loopPathTitle,
  loopStepLabel,
  loopSteps,
  loopTemplate,
  loopTryText,
  PLAN_STEP,
  type StepMark,
  stepMarks,
  WAIT_WARN,
} from "../crew.ts";
import { cutText, mss } from "../fmt.ts";
import "./LoopStep.css";

const MARK_CLASS: Record<StepMark, string | undefined> = {
  done: "d",
  cur: "c",
  held: "w",
  todo: undefined,
};

/**
 * The Overview's Loop step cell (catalogue §2.1.2): "{template} › **{node}**" with the try from the
 * second on, the step bar, then a line saying what the run waits on.
 */
export function LoopStep({
  compact = false,
  loop,
  hudState,
  wait,
  elapsed,
  live,
  now,
}: {
  compact?: boolean;
  loop: CrewLoop;
  hudState: HudState;
  wait: string | null;
  elapsed?: number | null;
  live?: RunDigest["liveTool"];
  now?: number;
}) {
  const planMark: StepMark =
    loop.planned || loop.phase === "done" ? "done" : loop.phase === "parked" ? "held" : "todo";
  const marks = compact ? [planMark, ...loopMarks(loop, hudState)] : stepMarks(loop, hudState);
  const steps = compact ? [PLAN_STEP, ...LOOP_PATH] : loopSteps(loop).map((step) => step.name);
  const warn = loop.wait != null && WAIT_WARN.includes(loop.wait);
  return (
    <>
      <span
        className="ellip xs"
        title={`${loopTemplate(loop)} › ${loopStepLabel(loop)}${loopTryText(loop)}${elapsed !== undefined ? ` · ${elapsed === null ? "—" : mss(elapsed)} in this step` : ""} · ${loop.text}${compact && wait ? ` · ${wait}` : ""}`}
      >
        {!compact && <>{loopTemplate(loop)} › </>}
        <b>{loopStepLabel(loop)}</b>
        {!compact && loopTryText(loop)}
        {elapsed !== undefined && (
          <>
            {" "}
            · <span className="num">{elapsed === null ? "—" : mss(elapsed)}</span> in this step
          </>
        )}
      </span>
      <span
        className="stepbar"
        title={compact ? `${PLAN_STEP} → ${LOOP_PATH_TITLE}` : loopPathTitle(loop)}
        aria-hidden="true"
      >
        {marks.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Profile step order is fixed; names may repeat.
          <i key={`${i}:${steps[i]}`} className={MARK_CLASS[m]} />
        ))}
      </span>
      {!compact && wait === null && <ProcessLine live={live} now={now} />}
      {!compact && wait !== null && (
        <span className={`ellip xs loopwait ${warn ? "warn-t" : "fg2"}`} title={wait}>
          {wait}
        </span>
      )}
    </>
  );
}

/** The live tool stays visible even when the agent has no build loop. */
export function ProcessLine({ live, now }: { live?: RunDigest["liveTool"]; now?: number }) {
  if (!live || now === undefined) return null;
  const text = `${live.name}${live.detail ? ` ${live.detail}` : ""}`;
  return (
    <span className="process-line xs fg2" title={text}>
      <span className="ellip" title={text}>
        {cutText(text, 46)}
      </span>
      <span className="num"> · {mss(now - live.since)}</span>
    </span>
  );
}
