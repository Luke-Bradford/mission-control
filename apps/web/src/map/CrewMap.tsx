import type { Crew, MapSeat, MapSnapshot, RepoView } from "@mc/core";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../api.ts";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { freshRecent, isWorking, type SeatWork } from "./cards.ts";
import {
  HistoryLens,
  historyFocusLinks,
  ImpactLens,
  impactFocusLinks,
  LensTabs,
  lensVisuals,
  type MapLens,
} from "./Lenses.tsx";
import { mainAreas } from "./layout.ts";
import { mapLayoutWorker } from "./layoutClient.ts";
import { LiveMap } from "./live.ts";
import { MapTreemap } from "./MapTreemap.tsx";
import { layoutTree } from "./model.ts";
import { NodeDetail, SeatDetail, SeatSelector, type Selection } from "./Selector.tsx";
import "./map.css";

const Scene = lazy(() => import("./MapScene.tsx").then((m) => ({ default: m.MapScene })));

/** The feed's health, shown in the deck under the stage. */
export interface MapStatus {
  live: boolean;
  text: string;
}

/** One repo's live map: the snapshot, then its deltas, until the page leaves the repo. */
export function LiveCrewMap({ repo }: { repo: string }) {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const repos = useResource<RepoView[]>(RESOURCES.repos).data;
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    const live = new LiveMap(
      repo,
      () => apiGet<MapSnapshot>(RESOURCES.repoMap(repo).path),
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
      github={repos?.find((entry) => entry.id === repo)?.github}
    />
  );
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
  github,
}: {
  snapshot: MapSnapshot;
  indices?: Record<string, number>;
  /** Each seat's call sign (the crew's display name). */
  names?: Record<string, string>;
  /** What each crew seat is on (its crew row's ticket, title and PR); the map's own otherwise. */
  work?: Record<string, SeatWork>;
  status?: MapStatus;
  /** The configured owner/name, used only after URL validation for PR links. */
  github?: string;
}) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [lens, setLens] = useState<MapLens>("changes");
  const [home, setHome] = useState(0);
  const [overview, setOverview] = useState(0);
  const [nodes, setNodes] = useState<ReturnType<typeof layoutTree>>([]);
  const previousLayout = useRef<{ repo: string; nodes: ReturnType<typeof layoutTree> } | null>(
    null,
  );
  const [rotate, setRotate] = useState(false);
  const [seatFocus, setSeatFocus] = useState<{ seat: string; request: number } | null>(null);
  const now = useNow();
  // The stage and the selector show working seats only, each with the part of its path the hub
  // still keeps: the clock's tick ages a path out on an open page. Keyed on who is working and how
  // much of each path is fresh, so a tick that changes neither doesn't redraw the scene.
  const working = snapshot.seats
    .filter((seat) => isWorking(seat, now))
    .map((seat) => `${seat.seat}\t${freshRecent(seat, now).length}`)
    .join("\n");
  const stage = useMemo(() => {
    const fresh = new Map(
      working
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t") as [string, string]),
    );
    return {
      ...snapshot,
      seats: snapshot.seats.flatMap((seat) => {
        const kept = fresh.get(seat.seat);
        // recent is oldest first, so what is still fresh is its tail
        return kept === undefined
          ? []
          : [{ ...seat, recent: seat.recent.slice(seat.recent.length - Number(kept)) }];
      }),
    };
  }, [snapshot, working]);
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
    selection?.kind === "seat" ? stage.seats.find((s) => s.seat === selection.seat) : undefined;
  useEffect(() => {
    if (selection?.kind === "seat" && !selectedSeat) setSelection(null);
  }, [selection, selectedSeat]);
  // Layout stays out of React's render path, so a large tree cannot block orbiting or the live feed.
  useEffect(() => {
    let current = true;
    const previous =
      previousLayout.current?.repo === snapshot.repoId ? previousLayout.current.nodes : undefined;
    void mapLayoutWorker.layout(snapshot.tree, snapshot.imports, previous).then((next) => {
      if (!current) return;
      previousLayout.current = { repo: snapshot.repoId, nodes: next };
      setNodes(next);
    });
    return () => {
      current = false;
    };
  }, [snapshot.repoId, snapshot.tree, snapshot.imports]);
  const areas = useMemo(() => mainAreas(snapshot.tree), [snapshot.tree]);
  const treePaths = useMemo(() => new Set(snapshot.tree.map((f) => f.path)), [snapshot.tree]);
  // files a seat touched that origin/HEAD doesn't have yet (new on a branch)
  const extraKey = [
    ...new Set(
      snapshot.seats.flatMap((s) => [...s.scope.read, ...s.scope.modified.map((c) => c.file)]),
    ),
  ]
    .filter((f) => !treePaths.has(f))
    .sort()
    .join("\n");
  const extras = useMemo(() => (extraKey ? extraKey.split("\n") : []), [extraKey]);
  const displayNodes = useMemo(
    () =>
      extras.length
        ? layoutTree(
            extras.map((path) => ({ path, lines: 0 })),
            nodes,
            false,
          )
        : nodes,
    [extras, nodes],
  );
  const searchable = useMemo(
    () => [...new Set([...displayNodes.map((n) => n.path), ...treePaths, ...extras])],
    [displayNodes, treePaths, extras],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? searchable.filter((path) => path !== "" && path.toLowerCase().includes(needle))
    : [];
  const focusNode =
    displayNodes.find((n) => n.path === focus) ??
    displayNodes.find((n) => focus !== null && n.files.includes(focus));
  const selectedPath = selection?.kind === "node" ? selection.path : null;
  const selectedFiles = displayNodes.find((n) => n.path === selectedPath)?.files ?? [];
  // stable callbacks, so the scene's props change only when what it shows does
  const selectNode = useCallback((path: string) => setSelection({ kind: "node", path }), []);
  const selectFromScene = useCallback(
    (path: string) => {
      if (lens === "changes") selectNode(path);
      else setFocus((current) => (current === path ? null : path));
    },
    [lens, selectNode],
  );
  const searchSelect = (path: string) => {
    selectNode(path);
    setFocus(null);
    queueMicrotask(() => setFocus(path));
  };
  const selectSeat = useCallback((seat: string | null, frame: boolean) => {
    setSelection(seat === null ? null : { kind: "seat", seat });
    if (seat === null || !frame) return;
    setFocus(null);
    setRotate(false);
    setSeatFocus((previous) => ({ seat, request: (previous?.request ?? 0) + 1 }));
  }, []);
  const followFromStage = useCallback(
    (seat: string | null) => selectSeat(seat, false),
    [selectSeat],
  );
  const named = { snapshot: stage, indices: colours, names };
  const focusLinks = useMemo(
    () =>
      lens === "impact"
        ? impactFocusLinks(snapshot, focus)
        : lens === "history"
          ? historyFocusLinks(snapshot, focus)
          : [],
    [lens, snapshot, focus],
  );
  const lensVisual = useMemo(() => lensVisuals(snapshot, lens, focus), [snapshot, lens, focus]);
  useEffect(() => {
    const clearFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape" && focus !== null) setFocus(null);
    };
    window.addEventListener("keydown", clearFocus);
    return () => window.removeEventListener("keydown", clearFocus);
  }, [focus]);
  return (
    <div className="map-body">
      <div className="map-lens-toolbar">
        <LensTabs
          lens={lens}
          onChange={(next) => {
            setLens(next);
            setFocus(null);
          }}
        />
        {lens === "impact" && <span>Click a file to trace its importers, tests, and imports.</span>}
        {lens === "history" && <span>Hotspots and hidden change coupling from merged PRs.</span>}
      </div>
      <div className={`map-main map-main-${lens}`}>
        <div className="map-stage-wrap">
          {lens === "changes" ? (
            <Suspense fallback={<p className="map-wait-note">Loading 3D map…</p>}>
              <Scene
                nodes={displayNodes}
                areas={areas}
                snapshot={stage}
                names={names}
                focus={focusNode?.path ?? null}
                focusLinks={focusLinks}
                lens={lens}
                lensVisual={lensVisual}
                home={home}
                overview={overview}
                rotate={rotate}
                selected={selectedPath}
                indices={colours}
                onSelect={selectFromScene}
                seat={selectedSeat?.seat ?? null}
                seatFocus={seatFocus}
                dockSeats={snapshot.seats.length}
                onSeatSelect={followFromStage}
              />
            </Suspense>
          ) : (
            <MapTreemap
              snapshot={snapshot}
              lens={lens}
              visual={lensVisual}
              focus={focus}
              focusLinks={focusLinks}
              onSelect={selectFromScene}
            />
          )}
          {lens === "changes" && <MapKey tree={snapshot.tree} />}
        </div>
        <div className="map-rail">
          {lens === "impact" ? (
            <ImpactLens snapshot={snapshot} focus={focus} onFocus={setFocus} />
          ) : lens === "history" ? (
            <HistoryLens snapshot={snapshot} focus={focus} onFocus={setFocus} github={github} />
          ) : (
            <>
              <section className="map-card map-card-seats" aria-label="Seats">
                <h2>Seats</h2>
                <SeatSelector
                  {...named}
                  snapshot={snapshot}
                  seats={stage.seats}
                  selected={selectedSeat?.seat ?? null}
                  onSelect={(seat) => selectSeat(seat, true)}
                  work={seatWork}
                />
              </section>
              <section className="map-card map-card-selected" aria-label="Selected">
                <h2>Selected</h2>
                <input
                  type="search"
                  className="map-find"
                  aria-label="Find a file or folder"
                  placeholder="Find a file or folder"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matches[0]) searchSelect(matches[0]);
                  }}
                />
                {query && (
                  <div className="map-results">
                    {matches.slice(0, 60).map((n) => (
                      <button type="button" key={n} onClick={() => searchSelect(n)}>
                        {n}
                      </button>
                    ))}
                    {matches.length > 60 && <p>{matches.length - 60} more; refine your search.</p>}
                    {!matches.length && <p>No file or folder matches.</p>}
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
                      <NodeDetail
                        {...named}
                        path={selectedPath}
                        files={
                          selectedFiles.length
                            ? selectedFiles
                            : [...snapshot.tree.map((f) => f.path), ...extras].filter((f) =>
                                f.startsWith(`${selectedPath}/`),
                              )
                        }
                      />
                      <div className="map-detail-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setFocus(null);
                            queueMicrotask(() => setFocus(selectedPath));
                          }}
                        >
                          Zoom to it
                        </button>
                        <button type="button" onClick={() => setSelection(null)}>
                          Close
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="map-note">
                      Pick a seat to follow it, or click a node to see who changed or read it.
                    </p>
                  )}
                </aside>
              </section>
            </>
          )}
        </div>
      </div>
      <div className="map-deck">
        {status && (
          <span className={`map-live${status.live ? "" : " down"}`} role="status">
            <i aria-hidden="true" />
            {status.text}
          </span>
        )}
        <span className="map-deck-controls">
          <button
            type="button"
            title="Frame where the seats are working (the whole repo when nobody is)"
            onClick={() => {
              setHome(home + 1);
              setFocus(null);
              setSeatFocus(null);
            }}
          >
            Home view
          </button>
          <button
            type="button"
            onClick={() => {
              setOverview(overview + 1);
              setFocus(null);
              setSeatFocus(null);
            }}
          >
            Whole repo
          </button>
          <label>
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />{" "}
            rotate
          </label>
        </span>
      </div>
    </div>
  );
}

/** The stage's key: what a light, a path and a disc are. */
function MapKey({ tree }: { tree: MapSnapshot["tree"] }) {
  return (
    <p className="map-legend">
      <span className="map-key-item">
        <i className="key-light" aria-hidden="true" /> seat
      </span>
      <span className="map-key-item">
        <i className="key-path" aria-hidden="true" /> its path
      </span>
      <span className="map-key-item">
        <i className="key-touched" aria-hidden="true" /> a file seats touched (split when shared) —
        click for who read or changed it
      </span>
      <span className="map-key-item">
        {tree.length.toLocaleString()} files
        {tree.length > 2000 && ", every file shown as an individual point"}
      </span>
    </p>
  );
}
