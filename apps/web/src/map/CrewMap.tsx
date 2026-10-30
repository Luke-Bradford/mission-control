import {
  type Crew,
  FINDING_SEVERITIES,
  type MapSeat,
  type MapSnapshot,
  type RepoView,
} from "@mc/core";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { freshRecent, isWorking, type SeatWork, seatToken } from "./cards.ts";
import {
  ConflictsLens,
  conflictSummary,
  downstream,
  graph,
  HistoryLens,
  historyFocusLinks,
  ImpactLens,
  impactFocusLinks,
  LensTabs,
  type LensVisual,
  lensVisuals,
  type MapLens,
  OwnershipLens,
  ownershipOf,
  ReviewLens,
  windowVisuals,
} from "./Lenses.tsx";
import { LiveMap } from "./live.ts";
import { branchOnlyFiles, historyHeat, MapTreemap } from "./MapTreemap.tsx";
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
  const repos = useResource<RepoView[]>(RESOURCES.repos).data;
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
const noVisual: Record<string, LensVisual> = {};
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
    () => lensVisuals({ ...snapshot, seats: changesSeats }, "changes", null),
    [snapshot, changesSeats],
  );
  // files in the tree or new on a branch; the layout stays put while a window dims what's outside it
  const pathKey = Object.keys(changesVisual).sort().join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathKey is the paths of changesVisual
  const extraFiles = useMemo(() => {
    const branchOnly = branchOnlyFiles(snapshot.tree, changesVisual);
    // a conflicting file new on its branches gets a tile too, so Changes and Conflicts lay out alike
    const have = new Set([...snapshot.tree, ...branchOnly].map((file) => file.path));
    const conflictOnly = [...new Set(snapshot.conflicts.map((conflict) => conflict.file))]
      .filter((path) => path !== "" && !have.has(path))
      .map((path) => ({ path, lines: 1 }));
    return conflictOnly.length ? [...branchOnly, ...conflictOnly] : branchOnly;
  }, [snapshot.tree, snapshot.conflicts, pathKey]);
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
  const selectFromScene = useCallback(
    (path: string) => {
      if (lens === "changes") selectNode(path);
      else setFocus((current) => (current === path ? null : path));
    },
    [lens, selectNode],
  );
  const searchSelect = (path: string) => {
    selectNode(path);
    setFocus(path);
  };
  const selectSeat = useCallback((seat: string | null) => {
    setSelection(seat === null ? null : { kind: "seat", seat });
    if (seat !== null) setFocus(null);
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
  const windowed = useMemo(
    () => (timeline.win ? windowVisuals(changesVisual, changesSeats, timeline.win) : changesVisual),
    [changesVisual, changesSeats, timeline.win],
  );
  // Ownership, Review and Conflicts depend on the snapshot alone, so neither the focus nor the
  // timeline window (which tick with the clock) reruns their matching
  const fixedVisual = useMemo(
    () =>
      lens === "ownership" || lens === "review" || lens === "conflicts"
        ? lensVisuals(snapshot, lens, null)
        : null,
    [snapshot, lens],
  );
  const focusVisual = useMemo(
    () => (lens === "impact" || lens === "history" ? lensVisuals(snapshot, lens, focus) : null),
    [snapshot, lens, focus],
  );
  const lensVisual = lens === "changes" ? windowed : (fixedVisual ?? focusVisual ?? noVisual);
  const { playback, marks, current } = timeline;
  // Play shows only the replayed seat's changes on the files it has reached so far
  const visibleVisual = useMemo(() => {
    if (lens !== "changes" || !playback) return lensVisual;
    return Object.fromEntries(
      [...marks.keys()].map((path): [string, LensVisual] => [
        path,
        {
          changes: (changesVisual[path]?.changes ?? []).filter(
            (change) => change.seat === playback.seat && change.changed,
          ),
        },
      ]),
    );
  }, [lens, lensVisual, changesVisual, playback, marks]);
  const replaying = lens === "changes" && playback !== null;
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
            if (next !== "changes") timeline.stop();
          }}
        />
        {lens === "changes" ? (
          <ChangesKey tree={snapshot.tree} />
        ) : (
          <AnalyticalMapKey
            lens={lens}
            focus={focus}
            snapshot={snapshot}
            now={now}
            indices={colours}
            names={names}
          />
        )}
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
            indices={colours}
            extraFiles={extraFiles}
            marks={replaying ? marks : undefined}
            currentMark={replaying ? (current?.file ?? null) : null}
            markSeat={replaying ? playback.seat : null}
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
          ) : lens === "ownership" ? (
            <OwnershipLens snapshot={snapshot} names={names} indices={colours} onFocus={setFocus} />
          ) : lens === "review" ? (
            <ReviewLens snapshot={snapshot} names={names} onFocus={setFocus} />
          ) : lens === "conflicts" ? (
            <ConflictsLens snapshot={snapshot} names={names} indices={colours} onFocus={setFocus} />
          ) : (
            <>
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
                        <button type="button" onClick={() => setFocus(selectedPath)}>
                          Show on map
                        </button>
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
            </>
          )}
        </div>
      </div>
      {lens === "changes" && (
        <SessionTimeline timeline={timeline} seats={workingSeats} indices={colours} names={names} />
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
        changed <KeySteps tone="changes" />
        <span className="map-key-muted">1–10 · –40 · –120 · 120+ lines</span>
      </span>
      <span className="map-key-item">
        <i className="map-key-read" aria-hidden="true" /> read only
      </span>
      <span className="map-key-item">click a file for its seats</span>
      <span className="map-key-item">{tree.length.toLocaleString()} files</span>
    </div>
  );
}

