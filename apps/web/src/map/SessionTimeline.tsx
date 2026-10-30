import type { MapSeat } from "@mc/core";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from "react";
import { useTz } from "../clock.ts";
import { hhmm } from "../fmt.ts";
import { seatToken } from "./cards.ts";
import {
  TIMELINE_SPAN_MS,
  type TimeWindow,
  timelineTicks,
  type useSessionTimeline,
} from "./timeline.ts";

const clockIn = (tz: string | null) => (at: number) => (tz ? hhmm(at, tz) : "—");
const AXIS_STEP_MS = 5 * 60_000;
/** An arrow key moves a window edge by this much; a window is never narrower than it. */
const KEY_STEP_MS = 60_000;
/** A tick chosen on its own selects this much time around it. */
const TICK_WINDOW_MS = 60_000;

/**
 * The session timeline under the Changes map: a row per working seat with its ticks over the hub's
 * kept path, a drag to choose a window, Clear window and Play.
 */
export function SessionTimeline({
  timeline,
  seats,
  indices,
  names,
}: {
  timeline: ReturnType<typeof useSessionTimeline>;
  seats: MapSeat[];
  indices: Record<string, number>;
  names: Record<string, string>;
}) {
  const { win, drag, playback, current, anchor, selected } = timeline;
  const clock = clockIn(useTz());
  const dragFrom = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const label = (seat: string) => names[seat] ?? seat;
  const from = anchor - TIMELINE_SPAN_MS;
  const pct = (at: number) => Math.max(0, Math.min(100, ((at - from) / TIMELINE_SPAN_MS) * 100));
  const place = (at: number) => `${pct(at)}%`;
  const shownWindow = drag ?? win;
  const finished = playback !== null && (playback.step >= playback.total || timeline.paused);
  const done = playback !== null && playback.step >= playback.total;
  const PRESETS_MIN = [5, 10];

  const track = () => list.current?.querySelector(".map-timeline-track");
  const timeAt = (clientX: number) => {
    const rect = track()?.getBoundingClientRect();
    if (!rect?.width) return null;
    return from + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * TIMELINE_SPAN_MS;
  };
  const range = (a: number, b: number): TimeWindow => [Math.min(a, b), Math.max(a, b)];
  // a drag over the tracks or the axis picks a window; the presets are the keyboard route
  const startDrag = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    // a tick is a button of its own: capturing the pointer would send its click to the list
    if (
      event.button !== 0 ||
      target.closest(".map-timeline-tick") ||
      !target.closest(".map-timeline-track, .map-timeline-axis-track")
    )
      return;
    const start = timeAt(event.clientX);
    if (start === null) return;
    dragFrom.current = start;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent) => {
    const at = timeAt(event.clientX);
    if (dragFrom.current !== null && at !== null) timeline.setDrag(range(dragFrom.current, at));
  };
  const endDrag = (event: ReactPointerEvent, commit: boolean) => {
    const start = dragFrom.current;
    dragFrom.current = null;
    timeline.setDrag(null);
    const at = timeAt(event.clientX);
    if (!commit || start === null || at === null) return;
    // a click, or a sliver of a drag, chooses nothing
    if (Math.abs(at - start) >= TIMELINE_SPAN_MS / 100) timeline.chooseWindow(range(start, at));
  };

  // the keyboard route to a window: arrows move it (it starts as the last 5 minutes), shift
  // resizes it from its start, Escape clears it
  const keyWindow = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape" && win) {
      timeline.clearWindow();
      return event.preventDefault();
    }
    const dir = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    event.preventDefault();
    const [a, b] = win ?? [anchor - PRESETS_MIN[0] * 60_000, anchor];
    const step = dir * KEY_STEP_MS;
    if (event.shiftKey) {
      timeline.chooseWindow([Math.max(from, Math.min(b - KEY_STEP_MS, a + step)), b]);
      return;
    }
    const width = b - a;
    const start = Math.max(from, Math.min(anchor - width, a + step));
    timeline.chooseWindow([start, start + width]);
  };
  const tickWindow = (at: number): TimeWindow => {
    const start = Math.max(from, Math.min(anchor - TICK_WINDOW_MS, at - TICK_WINDOW_MS / 2));
    return [start, start + TICK_WINDOW_MS];
  };

  const axis: number[] = [];
  for (let t = Math.ceil(from / AXIS_STEP_MS) * AXIS_STEP_MS; t < anchor - 1000; t += AXIS_STEP_MS)
    axis.push(t);

  return (
    <section className="map-timeline" aria-label="Session timeline">
      <div className="map-timeline-controls">
        <strong>Session</strong>
        <span>
          {win
            ? `${clock(win[0])} – ${clock(win[1])} selected`
            : `last ${TIMELINE_SPAN_MS / 60_000} min`}
        </span>
        <button type="button" disabled={!win} onClick={timeline.clearWindow}>
          Clear window
        </button>
        <span className="map-timeline-presets">
          {PRESETS_MIN.map((min) => (
            <button
              type="button"
              key={min}
              onClick={() => timeline.chooseWindow([anchor - min * 60_000, anchor])}
            >
              {`Last ${min} min`}
            </button>
          ))}
          <button type="button" disabled={!win} onClick={timeline.clearWindow}>
            All
          </button>
        </span>
        <button
          type="button"
          disabled={!playback && (!selected || !timeline.canPlay)}
          onClick={timeline.toggle}
        >
          <span aria-hidden="true">{finished ? "↺" : playback ? "■" : "▶"}</span>{" "}
          {playback
            ? finished
              ? "Reset"
              : "Stop"
            : !selected
              ? "Play"
              : !timeline.canPlay
                ? "Nothing to replay"
                : `Play ${label(selected)}`}
        </button>
        {/* read out at the start and the end of a replay; each step between is only shown */}
        <span role="status" aria-label="Playback" className="sr-only">
          {playback && current
            ? playback.step === 1 && !done
              ? `Replaying ${label(playback.seat)}, ${playback.total} steps`
              : done
                ? `${label(playback.seat)} replay finished`
                : ""
            : ""}
        </span>
        <span className="map-timeline-step" aria-hidden="true">
          {playback && current
            ? `${label(playback.seat)} step ${playback.step} of ${playback.total} · ${clock(current.at)} · ${current.changed ? "changed" : "read"} ${current.file.split("/").at(-1)}`
            : ""}
        </span>
      </div>
      <ul
        className="map-timeline-list"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable, so the arrow keys can choose a window
        tabIndex={0}
        aria-label="Working seat timelines"
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Escape"
        ref={list}
        onKeyDown={keyWindow}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
      >
        {seats.map((seat) => (
          <li
            className="map-timeline-row"
            aria-label={`Timeline for ${label(seat.seat)}`}
            key={seat.seat}
          >
            <i
              className="map-timeline-dot"
              aria-hidden="true"
              style={
                {
                  background: `var(${seatToken(seat.seat, indices[seat.seat] ?? 0)})`,
                } as CSSProperties
              }
            />
            <button
              type="button"
              className="map-timeline-seat"
              aria-label={`Replay ${label(seat.seat)}`}
              aria-pressed={selected === seat.seat}
              onClick={() => timeline.select(seat.seat)}
            >
              {label(seat.seat)}
            </button>
            <span
              className="map-timeline-track"
              style={
                {
                  "--timeline-seat": `var(${seatToken(seat.seat, indices[seat.seat] ?? 0)})`,
                } as CSSProperties
              }
            >
              {shownWindow && (
                <i
                  className="map-timeline-window"
                  style={{
                    left: place(shownWindow[0]),
                    width: `${pct(shownWindow[1]) - pct(shownWindow[0])}%`,
                  }}
                />
              )}
              {timelineTicks(seat, anchor).map((tick) => (
                <button
                  type="button"
                  className="map-timeline-tick"
                  data-read={!tick.changed || undefined}
                  data-current={
                    (playback?.seat === seat.seat &&
                      current?.file === tick.file &&
                      current.at === tick.at) ||
                    undefined
                  }
                  key={`${tick.file}:${tick.at}`}
                  style={{ left: place(tick.at) }}
                  title={`${clock(tick.at)} · ${tick.changed ? "changed" : "read"} ${tick.file}`}
                  aria-label={`${clock(tick.at)} ${tick.changed ? "changed" : "read"} ${tick.file}`}
                  onClick={() => timeline.chooseWindow(tickWindow(tick.at))}
                />
              ))}
              {playback && current && (
                <i
                  className="map-timeline-playhead"
                  data-playhead
                  style={{ left: place(current.at) }}
                />
              )}
            </span>
          </li>
        ))}
        <li className="map-timeline-axis" aria-hidden="true">
          <span className="map-timeline-axis-track">
            {axis.map((t) => (
              <span className="map-timeline-axis-label" key={t} style={{ left: place(t) }}>
                {clock(t)}
              </span>
            ))}
            <span className="map-timeline-axis-label map-timeline-axis-now">now</span>
          </span>
        </li>
      </ul>
    </section>
  );
}
