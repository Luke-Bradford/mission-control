import { MAP_RECENT_MS, type MapSeat } from "@mc/core";
import { useEffect, useState } from "react";

/** The whole map wakes only at a path/docking boundary or a timeline minute. Detail clocks tick separately. */
export function useMapTime(seats: MapSeat[], interval = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const at = Date.now();
      let next = Math.floor(at / interval) * interval + interval;
      for (const seat of seats) {
        for (const boundary of [
          seat.since + 60_000,
          ...seat.recent.map((tick) => tick.at + MAP_RECENT_MS + 1),
        ])
          if (boundary > at) next = Math.min(next, boundary);
      }
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(1, next - at),
      );
    };
    const visible = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [seats, interval]);
  return now;
}