function KeySteps({ tone }: { tone: "impact" | "focus" | "history" | "changes" }) {
  const heatBands = tone === "history" ? [1, 3, 10, 30].map(historyHeat) : null;
  return (
    <span className={`map-key-steps map-key-steps-${tone}`} aria-hidden="true">
      {[1, 2, 3, 4].map((step) => (
        <i
          className={`map-key-swatch map-key-swatch-${step}`}
          data-opacity={heatBands?.[step - 1]}
          key={step}
        />
      ))}
    </span>
  );
}

function AnalyticalMapKey({
  lens,
  focus,
  snapshot,
  now,
  indices,
  names,
}: {
  lens: Exclude<MapLens, "changes">;
  focus: string | null;
  snapshot: MapSnapshot;
  now: number;
  indices: Record<string, number>;
  names: Record<string, string>;
}) {
  if (lens === "ownership") {
    const owner = ownershipOf(snapshot.rules);
    const owned = owner ? snapshot.tree.filter((file) => owner.areaOf(file.path)).length : 0;
    const hard = owner ? snapshot.tree.filter((file) => owner.isHardRule(file.path)).length : 0;
    return (
      <div className="map-analytical-key" role="note" aria-label="Ownership colour key">
        {owner ? (
          <>
            <span className="map-key-item">
              <b>{owned}</b> of {plural(snapshot.tree.length, "file")} owned by an area ·{" "}
              <b>{hard}</b> hard-rule
            </span>
            {owner.labels.map((label) => (
              <span className="map-key-item" key={label}>
                <i
                  className="map-key-swatch map-key-area"
                  style={{ "--map-key-area": owner.colours[label] } as CSSProperties}
                  aria-hidden="true"
                />{" "}
                {label}
              </span>
            ))}
            <span className="map-key-item">
              <i className="map-key-swatch map-key-hatch" aria-hidden="true" /> hard-rule
            </span>
          </>
        ) : (
          <span className="map-key-item">Ownership rules unavailable</span>
        )}
      </div>
    );
  }
  if (lens === "review") {
    const counts = Object.fromEntries(
      FINDING_SEVERITIES.map((severity) => [
        severity,
        snapshot.findings.filter((finding) => finding.severity === severity).length,
      ]),
    );
    return (
      <div className="map-analytical-key" role="note" aria-label="Review severity key">
        <span className="map-key-item">
          <b>{snapshot.findings.length}</b> findings on{" "}
          {new Set(snapshot.findings.map((finding) => finding.file)).size} files
        </span>
        {FINDING_SEVERITIES.map((severity) => (
          <span className="map-key-item" key={severity}>
            <i
              className={`map-key-swatch map-key-dot map-severity-${severity.toLowerCase()}`}
              aria-hidden="true"
            />{" "}
            {counts[severity]} {severity}
          </span>
        ))}
      </div>
    );
  }
  if (lens === "conflicts") {
    return (
      <div className="map-analytical-key" role="note" aria-label="Conflicts colour key">
        <span className="map-key-item">
          <i className="map-key-swatch map-key-conflict" aria-hidden="true" />{" "}
          {conflictSummary(snapshot)}
        </span>
      </div>
    );
  }
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
      {snapshot.seats
        .filter((seat) => isWorking(seat, now))
        .map((seat) => (
          <span
            className="map-key-seat-chip"
            key={seat.seat}
            style={
              {
                "--map-key-seat": `var(${seatToken(seat.seat, indices[seat.seat] ?? 0)})`,
              } as CSSProperties
            }
          >
            <i aria-hidden="true" />
            {names[seat.seat] ?? seat.seat}
          </span>
        ))}
      <span className="map-key-idle">
        {snapshot.seats.filter((seat) => !isWorking(seat, now)).length} idle
      </span>
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
