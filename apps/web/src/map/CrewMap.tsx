import type { Crew, MapSeat, MapSnapshot } from "@mc/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { conflictSummary } from "../lenses/lenses.tsx";
import { freshRecent, isWorking, type SeatWork } from "./cards.ts";
import { type ChangeVisual, changesVisuals, windowVisuals } from "./changes.ts";
import { LiveMap } from "./live.ts";
import { branchOnlyFiles, MapTreemap } from "./MapTreemap.tsx";
import { NodeDetail, SeatDetail, SeatSelector, type Selection } from "./Selector.tsx";
import { SessionTimeline } from "./SessionTimeline.tsx";
import { useSessionTimeline } from "./timeline.ts";
import "./map.css";
import { plural } from "../fmt.ts";

/** The feed's health, shown in the deck under the stage. */
export interface MapStatus {
  live: boolean;
  text: string;
}

/** One repo's live map: the snapshot, then its deltas, until the page leaves the repo. */
export function LiveCrewMap({ repo }: { repo: string }) {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    const live = new LiveMap(
      repo,
      () => hub.read<MapSnapshot>(RESOURCES.repoMap(repo)),
      setSnapshot,
      setError,
    );
    live.start();
    return () => live.stop();
  }, [repo]);
  const rows = crew?.rows;
  const indices = useMemo(
    () => Object.fromEntries((rows ?? []).map((r) => [r.id, r.index])),
    [rows],
  );
  const names = useMemo(
    () => Object.fromEntries((rows ?? []).map((r) => [r.id, callSign(r)])),
    [rows],
  );
  // what each seat is on, from its crew row alone, as the Overview names it: ticket, title, PR
  const work = useMemo(
    () =>
      Object.fromEntries(
        (rows ?? []).map((r): [string, SeatWork] => {
          const ticket = Number(r.ticket?.replace(/^.*#/, ""));
          return [
            r.id,
            {
              ticket: r.ticket && Number.isInteger(ticket) ? ticket : null,
              title: r.ticketTitle ?? null,
              pr: r.review?.prNumber ?? r.prs[0]?.number ?? null,
            },
          ];
        }),
      ),
    [rows],
  );
  const status: MapStatus = error
    ? { live: false, text: errorText(error) }
    : { live: true, text: "Live · real time" };
  if (snapshot?.repoId !== repo)
    return (
      <div className="map-wait">
        <p role="status">{error ? errorText(error) : "Loading repo map…"}</p>
      </div>
    );
  return (
    <CrewMapView
      key={repo}
      snapshot={snapshot}
      indices={indices}
      names={names}
      work={work}
      status={status}
    />
  );
}

/** The visual with every conflicting file marked; a file no seat changed keeps a tile of its own. */
function markConflicts(
  visual: Record<string, ChangeVisual>,
  conflicts: MapSnapshot["conflicts"],
): Record<string, ChangeVisual> {
  if (!conflicts.length) return visual;
  const out = { ...visual };
  for (const { file } of conflicts)
    out[file] = { ...(out[file] ?? { changes: [] }), conflict: true };
  return out;
}

/** "Map snapshot unavailable. Retrying every 5 s.", or the feed's own reconnecting notice. */
function errorText(error: Error): string {
  const reason = error.message.trim().replace(/[.…\s]+$/, "");
  const sentence = !reason
    ? "Map unavailable"
    : /^HTTP \d+$/.test(reason)
      ? `Map unavailable (${reason})`
      : reason.charAt(0).toUpperCase() + reason.slice(1);
  return /reconnect|retry/i.test(sentence) ? `${sentence}…` : `${sentence}. Retrying every 5 s.`;
}

const noNames: Record<string, string> = {};
const noWork: Record<string, SeatWork> = {};
const noIndices: Record<string, number> = {};
export function CrewMapView({
  snapshot,
  indices = noIndices,
  names = noNames,
  work = noWork,
  status,
}: {
  snapshot: MapSnapshot;
  indices?: Record<string, number>;
  /** Each seat's call sign (the crew's display name). */
  names?: Record<string, string>;
  /** What each crew seat is on (its crew row's ticket, title and PR); the map's own otherwise. */
  work?: Record<string, SeatWork>;
  status?: MapStatus;
}) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const now = useNow();
  const seatWork = useCallback(
    (seat: MapSeat): SeatWork =>
      work[seat.seat] ?? { ticket: seat.ticket, title: seat.title, pr: null },
    [work],
  );
  // a seat's colour is its place in config order; one the crew doesn't list takes its place here,
  // the same on the stage and in the rail
  const colours = useMemo(
    () => ({
      ...Object.fromEntries(snapshot.seats.map((seat, i) => [seat.seat, i])),
      ...indices,
    }),
    [snapshot.seats, indices],
  );
  const selectedSeat =
    selection?.kind === "seat" ? snapshot.seats.find((s) => s.seat === selection.seat) : undefined;
  useEffect(() => {
    if (selection?.kind === "seat" && !selectedSeat) setSelection(null);
  }, [selection, selectedSeat]);
  const workingSeats = useMemo(
    () => snapshot.seats.filter((seat) => isWorking(seat, now)),
    [snapshot.seats, now],
  );
  const timeline = useSessionTimeline(workingSeats, now);
  // What Changes draws: the working seats and their fresh paths only. The clock ticks every few
  // seconds; the drawing is redone only when a seat starts or stops working or its path changes.
  const clock = useRef(now);
  clock.current = now;
  const freshKey = workingSeats
    .map((seat) => `${seat.seat}\t${freshRecent(seat, now).length}`)
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: freshKey stands for the clock here
  const changesSeats = useMemo(
    () =>
      snapshot.seats
        .filter((seat) => isWorking(seat, clock.current))
        .map((seat) => ({ ...seat, recent: freshRecent(seat, clock.current) })),
    [snapshot.seats, freshKey],
  );
  const changesVisual = useMemo(
    () => changesVisuals({ ...snapshot, seats: changesSeats }),
    [snapshot, changesSeats],
  );
  // files in the tree or new on a branch (a conflicting file new on its branches too); the layout
  // stays put while a window dims what's outside it
  const pathKey = [...Object.keys(changesVisual), ...snapshot.conflicts.map((c) => c.file)]
    .sort()
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathKey is the paths of changesVisual and the conflicts
  const extraFiles = useMemo(
    () => branchOnlyFiles(snapshot.tree, markConflicts(changesVisual, snapshot.conflicts)),
    [snapshot.tree, pathKey],
  );
  const searchable = useMemo(
    () => [...snapshot.tree.map((file) => file.path), ...extraFiles.map((file) => file.path)],
    [snapshot.tree, extraFiles],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? searchable.filter((path) => path !== "" && path.toLowerCase().includes(needle))
    : [];
  const selectedPath = selection?.kind === "node" ? selection.path : null;
  // stable callbacks, so the treemap's props change only when what it shows does
  const selectNode = useCallback((path: string) => setSelection({ kind: "node", path }), []);
  const selectSeat = useCallback((seat: string | null) => {
    setSelection(seat === null ? null : { kind: "seat", seat });
  }, []);
  const named = { snapshot, indices: colours, names };
  const windowed = useMemo(
    () => (timeline.win ? windowVisuals(changesVisual, changesSeats, timeline.win) : changesVisual),
    [changesVisual, changesSeats, timeline.win],
  );
  const { playback, marks, current } = timeline;
  // Play shows only the replayed seat's changes on the files it has reached so far
  const visibleVisual = useMemo(() => {
    if (!playback) return markConflicts(windowed, snapshot.conflicts);
    const replay = Object.fromEntries(
      [...marks.keys()].map((path): [string, ChangeVisual] => [
        path,
        {
          changes: (changesVisual[path]?.changes ?? []).filter(
            (change) => change.seat === playback.seat && change.changed,
          ),
        },
      ]),
    );
    return markConflicts(replay, snapshot.conflicts);
  }, [windowed, changesVisual, playback, marks, snapshot.conflicts]);
  const replaying = playback !== null;
  return (
    <div className="map-body">
      <div className="map-key-bar">
        <ChangesKey snapshot={snapshot} />
      </div>
      <div className="map-main">
        <div className="map-stage-wrap">
          <MapTreemap
            snapshot={snapshot}
            visual={visibleVisual}
            indices={colours}
            extraFiles={extraFiles}
            marks={replaying ? marks : undefined}
            currentMark={replaying ? (current?.file ?? null) : null}
            markSeat={replaying ? playback.seat : null}
            onSelect={selectNode}
          />
        </div>
        <div className="map-rail">
          <section className="map-card map-card-seats" aria-label="Seats">
            <h2>Seats</h2>
            <SeatSelector
              {...named}
              snapshot={snapshot}
              seats={workingSeats}
              selected={selectedSeat?.seat ?? null}
              onSelect={selectSeat}
              work={seatWork}
            />
          </section>
          <section className="map-card map-card-selected" aria-label="Selected">
            <h2>Selected</h2>
            <input
              type="search"
              className="map-find"
              aria-label="Find a file"
              placeholder="Find a file"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches[0]) selectNode(matches[0]);
              }}
            />
            {query && (
              <div className="map-results">
                {matches.slice(0, 60).map((n) => (
                  <button type="button" key={n} onClick={() => selectNode(n)}>
                    {n}
                  </button>
                ))}
                {matches.length > 60 && <p>{matches.length - 60} more; refine your search.</p>}
                {!matches.length && <p>No file matches.</p>}
              </div>
            )}
            {/* Announces the selection only: the card's "Now" line ticks every few seconds. */}
            <p className="sr-only" role="status">
              {selectedSeat
                ? `Selected ${named.names?.[selectedSeat.seat] ?? selectedSeat.seat}`
                : selectedPath !== null
                  ? `Selected ${selectedPath}`
                  : ""}
            </p>
            <aside className="map-detail" aria-label="Selection detail">
              {selectedSeat ? (
                <SeatDetail
                  {...named}
                  seat={selectedSeat}
                  now={now}
                  work={seatWork(selectedSeat)}
                />
              ) : selectedPath !== null ? (
                <>
                  <NodeDetail {...named} path={selectedPath} files={[selectedPath]} />
                  <div className="map-detail-actions">
                    <button type="button" onClick={() => setSelection(null)}>
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <p className="map-note">
                  Pick a seat for its card, or click a file to see who changed or read it.
                </p>
              )}
            </aside>
          </section>
        </div>
      </div>
      <SessionTimeline timeline={timeline} seats={workingSeats} indices={colours} names={names} />
      <div className="map-deck">
        {status && (
          <span className={`map-live${status.live ? "" : " down"}`} role="status">
            <i aria-hidden="true" />
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}

function ChangesKey({ snapshot }: { snapshot: MapSnapshot }) {
  const conflicts = snapshot.conflicts.length > 0 || snapshot.conflictsUnchecked.length > 0;
  return (
    <div className="map-changes-key" role="note" aria-label="Changes colour key">
      <span className="map-key-item">
        changed <KeySteps />
        <span className="map-key-muted">1–10 · –40 · –120 · 120+ lines</span>
      </span>
      <span className="map-key-item">
        <i className="map-key-read" aria-hidden="true" /> read only
      </span>
      <span className="map-key-item">click a file for its seats</span>
      <span className="map-key-item">{plural(snapshot.tree.length, "file")}</span>
      {conflicts && (
        <span className="map-key-item map-key-conflicts">{conflictSummary(snapshot)}</span>
      )}
    </div>
  );
}

function KeySteps() {
  return (
    <span className="map-key-steps map-key-steps-changes" aria-hidden="true">
      {[1, 2, 3, 4].map((step) => (
        <i className={`map-key-swatch map-key-swatch-${step}`} key={step} />
      ))}
    </span>
  );
}
