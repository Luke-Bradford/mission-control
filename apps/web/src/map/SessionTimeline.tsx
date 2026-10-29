import type { MapSeat } from "@mc/core";
import type { CSSProperties } from "react";
import { seatToken } from "./cards.ts";
import { TIMELINE_WINDOW_MS, timelineTicks, type useSessionTimeline } from "./timeline.ts";

/** The session timeline under the Changes map: a row per working seat, its ticks, Clear window and Play. */
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
  const { win, playback, current, anchor, selected } = timeline;
  const label = (seat: string) => names[seat] ?? seat;
  const place = (at: number) =>
    `${Math.max(0, Math.min(100, ((at - (anchor - TIMELINE_WINDOW_MS)) / TIMELINE_WINDOW_MS) * 100))}%`;
  const playLabel = !selected
    ? "▶ Play"
    : playback
      ? playback.step >= playback.total
        ? "↺ Reset"
        : "■ Stop"
      : `▶ Play ${label(selected)}`;
  return (
    <section className="map-timeline" aria-label="Session timeline">
      <div className="map-timeline-controls">
        <strong>Session</strong>
        <span>{win ? "selected window" : "last 60 min"}</span>
        <button type="button" disabled={!win} onClick={timeline.clearWindow}>
          Clear window
        </button>
        <button type="button" disabled={!selected} onClick={timeline.toggle}>
          {playLabel}
        </button>
        <span role="status" aria-label="Playback">
          {playback && current
            ? `${label(playback.seat)} step ${playback.step} of ${playback.total} · ${current.changed ? "changed" : "read"} ${current.file.split("/").at(-1)}`
            : ""}
        </span>
      </div>
      <ul className="map-timeline-list" aria-label="Working seat timelines">
        {seats.map((seat) => (
          <li className="map-timeline-row" aria-label={`Timeline for ${seat.seat}`} key={seat.seat}>
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
              {timelineTicks(seat, anchor, win).map((tick) => (
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
                  title={`${tick.changed ? "changed" : "read"} ${tick.file}`}
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
      </ul>
    </section>
  );
}
