import { MAP_RECENT_MS, type MapSeat } from "@mc/core";
import { useCallback, useEffect, useMemo, useState } from "react";

/** The timeline spans what the hub keeps of a seat's path (MAP_RECENT_MS); nothing older is invented. */
export const TIMELINE_SPAN_MS = MAP_RECENT_MS;
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
  /** The ticks Play steps through, fixed when it starts, so the clock does not shift them. */
  seq: TimelineTick[];
  /** Ticks revealed so far (1 is the first tick). */
  step: number;
  /** The time the timeline was drawn against when Play began. */
  anchor: number;
  /** Restored from a link: it shows its step and waits, rather than running on. */
  paused: boolean;
}

/** `win=<from>,<to>` is minutes ago (the mockup's contract); either order, older end first in the result. */
export function parseWindow(raw: string | null, now: number): TimeWindow | null {
  const parts = raw?.split(",");
  if (parts?.length !== 2) return null;
  const [a, b] = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [now - Math.max(a, b) * 60_000, now - Math.min(a, b) * 60_000];
}

/** The `win` value for a window: minutes ago, older end first, to a tenth of a minute. */
export const formatWindow = (win: TimeWindow, now: number): string =>
  win.map((t) => Math.round(((now - t) / 60_000) * 10) / 10).join(",");

export const inWindow = (at: number, win: TimeWindow | null): boolean =>
  !win || (at >= win[0] && at <= win[1]);

/** The seat's ticks inside the span, oldest first; "changed" by the same rule as the map. */
export function timelineTicks(seat: MapSeat, now: number): TimelineTick[] {
  const changed = new Set(
    seat.scope.modified
      .filter((change) => change.add + change.rem > 0)
      .map((change) => change.file),
  );
  return seat.recent
    .filter((tick) => tick.at >= now - TIMELINE_SPAN_MS && tick.at <= now)
    .sort((a, b) => a.at - b.at)
    .map((tick) => ({ file: tick.file, at: tick.at, changed: changed.has(tick.file) }));
}

/** What Play steps through: the ticks in the window, without a file repeated back to back (the mockup's seqFor). */
export function playSequence(ticks: TimelineTick[], win: TimeWindow | null): TimelineTick[] {
  const inside = ticks.filter((tick) => inWindow(tick.at, win));
  return inside.filter((tick, i) => inside[i - 1]?.file !== tick.file);
}

/** The hash's `key=value` segments; others are left as they are. */
const KEYS = ["win", "play", "step"];
function segments(): string[] {
  return window.location.hash.slice(1).split("&").filter(Boolean);
}
const hashValue = (key: string): string | null => {
  for (const segment of segments()) {
    const [k, ...rest] = segment.split("=");
    if (k === key) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
};
/** Set (or, with null, remove) our keys, keeping every other segment of the hash untouched. */
function writeHash(change: Record<string, string | null>) {
  const kept = segments().filter((segment) => {
    const key = segment.split("=")[0] ?? "";
    return !(KEYS.includes(key) && key in change);
  });
  for (const [key, value] of Object.entries(change))
    if (value !== null) kept.push(`${key}=${encodeURIComponent(value).replaceAll("%2C", ",")}`);
  const hash = kept.join("&");
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
  );
}

function restorePlayback(seats: MapSeat[], win: TimeWindow | null, now: number): Playback | null {
  const seat = hashValue("play");
  if (!seat) return null;
  const found = seats.find((item) => item.seat === seat);
  const seq = found ? playSequence(timelineTicks(found, now), win) : [];
  // nothing to replay: a link to a window with no ticks is not a replay
  if (!seq.length) return null;
  const step = Math.floor(Number(hashValue("step")));
  return {
    seat,
    seq,
    step: Math.min(Number.isFinite(step) && step > 0 ? step : 1, seq.length),
    anchor: now,
    paused: true,
  };
}

