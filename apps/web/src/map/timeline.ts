import type { MapSeat } from "@mc/core";
import { useCallback, useEffect, useMemo, useState } from "react";

/** The session timeline shows the last hour, as the v3 mockup does. */
export const TIMELINE_WINDOW_MS = 60 * 60_000;
/** One Play step, as in the mockup. */
export const PLAY_STEP_MS = 380;

export interface TimelineTick {
  file: string;
  at: number;
  changed: boolean;
}
export type TimeWindow = [from: number, to: number];
export interface Playback {
  seat: string;
  /** Ticks revealed so far (1 is the first tick). */
  step: number;
  /** The time the timeline was drawn against when Play began, so the hour does not slide under it. */
  anchor: number;
}

/** `win=<from>,<to>` is minutes ago (the mockup's contract); either order, older end first in the result. */
export function parseWindow(raw: string | null, now: number): TimeWindow | null {
  const parts = raw?.split(",");
  if (parts?.length !== 2) return null;
  const [a, b] = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [now - Math.max(a, b) * 60_000, now - Math.min(a, b) * 60_000];
}

/** The seat's ticks inside the hour (and the chosen window), oldest first. */
export function timelineTicks(seat: MapSeat, now: number, win: TimeWindow | null): TimelineTick[] {
  const changed = new Set(seat.scope.modified.map((change) => change.file));
  return seat.recent
    .filter(
      (tick) =>
        tick.at >= now - TIMELINE_WINDOW_MS &&
        tick.at <= now &&
        (!win || (tick.at >= win[0] && tick.at <= win[1])),
    )
    .sort((a, b) => a.at - b.at)
    .map((tick) => ({ file: tick.file, at: tick.at, changed: changed.has(tick.file) }));
}

/** What Play steps through: the ticks, without a file repeated back to back (the mockup's seqFor). */
export function playSequence(ticks: TimelineTick[]): TimelineTick[] {
  return ticks.filter((tick, i) => ticks[i - 1]?.file !== tick.file);
}

const hashValues = () => new URLSearchParams(window.location.hash.slice(1));
function writeHash(change: (values: URLSearchParams) => void) {
  const values = hashValues();
  change(values);
  const hash = values.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
  );
}

/** The session timeline's state, in step with the `win`, `play` and `step` hash parameters. */
export function useSessionTimeline(seats: MapSeat[], now: number) {
  const [win, setWin] = useState(() => parseWindow(hashValues().get("win"), now));
  const [playSeat, setPlaySeat] = useState<string | null>(() => hashValues().get("play") || null);
  const [playing, setPlaying] = useState<Playback | null>(() => {
    const values = hashValues();
    const seat = values.get("play");
    if (!seat) return null;
    const step = Math.floor(Number(values.get("step")));
    return { seat, step: Number.isFinite(step) && step > 0 ? step : 1, anchor: now };
  });
  const selected = seats.find((seat) => seat.seat === playSeat) ?? seats[0];
  const active = playing && seats.find((seat) => seat.seat === playing.seat);
  const anchor = playing?.anchor ?? now;
  const sequence = useMemo(
    () => (active ? playSequence(timelineTicks(active, anchor, win)) : []),
    [active, anchor, win],
  );
  const step = playing ? Math.min(playing.step, sequence.length) : 0;
  const running = playing !== null && step > 0;
  useEffect(() => {
    if (!playing || step === 0 || step >= sequence.length) return;
    const timer = window.setTimeout(() => {
      setPlaying({ ...playing, step: step + 1 });
      writeHash((values) => {
        values.set("play", playing.seat);
        values.set("step", String(step + 1));
      });
    }, PLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step, sequence.length]);
  const stop = useCallback(() => {
    setPlaying(null);
    writeHash((values) => {
      values.delete("play");
      values.delete("step");
    });
  }, []);
  const clearWindow = useCallback(() => {
    setWin(null);
    writeHash((values) => values.delete("win"));
  }, []);
  const toggle = () => {
    if (playing) return stop();
    if (!selected) return;
    setPlaying({ seat: selected.seat, step: 1, anchor: now });
    writeHash((values) => {
      values.set("play", selected.seat);
      values.set("step", "1");
    });
  };
  const select = (seat: string) => {
    if (playing) stop();
    setPlaySeat(seat);
  };
  const shown = useMemo(() => (running ? sequence.slice(0, step) : []), [running, sequence, step]);
  const marks = useMemo(() => new Map(shown.map((tick, i) => [tick.file, i + 1])), [shown]);
  return {
    win,
    clearWindow,
    selected: selected?.seat ?? null,
    select,
    toggle,
    /** The seat being replayed, and how far, or null when Play is off. */
    playback: running && active ? { seat: active.seat, step, total: sequence.length } : null,
    current: shown.at(-1) ?? null,
    /** Each revealed file's latest step number. */
    marks,
    anchor,
  };
}
