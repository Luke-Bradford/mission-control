import type { Crew, MapSeat, MapSnapshot, RepoView } from "@mc/core";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../api.ts";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { isWorking, type SeatWork } from "./cards.ts";
import {
  downstream,
  graph,
  HistoryLens,
  historyFocusLinks,
  ImpactLens,
  impactFocusLinks,
  LensTabs,
  lensVisuals,
  type MapLens,
} from "./Lenses.tsx";
import { LiveMap } from "./live.ts";
import { historyHeat, MapTreemap } from "./MapTreemap.tsx";
import { NodeDetail, SeatDetail, SeatSelector, type Selection } from "./Selector.tsx";
import "./map.css";

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
  const [playback, setPlayback] = useState<{ seat: string; step: number } | null>(null);
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
  const searchable = useMemo(
    () => [
      ...new Set([
        ...snapshot.tree.map((file) => file.path),
        ...Object.keys(lensVisuals(snapshot, "changes", null)),
      ]),
    ],
    [snapshot],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? searchable.filter((path) => path !== "" && path.toLowerCase().includes(needle))
    : [];
  const selectedPath = selection?.kind === "node" ? selection.path : null;
  const selectedFiles = selectedPath === null ? [] : [selectedPath];
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
  }, []);
  const named = { snapshot, indices: colours, names };
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
  const visibleVisual = useMemo(() => {
    if (lens !== "changes" || !playback) return lensVisual;
    const seat = snapshot.seats.find((item) => item.seat === playback.seat);
    const revealed = new Set(seat?.recent.slice(0, playback.step).map((tick) => tick.file));
    return Object.fromEntries(Object.entries(lensVisual).filter(([path]) => revealed.has(path)));
  }, [lens, lensVisual, playback, snapshot.seats]);
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
        {lens === "changes" ? (
          <ChangesKey tree={snapshot.tree} />
        ) : lens === "impact" || lens === "history" ? (
          <AnalyticalMapKey lens={lens} focus={focus} snapshot={snapshot} />
        ) : null}
        {lens === "impact" && focus !== null && (
          <span className="map-lens-trace">Focused file and its relationships are traced.</span>
        )}
      </div>
      <div className={`map-main map-main-${lens}`}>
        <div className="map-stage-wrap">
          <MapTreemap
            snapshot={snapshot}
            lens={lens}
            visual={visibleVisual}
            focus={focus}
            focusLinks={focusLinks}
            onSelect={selectFromScene}
          />
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
                  seats={snapshot.seats.filter((seat) => isWorking(seat, now))}
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
                            : snapshot.tree
                                .map((f) => f.path)
                                .filter((f) => f.startsWith(`${selectedPath}/`))
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
      {lens === "changes" && (
        <SessionTimeline snapshot={snapshot} now={now} onPlayback={setPlayback} />
      )}
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

function ChangesKey({ tree }: { tree: MapSnapshot["tree"] }) {
  return (
    <div className="map-changes-key" role="note" aria-label="Changes colour key">
      <span className="map-key-item">
        <KeySteps tone="impact" /> changed
      </span>
      <span className="map-key-item">
        <i className="map-key-read" aria-hidden="true" /> read only
      </span>
      <span className="map-key-item">click a file for its seats</span>
      <span className="map-key-item">{tree.length.toLocaleString()} files</span>
    </div>
  );
}

const TIMELINE_WINDOW_MS = 60 * 60_000;
const PLAY_STEP_MS = 380;

function hashValues() {
  return new URLSearchParams(window.location.hash.slice(1));
}

function writeHash(values: URLSearchParams) {
  const hash = values.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
  );
}

