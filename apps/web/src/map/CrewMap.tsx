import type { Crew, FileDiff, MapSnapshot } from "@mc/core";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiGet } from "../api.ts";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { AgentCards } from "./AgentCards.tsx";
import { BadgeDrawer, Finding } from "./BadgeDrawer.tsx";
import { type BadgeKind, isWorking, uncheckedNotes } from "./cards.ts";
import { areaColor, mainAreas, repoLayout } from "./layout.ts";
import { LiveMap } from "./live.ts";
import { layoutTree, pinToken } from "./model.ts";
import type { MessageArc, MotionEvent } from "./motion.ts";
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
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [skipped, setSkipped] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    setSnapshot(null);
    setSkipped("");
    setError(null);
    setEvents([]);
    setEpoch(0);
    const live = new LiveMap(
      repo,
      () => apiGet<MapSnapshot>(RESOURCES.repoMap(repo).path),
      setSnapshot,
      setError,
      (calls, messages) =>
        setSkipped(`While this tab was hidden: ${calls} calls, ${messages} messages`),
      (event) =>
        setEvents((previous) =>
          [...previous.filter((e) => e.at > event.at - 6000), event].slice(-200),
        ),
      setEpoch,
    );
    live.start();
    return () => live.stop();
  }, [repo]);
  const indices = useMemo(
    () => Object.fromEntries((crew?.rows ?? []).map((r) => [r.id, r.index])),
    [crew?.rows],
  );
  const names = useMemo(
    () => Object.fromEntries((crew?.rows ?? []).map((r) => [r.id, callSign(r)])),
    [crew?.rows],
  );
  const status: MapStatus = error
    ? { live: false, text: errorText(error) }
    : { live: true, text: `Live · real time${skipped ? ` · ${skipped}` : ""}` };
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
      events={events}
      epoch={epoch}
      indices={indices}
      names={names}
      status={status}
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

const collapsed = (tree: MapSnapshot["tree"]) =>
  tree.length > 2000 ? layoutTree(tree, [], true) : null;

