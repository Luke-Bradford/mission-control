import type { Crew, FileDiff, MapSnapshot, RepoView } from "@mc/core";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { useSessionScope } from "../shell/session.ts";
import { MAP_REPO_KEY, readKey, writeKey } from "../storage.ts";
import { LiveMap } from "./live.ts";
import { layoutTree, pickRepo, pinToken } from "./model.ts";
import "./map.css";

const Scene = lazy(() => import("./MapScene.tsx").then((m) => ({ default: m.MapScene })));

export function CrewMapPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="Crew Activity Map"
      actions={
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Collapse" : "Expand"}
        </button>
      }
    >
      {open && <LiveCrewMap />}
    </Panel>
  );
}

function LiveCrewMap() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const scope = useSessionScope();
  const [manual, setManual] = useState<string | null>(null);
  const [picked, setPicked] = useState(() => readKey(MAP_REPO_KEY) ?? "");
  const ids = repos?.map((r) => r.id) ?? [];
  const repo =
    scope.repo && scope.repo !== "all"
      ? scope.repo
      : manual && ids.includes(manual)
        ? manual
        : pickRepo(
            ids,
            (crew?.rows ?? [])
              .filter((r) => r.kind === "crew" && r.role !== "FLIGHT" && r.hudState === "running")
              .map((r) => ({ repoId: r.repoId, started: r.run?.startedAt ?? r.stateSince })),
            picked,
          );
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [skipped, setSkipped] = useState("");
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setSkipped("");
    setError(null);
    if (!repo) return;
    const live = new LiveMap(
      repo,
      () => apiGet<MapSnapshot>(RESOURCES.repoMap(repo).path),
      setSnapshot,
      setError,
      (calls, messages) =>
        setSkipped(`While this tab was hidden: ${calls} calls, ${messages} messages`),
    );
    live.start();
    return () => live.stop();
  }, [repo]);
  return (
    <div className="pb">
      <label>
        Repo{" "}
        <select
          aria-label="Map repo"
          value={repo}
          disabled={scope.repo !== "all"}
          onChange={(e) => {
            setManual(e.target.value);
            setPicked(e.target.value);
            writeKey(MAP_REPO_KEY, e.target.value);
          }}
        >
          {repos?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="status">{error.message}</p>}
      {skipped && <p role="status">{skipped}</p>}
      {!repo ? (
        <p>No configured repo.</p>
      ) : snapshot?.repoId === repo ? (
        <CrewMapView
          key={repo}
          snapshot={snapshot}
          indices={Object.fromEntries((crew?.rows ?? []).map((r) => [r.id, r.index]))}
        />
      ) : (
        <p>Loading repo map…</p>
      )}
    </div>
  );
}

export function CrewMapView({
  snapshot,
  indices = {},
}: {
  snapshot: MapSnapshot;
  indices?: Record<string, number>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [home, setHome] = useState(0);
  const [rotate, setRotate] = useState(false);
  const treeKey = JSON.stringify(snapshot.tree);
  const nodes = useMemo(() => layoutTree(JSON.parse(treeKey)), [treeKey]);
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
    setSelected(path);
  };
  const searchSelect = (path: string) => {
    setSelected(path);
    setFocus(null);
    queueMicrotask(() => setFocus(path));
  };
  return (
    <>
      <div className="map-toolbar">
        <input
          type="search"
          aria-label="Find a file or folder"
          placeholder="Find a file or folder"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) searchSelect(matches[0]);
          }}
        />
        <button
          type="button"
          onClick={() => {
            setHome(home + 1);
            setFocus(null);
          }}
        >
          Home view
        </button>
        <label>
          <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />{" "}
          rotate
        </label>
      </div>
      <div className="map-content">
        <div>
          <Suspense fallback={<p>Loading 3D map…</p>}>
            <Scene
              nodes={displayNodes}
              snapshot={snapshot}
              focus={focusNode?.path ?? null}
              home={home}
              rotate={rotate}
              selected={selected}
              indices={indices}
              onSelect={select}
            />
          </Suspense>
          <p className="map-note">
            drag to orbit · scroll to zoom · click a file · ⌖ zooms to a file
          </p>
        </div>
        <aside className="map-detail" aria-label="Selected file">
          {query && (
            <div className="map-results">
              {matches.slice(0, 60).map((n) => (
                <button type="button" key={n} onClick={() => searchSelect(n)}>
                  {n}
                </button>
              ))}
              {matches.length > 60 && <p>{matches.length - 60} more; refine your search.</p>}
              {!matches.length && <p>No matching files.</p>}
            </div>
          )}
          {selected ? (
            <>
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
            <p>Click a node, or find one, to see who read or wrote it.</p>
          )}
        </aside>
      </div>
      <div className="map-legend">
        <span>dim: in scope (read on the branch)</span>
        <span>bright: modified · +n −m · size: lines changed</span>
        <span>◌ shared · ◎ write overlap</span>
        <span>white ring: being accessed now · faint: recently accessed</span>
        {(["Critical", "Important", "Minor"] as const).map((s) => (
          <span key={s} style={{ color: `var(${pinToken(s)})` }}>
            ▲ {s}
          </span>
        ))}
      </div>
      <p className="map-note">
        Overlap is not conflict. Findings are from the current review; they have no inferred fixed
        state.{" "}
        {snapshot.tree.length > 2000 && "Files are collapsed into folders (more than 2,000 files)."}
      </p>
    </>
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
          <div className="map-finding" key={`${f.seat}-${f.file}-${f.line}-${f.summary}`}>
            <strong style={{ color: `var(${pinToken(f.severity)})` }}>
              ▲ {f.severity} · {f.seat} · round {f.round}
            </strong>
            <p>
              {f.file}:{f.line} · {f.summary}
            </p>
            <p>{f.scenario}</p>
            <p>Fix: {f.fix}</p>
          </div>
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
