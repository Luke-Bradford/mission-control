import { MAP_RECENT_CAP, type MapDelta, type MapSeat, type MapSnapshot, namesOnly } from "@mc/core";

/**
 * A seat's recent accesses after a call touched `files`: each is moved to the end with this time, as
 * the hub lists them (its calls' files in order, a run of one file once at its latest), capped.
 * The hub serves map snapshots at seq 0 today, so LiveMap refetches them instead: this keeps a
 * delta-applied snapshot consistent for when it doesn't.
 */
function trail(recent: MapSeat["recent"], files: string[], now: number): MapSeat["recent"] {
  const touched = new Set(files);
  // a file the call already put at the end (its start) moves, it isn't listed twice
  let keep = recent.length;
  while (keep > 0 && touched.has(recent[keep - 1]?.file as string)) keep--;
  return [...recent.slice(0, keep), ...files.map((file) => ({ file, at: now }))].slice(
    -MAP_RECENT_CAP,
  );
}

/**
 * Apply an in-order map frame. null asks the feed to reload authoritative state (a gap, or a frame
 * that lacks what the snapshot needs), never inventing a missing seat. Only the seats are copied:
 * the tree, imports and history keep their identity, so what is drawn from them is not redone.
 */
export function applyDelta(
  snapshot: MapSnapshot,
  delta: MapDelta,
  now: number,
): MapSnapshot | null {
  if (delta.seq <= snapshot.seq) return snapshot;
  if (delta.seq !== snapshot.seq + 1 || delta.type === "message") return null;
  const next: MapSnapshot = { ...snapshot, seats: structuredClone(snapshot.seats), seq: delta.seq };
  if (!("seat" in delta)) return next;
  const seat = next.seats.find((item) => item.seat === delta.seat);
  if (!seat) return null;
  switch (delta.type) {
    case "call.start":
      seat.calls.push({ tool: delta.tool, detail: delta.detail, files: delta.files, since: now });
      // a name-only listing (Glob) opened none of its files: not read, not on the path
      if (namesOnly(delta.tool)) break;
      for (const file of delta.files)
        if (!seat.scope.read.includes(file)) seat.scope.read.push(file);
      seat.recent = trail(seat.recent, delta.files, now);
      break;
    case "call.end": {
      // End frames lack a tool id and result time; fetch authoritative badge data.
      if (delta.error || delta.refused || (delta.tests && delta.tests.runner !== null)) return null;
      const index = seat.calls.findIndex(
        (call) =>
          call.files.length === delta.files.length &&
          call.files.every((file) => delta.files.includes(file)),
      );
      const listed = index >= 0 && namesOnly(seat.calls[index]?.tool ?? "");
      if (index >= 0) seat.calls.splice(index, 1);
      if (!listed) seat.recent = trail(seat.recent, delta.files, now);
      break;
    }
    case "state":
      // A state frame does not carry the park reason or test-lock queue data.
      if (delta.state === "parked" || seat.badges.waiting) return null;
      seat.state = delta.state;
      seat.since = delta.since;
      break;
    case "edit":
    case "diff": {
      let change = seat.scope.modified.find((item) => item.file === delta.file);
      if (
        seat.badges.tests &&
        (delta.type === "edit" || change?.add !== delta.add || change?.rem !== delta.rem)
      )
        seat.badges.tests.editedSince = true;
      if (!change) {
        change = {
          file: delta.file,
          add: 0,
          rem: 0,
          source: delta.type === "diff" ? "diff" : "churn",
        };
        seat.scope.modified.push(change);
      }
      if (delta.type === "diff")
        Object.assign(change, { add: delta.add, rem: delta.rem, source: "diff" });
      else if (change.source === "churn") {
        change.add += delta.add;
        change.rem += delta.rem;
      }
      break;
    }
    case "review":
      return null;
  }
  return next;
}