export function CrewMapView({
  snapshot,
  indices = {},
  names = {},
  events = [],
  epoch = 0,
  status,
}: {
  snapshot: MapSnapshot;
  indices?: Record<string, number>;
  /** Each seat's call sign (the crew's display name). */
  names?: Record<string, string>;
  events?: MotionEvent[];
  epoch?: number;
  status?: MapStatus;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [home, setHome] = useState(0);
  const [overview, setOverview] = useState(0);
  const now = useNow();
  // the stage draws working agents only; the rest are a folded line in the rail
  // (keyed on who is working, so the clock's tick doesn't redraw the scene)
  const working = snapshot.seats
    .filter((seat) => isWorking(seat, now))
    .map((seat) => seat.seat)
    .join("\n");
  const stage = useMemo(() => {
    const ids = new Set(working.split("\n"));
    return { ...snapshot, seats: snapshot.seats.filter((seat) => ids.has(seat.seat)) };
  }, [snapshot, working]);
  const [rotate, setRotate] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [agentFocus, setAgentFocus] = useState<{ seat: string; request: number } | null>(null);
  const [badge, setBadge] = useState<{
    seat: string;
    kind: BadgeKind;
    conversation?: MessageArc;
  } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const agentsHeading = useRef<HTMLHeadingElement>(null);
  const drawerId = useId();
  const badgeSeat = snapshot.seats.find((s) => s.seat === badge?.seat);
  const closeBadge = useCallback(() => {
    setBadge(null);
    queueMicrotask(() => {
      const target = opener.current?.isConnected ? opener.current : agentsHeading.current;
      target?.focus();
    });
  }, []);
  useEffect(() => {
    if (agent && !snapshot.seats.some((s) => s.seat === agent)) setAgent(null);
  }, [agent, snapshot.seats]);
  useEffect(() => {
    if (badge && !badgeSeat && !badge.conversation) closeBadge();
  }, [badge, badgeSeat, closeBadge]);
  // the layout is cached per repo and set of paths (layout.ts), so the same array comes back for
  // a refetch that changed no path, and the scene keeps its geometry
  const nodes = useMemo(
    () => repoLayout(snapshot.repoId, snapshot.tree, snapshot.imports, collapsed),
    [snapshot.repoId, snapshot.tree, snapshot.imports],
  );
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
            treePaths.size > 2000,
          )
        : nodes,
    [extras, nodes, treePaths],
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
  const select = (path: string) => {
    setBadge(null);
    setSelected(path);
  };
  const searchSelect = (path: string) => {
    setBadge(null);
    setSelected(path);
    setFocus(null);
    queueMicrotask(() => setFocus(path));
  };
  return (
    <div className="map-body">
      <div className="map-main">
        <div className="map-stage-wrap">
          <Suspense fallback={<p className="map-wait-note">Loading 3D map…</p>}>
            <Scene
              nodes={displayNodes}
              areas={areas}
              snapshot={stage}
              names={names}
              focus={focusNode?.path ?? null}
              home={home}
              overview={overview}
              rotate={rotate}
              selected={selected}
              indices={indices}
              onSelect={select}
              events={events}
              epoch={epoch}
              agent={agent}
              agentFocus={agentFocus}
              onAgentSelect={setAgent}
              onArc={(conversation, button) => {
                opener.current = button;
                setSelected(null);
                const seat = snapshot.seats.find(
                  (s) =>
                    s.seat !== "CAPCOM" &&
                    s.seat !== "HUB" &&
                    (s.seat === conversation.from || s.seat === conversation.to),
                );
                setBadge({ seat: seat?.seat ?? "", kind: "questions", conversation });
              }}
            />
          </Suspense>
          <MapLegend areas={areas} tree={snapshot.tree} />
          <aside
            id={drawerId}
            className="map-drawer"
            aria-label="Agent details"
            hidden={!(badge && (badgeSeat || badge.conversation))}
          >
            {badge && (badgeSeat || badge.conversation) && (
              <BadgeDrawer
                key={`${badge.seat}-${badge.kind}-${badge.conversation?.to ?? ""}-${badge.conversation?.ticket ?? ""}`}
                snapshot={snapshot}
                seat={badgeSeat}
                kind={badge.kind}
                conversation={badge.conversation}
                onClose={closeBadge}
              />
            )}
          </aside>
        </div>
        <div className="map-rail">
          <div className="map-card map-card-agents">
            <AgentCards
              snapshot={snapshot}
              indices={indices}
              names={names}
              selected={agent}
              onSelect={setAgent}
              onZoom={(seat) => {
                setFocus(null);
                setRotate(false);
                setAgentFocus((previous) => ({ seat, request: (previous?.request ?? 0) + 1 }));
              }}
              drawerId={drawerId}
              headingRef={agentsHeading}
              onBadge={(seat, kind, button) => {
                opener.current = button;
                setBadge({ seat, kind });
              }}
            />
          </div>
          <section className="map-card map-card-selected" aria-label="Selected">
            <h3>Selected</h3>
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
            <aside className="map-detail" aria-label="Selected file">
              {selected ? (
                <>
                  <div className="map-detail-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setFocus(null);
                        queueMicrotask(() => setFocus(selected));
                      }}
                    >
                      ⌖ Zoom to file
                    </button>
                    <button type="button" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                  <FileDrawer
                    snapshot={snapshot}
                    path={selected}
                    files={
                      displayNodes.find((n) => n.path === selected)?.files.length
                        ? (displayNodes.find((n) => n.path === selected)?.files ?? [])
                        : [...snapshot.tree.map((f) => f.path), ...extras].filter((f) =>
                            f.startsWith(`${selected}/`),
                          )
                    }
                  />
                </>
              ) : (
                <p className="map-note">Click a node, or find one, to see who read or wrote it.</p>
              )}
            </aside>
          </section>
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
            title="Frame where the agents are working (the whole repo when nobody is)"
            onClick={() => {
              setHome(home + 1);
              setFocus(null);
              setAgentFocus(null);
            }}
          >
            Home view
          </button>
          <button
            type="button"
            onClick={() => {
              setOverview(overview + 1);
              setFocus(null);
              setAgentFocus(null);
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

/** The stage's key: one line of area colours; the full key opens behind "?". */
function MapLegend({ areas, tree }: { areas: string[]; tree: MapSnapshot["tree"] }) {
  const [open, setOpen] = useState(false);
  const keyId = useId();
  return (
    <div className="map-legend">
      {[...areas, "other"].map((area) => (
        <span key={area}>
          <i style={{ background: areaColor(area, areas) }} />
          {area}
        </span>
      ))}
      <button
        type="button"
        className="map-key-toggle"
        aria-expanded={open}
        aria-controls={keyId}
        aria-label="Map key"
        title="Map key"
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open && (
        <div className="map-key" id={keyId} role="note">
          <p>
            Each file is a point, coloured by its area. An agent's colour lights the files its
            unmerged branch changed (bright, bigger with more lines) and the files it read (dim).
            Its orb sits over the files it is working on, with one line: call sign · ticket · files
            changed · <b className="add">+added</b> <b className="rem">−removed</b> (the branch
            diff, or edit churn where the tooltip says so).
          </p>
          <p>
            ○ a file a call is using now · ◌ shared with another branch · ◎ written by two branches
            (overlap, not conflict) ·{" "}
            {(["Critical", "Important", "Minor"] as const).map((s) => (
              <b key={s} style={{ color: `var(${pinToken(s)})` }} title={s}>
                ▲
              </b>
            ))}{" "}
            review findings · <b style={{ color: "var(--crit)" }}>◆</b> a merge conflict between
            open PRs. Hover a file or a mark for detail; click to open it in Selected.
          </p>
          <p>
            Particles: a read flows from the file into the agent, a write the other way, sized by
            the tokens it carried; <b className="add">✦</b> lines added, <b className="rem">✦</b>{" "}
            removed. Arcs are messages. Drag to orbit, scroll to zoom, arrow keys to pan.
          </p>
          <p>
            {tree.length.toLocaleString()} files at origin/HEAD.
            {tree.length > 2000 && " Files are collapsed into folders (more than 2,000 files)."}{" "}
            Findings are the current review's; the hub keeps no fixed state for one. No recorded
            playback: the hub keeps each seat's last 15 minutes of calls in memory only.
          </p>
        </div>
      )}
    </div>
  );
}

function FileDrawer({
  snapshot,
  path,
  files,
}: {
  snapshot: MapSnapshot;
  path: string;
  files: string[];
}) {
  const listed = files.length ? files : [path];
  const imports = snapshot.imports.filter((i) => listed.includes(i.from) || listed.includes(i.to));
  return (
    <>
      <h3>{path}</h3>
      {files.length > 1 && <p>{files.length} files</p>}
      {snapshot.seats.map((s) => {
        const changes = s.scope.modified.filter((c) => listed.includes(c.file));
        const read = s.scope.read.some((f) => listed.includes(f));
        const unchecked = uncheckedNotes(s, snapshot);
        return read || changes.length ? (
          <div key={s.seat}>
            <strong>{s.seat}</strong>
            {read && <p>Read on the branch</p>}
            {unchecked.map((note) => (
              <p className="map-unchecked" key={note}>
                {note}
              </p>
            ))}
            {changes.map((c) => (
              <div key={c.file}>
                <p>
                  {c.file} · +{c.add} −{c.rem} ·{" "}
                  {c.source === "churn" ? "edit churn" : "branch diff"}
                </p>
                {c.source === "diff" && s.seat !== "FLIGHT" && (
                  <BranchDiff seat={s.seat} path={c.file} snapshot={snapshot} />
                )}
              </div>
            ))}
          </div>
        ) : null;
      })}
      {snapshot.findings
        .filter((f) => listed.includes(f.file))
        .map((f) => (
          <Finding finding={f} key={`${f.seat}-${f.file}-${f.line}-${f.summary}`} />
        ))}
      {snapshot.conflicts
        .filter((c) => listed.includes(c.file))
        .map((c) => (
          <p key={`${c.file}:${c.branches.join("|")}`}>Conflict: {c.branches.join(" / ")}</p>
        ))}
      <h4>Imports</h4>
      {imports.length ? (
        imports.map((i) => (
          <p key={`${i.from}-${i.to}`}>
            {i.from} → {i.to}
          </p>
        ))
      ) : (
        <p>No imports recorded.</p>
      )}
    </>
  );
}
function BranchDiff({
  seat,
  path,
  snapshot,
}: {
  seat: string;
  path: string;
  snapshot: MapSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const resource = RESOURCES.fileDiff(seat, path);
  const diff = useResource<FileDiff>(open ? resource : null);
  const previous = useRef(snapshot);
  useEffect(() => {
    if (open && previous.current !== snapshot) hub.refetch(resource.path);
    previous.current = snapshot;
  }, [open, snapshot, resource.path]);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Current checkout diff
      </button>
      {open &&
        (diff.error ? (
          <p>Diff unavailable.</p>
        ) : !diff.data ? (
          <p>Loading diff…</p>
        ) : diff.data.binary ? (
          <p>Binary file</p>
        ) : (
          <>
            <pre>{diff.data.text}</pre>
            {diff.data.truncated && <p>Diff truncated.</p>}
          </>
        ))}
    </>
  );
}
