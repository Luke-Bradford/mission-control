import type { CrewLoop, HudState, RunDigest } from "@mc/core";
import {
  loopPathTitle,
  loopStepLabel,
  loopSteps,
  loopTemplate,
  loopTryText,
  type StepMark,
  stepMarks,
  WAIT_WARN,
} from "../crew.ts";
import { cutText, mss } from "../fmt.ts";

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
  live,
  now,
}: {
  loop: CrewLoop;
  hudState: HudState;
  wait: string | null;
  live?: RunDigest["liveTool"];
  now?: number;
}) {
  const marks = stepMarks(loop, hudState);
  const steps = loopSteps(loop);
  const warn = loop.wait != null && WAIT_WARN.includes(loop.wait);
  return (
    <>
      <span className="ellip xs" title={loop.text}>
        {loopTemplate(loop)} › <b>{loopStepLabel(loop)}</b>
        {loopTryText(loop)}
      </span>
      <span className="stepbar" title={loopPathTitle(loop)} aria-hidden="true">
        {marks.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Profile step order is fixed; names may repeat.
          <i key={`${i}:${steps[i]?.name}`} className={MARK_CLASS[m]} />
        ))}
      </span>
      {wait === null && live && now !== undefined && (
        <span
          className="ellip xs fg2"
          title={`${live.name}${live.detail ? ` ${live.detail}` : ""}`}
        >
          {cutText(`${live.name}${live.detail ? ` ${live.detail}` : ""}`, 46)} ·{" "}
          {mss(now - live.since)}
        </span>
      )}
      {wait !== null && (
        <span className={`ellip xs loopwait ${warn ? "warn-t" : "fg2"}`} title={wait}>
          {wait}
        </span>
      )}
    </>
  );
}
