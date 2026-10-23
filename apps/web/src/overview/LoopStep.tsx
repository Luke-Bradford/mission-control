import type { CrewLoop, HudState } from "@mc/core";
import {
  LOOP_PATH,
  LOOP_PATH_TITLE,
  LOOP_PHASE_LABEL,
  loopMarks,
  loopTemplate,
  loopTryText,
  type StepMark,
  WAIT_WARN,
} from "../crew.ts";

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
  loop,
  hudState,
  wait,
}: {
  loop: CrewLoop;
  hudState: HudState;
  wait: string | null;
}) {
  const marks = loopMarks(loop, hudState);
  const warn = loop.wait != null && WAIT_WARN.includes(loop.wait);
  return (
    <>
      <span className="ellip xs" title={loop.text}>
        {loopTemplate(loop)} › <b>{LOOP_PHASE_LABEL[loop.phase]}</b>
        {loopTryText(loop)}
      </span>
      <span className="stepbar" title={LOOP_PATH_TITLE} aria-hidden="true">
        {marks.map((m, i) => (
          <i key={LOOP_PATH[i]} className={MARK_CLASS[m]} />
        ))}
      </span>
      {wait !== null && (
        <span className={`ellip xs loopwait ${warn ? "warn-t" : "fg2"}`} title={wait}>
          {wait}
        </span>
      )}
    </>
  );
}
