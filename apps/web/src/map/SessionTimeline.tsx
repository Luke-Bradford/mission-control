import type { MapSeat } from "@mc/core";
import { type CSSProperties, type MouseEvent as ReactMouseEvent, useRef } from "react";
import { seatToken } from "./cards.ts";
import {
  TIMELINE_SPAN_MS,
  type TimeWindow,
  timelineTicks,
  type useSessionTimeline,
} from "./timeline.ts";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const AXIS_STEP_MS = 5 * 60_000;

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
  const list = useRef<HTMLUListElement>(null);
  const label = (seat: string) => names[seat] ?? seat;
  const from = anchor - TIMELINE_SPAN_MS;
  const pct = (at: number) => Math.max(0, Math.min(100, ((at - from) / TIMELINE_SPAN_MS) * 100));
  const place = (at: number) => `${pct(at)}%`;
  const shownWindow = drag ?? win;
  const finished = playback !== null && playback.step >= playback.total;

  const startDrag = (event: ReactMouseEvent) => {
    const track = list.current?.querySelector(".map-timeline-track");
    if ((event.target as HTMLElement).closest("button") || !track || event.button !== 0) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const at = (x: number) =>
      from + Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * TIMELINE_SPAN_MS;
    const start = at(event.clientX);
    const range = (x: number): TimeWindow => {
      const end = at(x);
      return [Math.min(start, end), Math.max(start, end)];
    };
    event.preventDefault();
    const move = (e: MouseEvent) => timeline.setDrag(range(e.clientX));
    const up = (e: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const chosen = range(e.clientX);
      timeline.setDrag(null);
      // a click, or a sliver of a drag, chooses nothing
      if (chosen[1] - chosen[0] >= TIMELINE_SPAN_MS / 100) timeline.chooseWindow(chosen);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const axis: number[] = [];
  for (let t = Math.ceil(from / AXIS_STEP_MS) * AXIS_STEP_MS; t < anchor - 1000; t += AXIS_STEP_MS)
    axis.push(t);

  return (
    <section className="map-timeline" aria-label="Session timeline">
      <div className="map-timeline-controls">
        <strong>Session</strong>
        <span>{win ? `${clock(win[0])} – ${clock(win[1])} selected` : "last 15 min"}</span>
        <button type="button" disabled={!win} onClick={timeline.clearWindow}>
          Clear window
        </button>
        <button type="button" disabled={!selected} onClick={timeline.toggle}>
          <span aria-hidden="true">{finished ? "↺" : playback ? "■" : "▶"}</span>{" "}
          {!selected ? "Play" : finished ? "Reset" : playback ? "Stop" : `Play ${label(selected)}`}
        </button>
        {/* a step a few hundred ms apart is not read out; the first and last are */}
        <span
          role="status"
          aria-label="Playback"
          aria-live={playback && !finished ? "off" : "polite"}
        >
          {playback && current
            ? `${label(playback.seat)} step ${playback.step} of ${playback.total} · ${clock(current.at)} · ${current.changed ? "changed" : "read"} ${current.file.split("/").at(-1)}`
            : ""}
        </span>
      </div>
      <ul
        className="map-timeline-list"
        aria-label="Working seat timelines"
        ref={list}
        onMouseDown={startDrag}
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
                <i
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
