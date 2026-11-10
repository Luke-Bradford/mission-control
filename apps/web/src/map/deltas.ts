import { MAP_RECENT_CAP, type MapDelta, type MapSeat, type MapSnapshot, namesOnly } from "@mc/core";

function trail(recent: MapSeat["recent"], files: string[], now: number): MapSeat["recent"] {
  const path = [...recent];
  for (const file of files) {
    if (path.at(-1)?.file === file) path.pop();
    path.push({ file, at: now });
  }
  return path.slice(-MAP_RECENT_CAP);
}

/** Applies an in-order repository-analysis update without inventing missing seat data. */
export function applyDelta(snapshot: MapSnapshot, delta: MapDelta, now: number): MapSnapshot | null {
  if (delta.seq <= snapshot.seq) return snapshot;
  if (delta.seq !== snapshot.seq + 1 || delta.type === "message" || delta.type === "invalidate")
    return null;
  const next: MapSnapshot = { ...snapshot, seats: structuredClone(snapshot.seats), seq: delta.seq };
  if (!("seat" in delta)) return next;
  const seat = next.seats.find((item) => item.seat === delta.seat);
  if (!seat) return null;
  if ("sourceId" in delta && delta.sourceId !== undefined && delta.sourceId !== seat.sourceId)
    return null;
  switch (delta.type) {
    case "call.start": {
      const since = delta.since ?? now;
      seat.calls.push({
        tool: delta.tool,
        detail: delta.detail,
        files: delta.files,
        since,
        ...(delta.id ? { id: delta.id } : {}),
        ...(delta.writeTok === undefined ? {} : { writeTok: delta.writeTok }),
      });
      if (!namesOnly(delta.tool)) seat.recent = trail(seat.recent, delta.files, since);
      break;
    }
    case "call.end": {
      if (delta.error || delta.refused || delta.tests !== null) return null;
      const matches = seat.calls.filter((call) =>
        delta.id
          ? call.id === delta.id
          : call.files.length === delta.files.length && call.files.every((file, i) => file === delta.files[i]),
      );
      if (matches.length !== 1 || seat.calls.length !== 1) return null;
      const call = matches[0];
      if (!call || seat.recent.some((tick) => tick.at > call.since)) return null;
      if (!namesOnly(call.tool)) {
        const suffix = seat.recent.slice(-call.files.length);
        if (
          call.files.length &&
          (suffix.length !== call.files.length || suffix.some((tick, i) => tick.file !== call.files[i]))
        )
          return null;
        if (call.files.length)
          seat.recent = seat.recent.map((tick, i) =>
            i >= seat.recent.length - call.files.length ? { ...tick, at: delta.at ?? now } : tick,
          );
        if (call.writeTok === undefined && !["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(call.tool))
          for (const file of call.files)
            if (!seat.scope.read.includes(file)) seat.scope.read.push(file);
      }
      seat.calls = [];
      break;
    }
    case "state":
      if (delta.state === "parked" || seat.badges.waiting) return null;
      seat.state = delta.state;
      seat.since = delta.since;
      break;
    case "edit":
    case "review":
      return null;
    case "diff": {
      let change = seat.scope.modified.find((item) => item.file === delta.file);
      if (seat.badges.tests && (change?.add !== delta.add || change?.rem !== delta.rem))
        seat.badges.tests.editedSince = true;
      if (!change) {
        change = { file: delta.file, add: 0, rem: 0, source: "diff" };
        seat.scope.modified.push(change);
      }
      Object.assign(change, { add: delta.add, rem: delta.rem, source: "diff" });
      break;
    }
  }
  return next;
}