function SessionTimeline({
  snapshot,
  now,
  onPlayback,
}: {
  snapshot: MapSnapshot;
  now: number;
  onPlayback: (playback: { seat: string; step: number } | null) => void;
}) {
  const [windowRange, setWindowRange] = useState<[number, number] | null>(() => {
    const value = hashValues().get("win");
    const parts = value?.split(",").map(Number);
    return parts?.length === 2 && parts.every(Number.isFinite)
      ? [now - TIMELINE_WINDOW_MS + parts[0] * 60_000, now - TIMELINE_WINDOW_MS + parts[1] * 60_000]
      : null;
  });
  const [playing, setPlaying] = useState<{ seat: string; step: number } | null>(() => {
    const seat = hashValues().get("play") ?? "";
    const step = Number(hashValues().get("step") ?? 0);
    return seat && Number.isInteger(step) ? { seat, step } : null;
  });
  const seats = snapshot.seats.filter((seat) => isWorking(seat, now));
  const selectedSeat = playing?.seat ?? seats[0]?.seat ?? "";
  const ticks = (seat: MapSeat) =>
    seat.recent
      .filter(
        (tick) =>
          tick.at >= now - TIMELINE_WINDOW_MS &&
          (!windowRange || (tick.at >= windowRange[0] && tick.at <= windowRange[1])),
      )
      .map((tick) => ({
        ...tick,
        changed: seat.scope.modified.some((change) => change.file === tick.file),
      }));
  const playSeat = seats.find((seat) => seat.seat === selectedSeat) ?? seats[0];
  const sequence = playSeat ? ticks(playSeat) : [];
  useEffect(() => onPlayback(playing), [onPlayback, playing]);
  useEffect(() => {
    if (!playing || playing.step >= sequence.length) return;
    const timer = window.setTimeout(() => {
      const next = { ...playing, step: playing.step + 1 };
      setPlaying(next);
      const values = hashValues();
      values.set("play", next.seat);
      values.set("step", String(next.step));
      writeHash(values);
    }, PLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, sequence.length]);
  const clearWindow = () => {
    setWindowRange(null);
    const values = hashValues();
    values.delete("win");
    writeHash(values);
  };
  const play = () => {
    if (playing) {
      setPlaying(null);
      const values = hashValues();
      values.delete("play");
      values.delete("step");
      writeHash(values);
      return;
    }
    const next = { seat: selectedSeat, step: 1 };
    setPlaying(next);
    const values = hashValues();
    values.set("play", next.seat);
    values.set("step", String(next.step));
    writeHash(values);
  };
  const status = playing && sequence[playing.step - 1];
  return (
    <section className="map-timeline" aria-label="Session timeline">
      <div className="map-timeline-controls">
        <strong>Session</strong>
        <span>{windowRange ? "selected window" : "last 60 min"}</span>
        <button type="button" disabled={!windowRange} onClick={clearWindow}>
          Clear window
        </button>
        <button type="button" disabled={!sequence.length} onClick={play}>
          {playing && playing.step >= sequence.length
            ? "↺ Reset"
            : playing
              ? "■ Stop"
              : `▶ Play ${selectedSeat}`}
        </button>
        <span role="status" aria-label="Playback">
          {status
            ? `${playing?.seat} step ${playing?.step} of ${sequence.length} · ${status.changed ? "changed" : "read"} ${status.file}`
            : ""}
        </span>
      </div>
      <ul className="map-timeline-list" aria-label="Working seat timelines">
        {seats.map((seat, index) => (
          <li className="map-timeline-row" aria-label={`Timeline for ${seat.seat}`} key={seat.seat}>
            <button
              type="button"
              className="map-timeline-seat"
              onClick={() => {
                const next = { seat: seat.seat, step: 0 };
                setPlaying(next);
                const values = hashValues();
                values.set("play", seat.seat);
                values.set("step", "0");
                writeHash(values);
              }}
            >
              {namesOnlySeat(seat.seat)}
            </button>
            <span
              className="map-timeline-track"
              style={{ "--timeline-seat": `var(--seat-${(index % 7) + 1})` } as CSSProperties}
            >
              {ticks(seat).map((tick) => (
                <i
                  className="map-timeline-tick"
                  data-read={!tick.changed || undefined}
                  key={`${tick.file}:${tick.at}`}
                  style={{
                    left: `${Math.max(0, Math.min(100, ((tick.at - (now - TIMELINE_WINDOW_MS)) / TIMELINE_WINDOW_MS) * 100))}%`,
                  }}
                  title={`${tick.changed ? "changed" : "read"} ${tick.file}`}
                  data-current={
                    (playing?.seat === seat.seat && sequence[playing.step - 1] === tick) ||
                    undefined
                  }
                />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const namesOnlySeat = (seat: string) => seat;

function KeySteps({ tone }: { tone: "impact" | "focus" | "history" }) {
  const heatBands = tone === "history" ? [1, 3, 10, 30].map(historyHeat) : null;
  return (
    <span className={`map-key-steps map-key-steps-${tone}`} aria-hidden="true">
      {[1, 2, 3, 4].map((step) => (
        <i
          className={`map-key-swatch map-key-swatch-${step}`}
          data-opacity={heatBands?.[step - 1]}
          key={step}
          style={heatBands ? { opacity: heatBands[step - 1] } : undefined}
        />
      ))}
    </span>
  );
}

function AnalyticalMapKey({
  lens,
  focus,
  snapshot,
}: {
  lens: Exclude<MapLens, "changes">;
  focus: string | null;
  snapshot: MapSnapshot;
}) {
  if (lens === "impact" && focus !== null) {
    const { forward, reverse } = graph(snapshot);
    const reach = downstream(focus, reverse);
    return (
      <div className="map-analytical-key" role="note" aria-label="Impact colour scale">
        <span className="map-key-item">
          <b>{focus.split("/").at(-1)}</b> · {reverse.get(focus)?.size ?? 0} import it ·{" "}
          {reach.size} depend on it
        </span>
        <span className="map-key-item">
          <KeySteps tone="focus" /> 1 · 2 · 3 · 4+ steps away
        </span>
        <span className="map-key-item">
          <i className="map-key-swatch map-key-outline" aria-hidden="true" /> it imports (
          {forward.get(focus)?.size ?? 0})
        </span>
        <span className="map-key-item">Esc to clear</span>
      </div>
    );
  }
  return lens === "impact" ? (
    <div className="map-analytical-key" role="note" aria-label="Impact colour scale">
      <span className="map-key-item">
        <KeySteps tone="impact" /> changed · imports it · 2 · 3+ steps
      </span>
      <span className="map-key-item">
        <i className="map-key-swatch map-key-outline map-key-overlap" aria-hidden="true" /> changed,
        and depends on another seat’s change
      </span>
      <span className="map-key-item">click a file to trace it</span>
    </div>
  ) : (
    <div className="map-analytical-key" role="note" aria-label="History PR heat scale">
      <span className="map-key-item">
        <KeySteps tone="history" /> 1–2 PRs · 3–9 PRs · 10–29 PRs · 30+ PRs
      </span>
      <span className="map-key-item">
        <i className="map-key-swatch map-key-fix" aria-hidden="true" /> fixed often
      </span>
      <span className="map-key-item">hotspots and hidden change coupling</span>
    </div>
  );
}
