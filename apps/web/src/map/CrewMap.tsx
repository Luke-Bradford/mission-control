import type { Crew, FileDiff, MapSnapshot } from "@mc/core";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiGet } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { AgentCards } from "./AgentCards.tsx";
import { BadgeDrawer, Finding } from "./BadgeDrawer.tsx";
import type { BadgeKind } from "./cards.ts";
import { areaColor, mainAreas } from "./layout.ts";
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
  const status: MapStatus = error
    ? { live: false, text: `${error.message} Retrying.` }
    : { live: true, text: `Live · real time${skipped ? ` · ${skipped}` : ""}` };
  if (snapshot?.repoId !== repo)
    return (
      <div className="map-wait">
        <p role="status">
          {error ? `Map unavailable: ${error.message} Retrying every 5 s.` : "Loading repo map…"}
        </p>
      </div>
    );
  return (
    <CrewMapView
      key={repo}
      snapshot={snapshot}
      events={events}
      epoch={epoch}
      indices={indices}
      status={status}
    />
  );
}

export function CrewMapView({
  snapshot,
  indices = {},
  events = [],
  epoch = 0,
  status,
}: {
  snapshot: MapSnapshot;
  indices?: Record<string, number>;
  events?: MotionEvent[];
  epoch?: number;
  status?: MapStatus;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [home, setHome] = useState(0);
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
  const treeKey = JSON.stringify(snapshot.tree);
  const importKey = JSON.stringify(snapshot.imports);
  const nodes = useMemo(
    () => layoutTree(JSON.parse(treeKey), [], undefined, JSON.parse(importKey)),
    [treeKey, importKey],
  );
  const areas = useMemo(() => mainAreas(JSON.parse(treeKey)), [treeKey]);
  const allFiles = [
    ...new Set(
      snapshot.seats.flatMap((s) => [...s.scope.read, ...s.scope.modified.map((c) => c.file)]),
    ),
  ];
  const extras = allFiles.filter((f) => !snapshot.tree.some((n) => n.path === f));
  const extraKey = JSON.stringify(extras);
  const displayNodes = useMemo(
    () =>
      JSON.parse(extraKey).length
        ? layoutTree(
            JSON.parse(extraKey).map((path: string) => ({ path, lines: 0 })),
            nodes,
            JSON.parse(treeKey).length > 2000,
          )
        : nodes,
    [treeKey, extraKey, nodes],
  );
  const matches = [
    ...new Set([
      ...displayNodes.map((n) => n.path),
      ...snapshot.tree.map((f) => f.path),
      ...extras,
    ]),
  ].filter((path) => path !== "" && path.toLowerCase().includes(query.toLowerCase()));
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
  const active =
    snapshot.findings.length > 0 ||
    snapshot.seats.some(
      (s) => s.calls.length || s.scope.read.length || s.scope.modified.length || s.recent.length,
    );
  return (
    <div className="map-body">
      <div className="map-main">
        <div className="map-stage-wrap">
          <Suspense fallback={<p className="map-wait-note">Loading 3D map…</p>}>
            <Scene
              nodes={displayNodes}
              areas={areas}
              snapshot={snapshot}
              focus={focusNode?.path ?? null}
              home={home}
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
          <p className="map-hint">
            drag to orbit · scroll to zoom · click a file, an orb or a message · ⌖ zooms to an agent
          </p>
          {!active && (
            <p className="map-quiet" role="status">
              {snapshot.seats.length
                ? `No crew activity recorded on ${snapshot.repoId} right now: no seat has a call in flight, a file in scope or an unmerged change. Files light up as soon as a seat reads or edits them.`
                : `No crew seats on ${snapshot.repoId}.`}
            </p>
          )}
          <MapLegend areas={areas} />
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
            onClick={() => {
              setHome(home + 1);
              setFocus(null);
              setAgentFocus(null);
            }}
          >
            Home view
          </button>
          <label>
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />{" "}
            rotate
          </label>
        </span>
        <p className="map-foot">
          {snapshot.tree.length.toLocaleString()} files at origin/HEAD, each its own node ·{" "}
          {snapshot.imports.length.toLocaleString()} import links. Overlap is not conflict: a
          conflict is computed between open PRs' heads. Findings are the current review's; the hub
          keeps no fixed state for a finding. <b className="add">+n</b> <b className="rem">−m</b> is
          the branch diff, or edit churn where labelled. Recorded playback is not available yet: the
          hub keeps each seat's last 15 minutes of calls in memory and serves no history.
          {snapshot.tree.length > 2000 &&
            " Files are collapsed into folders (more than 2,000 files)."}
        </p>
      </div>
    </div>
  );
}

/** The stage's key: area colours first, then every mark the scene draws. */
function MapLegend({ areas }: { areas: string[] }) {
  return (
    <div className="map-legend">
      {[...areas, "other"].map((area) => (
        <span key={area}>
          <i style={{ background: areaColor(area, areas) }} />
          {area}
        </span>
      ))}
      <span>
        <i className="ring" />
        being accessed now
      </span>
      <span>
        {(["Critical", "Important", "Minor"] as const).map((s) => (
          <b key={s} style={{ color: `var(${pinToken(s)})` }} title={s}>
            ▲
          </b>
        ))}{" "}
        review findings
      </span>
      <span className="wide">
        → particles: a read flows from the file into the agent, a write from the agent into the
        file, sized by the tokens it carried · <b className="add">✦</b> lines added spark in,{" "}
        <b className="rem">✦</b> removed spark out · ▲ burst: the change grew a level
      </span>
      <span className="wide">
        bright: modified, sized by lines changed, <b className="add">+n</b>{" "}
        <b className="rem">−m</b> · dim: in scope (read on the branch) · ◌ shared · ◎ write overlap
        · ● orb: the agent · ◆ CAPCOM and HUB · arcs: a message
      </span>
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
        return read || changes.length ? (
          <div key={s.seat}>
            <strong>{s.seat}</strong>
            {read && <p>Read on the branch</p>}
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
          <p key={c.file}>Conflict: {c.branches.join(" / ")}</p>
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