/** The session timeline's state, in step with the `win`, `play` and `step` hash parameters. */
export function useSessionTimeline(seats: MapSeat[], now: number) {
  const [mountedAt] = useState(() => Date.now());
  const [win, setWin] = useState(() => parseWindow(hashValue("win"), mountedAt));
  const [playSeat, setPlaySeat] = useState<string | null>(() => hashValue("play"));
  const [playing, setPlaying] = useState<Playback | null>(() =>
    restorePlayback(seats, win, mountedAt),
  );
  const [drag, setDrag] = useState<TimeWindow | null>(null);
  const selected = seats.find((seat) => seat.seat === playSeat) ?? seats[0];
  const active = playing ? seats.find((seat) => seat.seat === playing.seat) : undefined;
  const anchor = playing?.anchor ?? now;
  const step = playing ? Math.min(playing.step, playing.seq.length) : 0;
  const running = playing !== null && active !== undefined && step > 0;

  // a replay of a seat that is not on the timeline (a stale link, or it stopped working) ends
  const orphaned = playing !== null && !active;
  useEffect(() => {
    if (!orphaned) return;
    setPlaying(null);
    writeHash({ play: null, step: null });
  }, [orphaned]);

  // a `play` the hash names but nothing is playing is stale: take it out
  useEffect(() => {
    if (playing === null && hashValue("play") !== null) writeHash({ play: null, step: null });
  }, [playing]);

  // a window older than the timeline's span has nothing left in it
  useEffect(() => {
    if (win && win[1] < now - TIMELINE_SPAN_MS) {
      setWin(null);
      writeHash({ win: null });
    }
  }, [win, now]);

  // the hash is the link: following one in place restores what it says
  useEffect(() => {
    const follow = () => {
      const at = Date.now();
      const next = parseWindow(hashValue("win"), at);
      setWin(next);
      setPlaySeat((current) => hashValue("play") ?? current);
      const restored = restorePlayback(seats, next, at);
      setPlaying(restored);
      if (!restored && hashValue("play") !== null) writeHash({ play: null, step: null });
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [seats]);

  const advance = playing !== null && !playing.paused && step > 0 && step < playing.seq.length;
  useEffect(() => {
    if (!playing || !advance) return;
    const timer = window.setTimeout(() => {
      setPlaying({ ...playing, step: step + 1 });
      writeHash({ play: playing.seat, step: String(step + 1) });
    }, PLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, advance, step]);

  const stop = useCallback(() => {
    setPlaying(null);
    writeHash({ play: null, step: null });
  }, []);
  const clearWindow = useCallback(() => {
    setWin(null);
    writeHash({ win: null });
  }, []);
  const chooseWindow = useCallback((next: TimeWindow) => {
    setWin(next);
    writeHash({ win: formatWindow(next, Date.now()) });
  }, []);
  const canPlay = useMemo(
    () => selected !== undefined && playSequence(timelineTicks(selected, now), win).length > 0,
    [selected, now, win],
  );
  const toggle = () => {
    if (playing && active) return stop();
    if (!selected) return;
    const at = Date.now();
    const seq = playSequence(timelineTicks(selected, at), win);
    if (!seq.length) return;
    setPlaying({ seat: selected.seat, seq, step: 1, anchor: at, paused: false });
    writeHash({ play: selected.seat, step: "1" });
  };
  const select = (seat: string) => {
    if (playing) stop();
    setPlaySeat(seat);
  };
  const activeSeat = active?.seat;
  const total = playing?.seq.length ?? 0;
  const playback = useMemo(
    () => (running && activeSeat ? { seat: activeSeat, step, total } : null),
    [running, activeSeat, step, total],
  );
  const shown = useMemo(
    () => (running && playing ? playing.seq.slice(0, step) : []),
    [running, playing, step],
  );
  const marks = useMemo(() => new Map(shown.map((tick, i) => [tick.file, i + 1])), [shown]);
  return {
    win,
    clearWindow,
    chooseWindow,
    drag,
    setDrag,
    selected: selected?.seat ?? null,
    canPlay,
    paused: playing?.paused ?? false,
    select,
    toggle,
    stop,
    /** The seat being replayed, and how far, or null when Play is off. */
    playback,
    current: shown.at(-1) ?? null,
    /** Each revealed file's latest step number. */
    marks,
    anchor,
  };
}
