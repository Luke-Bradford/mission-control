import type { CrewLoop, HudState } from "@mc/core";
import {
  BUILD_LOOP_TEMPLATE,
  LOOP_PATH,
  LOOP_PATH_TITLE,
  LOOP_PHASE_LABEL,
  loopMarks,
  type StepMark,
} from "../crew.ts";

const MARK_CLASS: Record<StepMark, string | undefined> = {
  done: "d",
  cur: "c",
  held: "w",
  todo: undefined,
};

/** The Overview's Loop step cell (catalogue §2.1.2): "{template} › **{node}**", then the step bar. */
export function LoopStep({ loop, hudState }: { loop: CrewLoop; hudState: HudState }) {
  const marks = loopMarks(loop, hudState);
  return (
    <>
      <span className="ellip xs" title={loop.text}>
        {BUILD_LOOP_TEMPLATE} › <b>{LOOP_PHASE_LABEL[loop.phase]}</b>
      </span>
      <span className="stepbar" title={LOOP_PATH_TITLE} aria-hidden="true">
        {marks.map((m, i) => (
          <i key={LOOP_PATH[i]} className={MARK_CLASS[m]} />
        ))}
      </span>
    </>
  );
}
