import type { MapSnapshot } from "@mc/core";
import { touchedFiles } from "./cards.ts";

/** What the Map says about one file: every seat that changed or read it, and whether it conflicts. */
export interface ChangeVisual {
  changes: {
    seat: string;
    changed: boolean;
    read: boolean;
    add: number;
    rem: number;
    lines: number;
  }[];
  /** This file is in the hub's merge-conflict check. */
  conflict?: boolean;
}

function lineCounts(seat: MapSnapshot["seats"][number], path: string) {
  const change = seat.scope.modified.find((item) => item.file === path);
  const add = change?.add ?? 0;
  const rem = change?.rem ?? 0;
  return { add, rem, lines: add + rem };
}

/** Changes: every seat's changed and read files, with the lines it moved. */
export function changesVisuals(snapshot: MapSnapshot): Record<string, ChangeVisual> {
  const out: Record<string, ChangeVisual> = {};
  snapshot.seats.forEach((seat) => {
    const changed = new Set(
      seat.scope.modified
        .filter((change) => change.add + change.rem > 0)
        .map((change) => change.file),
    );
    const read = new Set([...seat.scope.read, ...touchedFiles(seat)]);
    for (const path of new Set([...changed, ...read])) {
      const visual = out[path] ?? { changes: [] };
      out[path] = visual;
      visual.changes.push({
        seat: seat.seat,
        changed: changed.has(path),
        read: read.has(path),
        ...lineCounts(seat, path),
      });
    }
  });
  return out;
}

/**
 * Changes, inside a time window: a seat keeps a file only if one of its ticks for it falls in the
 * window (the mockup's inWin); a file no seat keeps drops out.
 */
export function windowVisuals(
  visual: Record<string, ChangeVisual>,
  seats: MapSnapshot["seats"],
  win: [from: number, to: number],
): Record<string, ChangeVisual> {
  const seen = new Map(
    seats.map((seat) => [
      seat.seat,
      new Set(
        seat.recent.filter((tick) => tick.at >= win[0] && tick.at <= win[1]).map((t) => t.file),
      ),
    ]),
  );
  const out: Record<string, ChangeVisual> = {};
  for (const [path, v] of Object.entries(visual)) {
    const changes = v.changes.filter((change) => seen.get(change.seat)?.has(path));
    if (changes.length) out[path] = { ...v, changes };
  }
  return out;
}
