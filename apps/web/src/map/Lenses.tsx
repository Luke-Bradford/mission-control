import type { MapSnapshot } from "@mc/core";
import { githubItemHref } from "../links.ts";

export type MapLens = "changes" | "impact" | "history";
export interface LensVisual {
  /** Impact: seat colour index and dependency distance (zero is a changed seed). */
  seat?: number;
  distance?: number;
  overlap?: boolean;
  /** History: merged-PR heat and a conspicuous bug-fix signal. */
  hotspot?: number;
  fixes?: number;
  confidence?: number;
  linked?: boolean;
  focused?: boolean;
  dim?: boolean;
}

const isTest = (path: string) =>
  /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const name = (path: string) => path.split("/").at(-1) ?? path;

interface Graph {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  cycles: string[][];
}

export function graph(snapshot: MapSnapshot): Graph {
  const paths = new Set(snapshot.tree.map((file) => file.path));
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const path of paths) {
    forward.set(path, new Set());
    reverse.set(path, new Set());
  }
  for (const edge of snapshot.imports) {
    if (!paths.has(edge.from) || !paths.has(edge.to)) continue;
    forward.get(edge.from)?.add(edge.to);
    reverse.get(edge.to)?.add(edge.from);
  }
  const cycles: string[][] = [];
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  let index = 0;
  const visit = (path: string) => {
    indices.set(path, index);
    low.set(path, index++);
    stack.push(path);
    stacked.add(path);
    for (const next of forward.get(path) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(path, Math.min(low.get(path) ?? 0, low.get(next) ?? 0));
      } else if (stacked.has(next)) {
        low.set(path, Math.min(low.get(path) ?? 0, indices.get(next) ?? 0));
      }
    }
    if (low.get(path) !== indices.get(path)) return;
    const component: string[] = [];
    let next: string;
    do {
      next = stack.pop() as string;
      stacked.delete(next);
      component.push(next);
    } while (next !== path);
    if (component.length > 1 || forward.get(path)?.has(path)) cycles.push(component.sort());
  };
  for (const path of paths) if (!indices.has(path)) visit(path);
  return { forward, reverse, cycles };
}

/** Direct import edges around a focused file, drawn over the 3D map in Impact mode. */
export function impactFocusLinks(
  snapshot: MapSnapshot,
  path: string | null,
): { from: string; to: string }[] {
  if (path === null) return [];
  const { forward, reverse } = graph(snapshot);
  return [
    ...[...(forward.get(path) ?? [])].map((to) => ({ from: path, to })),
    ...[...(reverse.get(path) ?? [])].map((from) => ({ from, to: path })),
  ];
}

export function downstream(path: string, reverse: Map<string, Set<string>>) {
  const distances = new Map([[path, 0]]);
  const queue = [path];
  while (queue.length) {
    const current = queue.shift() as string;
    const distance = distances.get(current) ?? 0;
    for (const next of reverse.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  distances.delete(path);
  return distances;
}
function downstreamFrom(paths: string[], reverse: Graph["reverse"]) {
  const distances = new Map(paths.map((path) => [path, 0]));
  const queue = [...paths];
  while (queue.length) {
    const current = queue.shift() as string;
    const distance = distances.get(current) ?? 0;
    for (const next of reverse.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  for (const path of paths) distances.delete(path);
  return distances;
}
function importChain(from: string, targets: Set<string>, forward: Graph["forward"]) {
  const previous = new Map<string, string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.shift() as string;
    if (current !== from && targets.has(current)) {
      const chain = [current];
      while (chain[0] !== from) chain.unshift(previous.get(chain[0] as string) as string);
      return chain;
    }
    for (const next of forward.get(current) ?? [])
      if (!previous.has(next) && next !== from) {
        previous.set(next, current);
        queue.push(next);
      }
  }
  return null;
}

const isBarrel = (path: string) => /(^|\/)index\.[cm]?[jt]sx?$/.test(path);
function linked(a: string, b: string, forward: Graph["forward"], reverse: Graph["reverse"]) {
  if (forward.get(a)?.has(b) || reverse.get(a)?.has(b)) return true;
  return [a, b].some((from, index) => {
    const to = index ? a : b;
    return [...(forward.get(from) ?? [])].some(
      (barrel) => isBarrel(barrel) && forward.get(barrel)?.has(to),
    );
  });
}

export function historyFocusLinks(snapshot: MapSnapshot, path: string | null) {
  if (path === null) return [];
  const { forward, reverse } = graph(snapshot);
  return snapshot.hist.coupling.flatMap(([left, right, , confidence]) => {
    const a = snapshot.tree[left]?.path;
    const b = snapshot.tree[right]?.path;
    if (!a || !b || (a !== path && b !== path)) return [];
    return [{ from: a, to: b, unlinked: !linked(a, b, forward, reverse), confidence }];
  });
}

/** Per-file map styling data for the active analytical lens. */
export function lensVisuals(
  snapshot: MapSnapshot,
  lens: MapLens,
  focus: string | null,
): Record<string, LensVisual> {
  if (lens === "changes") return {};
  if (lens === "impact") {
    const { forward, reverse } = graph(snapshot);
    const out: Record<string, LensVisual> = {};
    changed(snapshot).forEach(({ files }, seat) => {
      const code = files.filter((path) => reverse.has(path));
      for (const path of code) {
        const prior = out[path];
        out[path] = {
          seat: prior?.seat ?? seat,
          distance: 0,
          overlap: prior !== undefined && prior.seat !== seat,
          focused: focus === path,
        };
      }
      for (const [path, distance] of downstreamFrom(code, reverse)) {
        const prior = out[path];
        out[path] = {
          seat: prior?.seat ?? seat,
          distance: Math.min(prior?.distance ?? Infinity, distance),
          overlap: prior !== undefined && prior.seat !== seat,
          focused: focus === path,
        };
      }
    });
    if (focus !== null) {
      const related = new Set([
        focus,
        ...downstream(focus, reverse).keys(),
        ...(forward.get(focus) ?? []),
      ]);
      for (const { path } of snapshot.tree)
        out[path] = { ...(out[path] ?? {}), focused: path === focus, dim: !related.has(path) };
    }
    return out;
  }
  const out: Record<string, LensVisual> = Object.fromEntries(
    Object.entries(snapshot.hist.files).flatMap(([index, history]) => {
      const path = snapshot.tree[Number(index)]?.path;
      return path
        ? [[path, { hotspot: history[0], fixes: history[1], focused: focus === path }]]
        : [];
    }),
  );
  if (focus !== null) {
    const partners = historyFocusLinks(snapshot, focus);
    const partnerSet = new Set(partners.flatMap(({ from, to }) => [from, to]));
    for (const { path } of snapshot.tree) {
      const partner = partners.find((edge) => edge.from === path || edge.to === path);
      out[path] = {
        ...(out[path] ?? {}),
        focused: path === focus,
        dim: !partnerSet.has(path),
        confidence: partner?.confidence,
        linked: partner ? !partner.unlinked : undefined,
      };
    }
  }
  return out;
}

function changed(snapshot: MapSnapshot) {
  return snapshot.seats.map((seat) => ({
    seat,
    files: [...new Set(seat.scope.modified.filter((c) => c.add + c.rem > 0).map((c) => c.file))],
  }));
}

function FileButton({ path, onFocus }: { path: string; onFocus: (path: string) => void }) {
  return (
    <button type="button" className="map-lens-file" onClick={() => onFocus(path)}>
      {path}
    </button>
  );
}

export function LensTabs({ lens, onChange }: { lens: MapLens; onChange: (lens: MapLens) => void }) {
  return (
    <fieldset className="map-lens-tabs">
      <legend className="sr-only">Map lens</legend>
      {(["changes", "impact", "history"] as const).map((item) => (
        <button
          type="button"
          key={item}
          aria-pressed={lens === item}
          onClick={() => onChange(item)}
        >
          {item[0].toUpperCase() + item.slice(1)}
        </button>
      ))}
    </fieldset>
  );
}

export function ImpactLens({
  snapshot,
  focus,
  onFocus,
}: {
  snapshot: MapSnapshot;
  focus: string | null;
  onFocus: (path: string | null) => void;
}) {
  const { forward, reverse, cycles } = graph(snapshot);
  const allChanged = changed(snapshot);
  if (focus !== null) {
    const reaches = downstream(focus, reverse);
    const tests = [...reaches.keys()].filter(isTest).sort();
    return (
      <section className="map-lens" aria-label="Impact lens">
        <LensFocus path={focus} onBack={() => onFocus(null)} />
        <div className="map-lens-kpis">
          <b>
            {reverse.get(focus)?.size ?? 0}
            <small>import it</small>
          </b>
          <b>
            {reaches.size}
            <small>depend on it</small>
          </b>
          <b>
            {tests.length}
            <small>tests reach it</small>
          </b>
          <b>
            {forward.get(focus)?.size ?? 0}
            <small>it imports</small>
          </b>
        </div>
        <FileList
          title="Imported by"
          paths={[...(reverse.get(focus) ?? [])].sort()}
          onFocus={onFocus}
        />
        <FileList title="Tests that reach it" paths={tests} onFocus={onFocus} />
        <FileList
          title="It imports"
          paths={[...(forward.get(focus) ?? [])].sort()}
          onFocus={onFocus}
        />
        <FileList
          title="Further downstream"
          paths={[...reaches.keys()].filter((path) => (reaches.get(path) ?? 0) > 1).sort()}
          onFocus={onFocus}
        />
      </section>
    );
  }
  const untested = allChanged.flatMap(({ seat, files }) =>
    files
      .filter((path) => !isTest(path) && ![...downstream(path, reverse).keys()].some(isTest))
      .map((path) => ({ seat: seat.seat, path })),
  );
  const overlap = allChanged.flatMap((owner) =>
    allChanged
      .filter((other) => other.seat.seat !== owner.seat.seat)
      .flatMap((other) =>
        other.files.flatMap((path) => {
          const chain = importChain(path, new Set(owner.files), forward);
          return chain ? [{ owner: owner.seat.seat, other: other.seat.seat, path, chain }] : [];
        }),
      ),
  );
  return (
    <section className="map-lens" aria-label="Impact lens">
      <header>
        <h2>Impact</h2>
        <p>what the seats’ changes reach through imports</p>
      </header>
      {allChanged.map(({ seat, files }) => {
        const code = files.filter((path) => forward.has(path));
        const reached = downstreamFrom(code, reverse);
        const direct = [...reached.values()].filter((distance) => distance === 1).length;
        return (
          <div className="map-lens-section" key={seat.seat}>
            <h3>{seat.seat}</h3>
            <p>
              {files.length} files changed → <b>{direct}</b> import them · <b>{reached.size}</b>{" "}
              depend on them
            </p>
            {code.map((path) => (
              <div className="map-lens-row" key={path}>
                <FileButton path={path} onFocus={onFocus} />
                <span>
                  {[...downstream(path, reverse).keys()].filter(isTest).length
                    ? "test reaches it"
                    : "no test"}
                </span>
                <span>
                  {reverse.get(path)?.size ?? 0} · {downstream(path, reverse).size}
                </span>
              </div>
            ))}
          </div>
        );
      })}
      <div className="map-lens-section">
        <h3>Changes overlap through imports</h3>
        {overlap.length ? (
          overlap.map((row) => (
            <p key={`${row.owner}:${row.other}:${row.path}`}>
              <b>{row.other}</b> changed <FileButton path={row.path} onFocus={onFocus} /> which
              depends on <b>{row.owner}</b>’s changes · {row.chain.length - 1} steps:{" "}
              {row.chain.map(name).join(" → ")}.
            </p>
          ))
        ) : (
          <p>No seat changes a dependent file.</p>
        )}
      </div>
      <div className="map-lens-section">
        <h3>Changed, and no test imports them</h3>
        {untested.length ? (
          untested.map((row) => (
            <p key={`${row.seat}:${row.path}`}>
              <b>{row.seat}</b> <FileButton path={row.path} onFocus={onFocus} />
            </p>
          ))
        ) : (
          <p>Every changed file is reached by a test.</p>
        )}
      </div>
      <div className="map-lens-section">
        <h3>Import cycles</h3>
        {cycles.length ? (
          cycles.map((cycle) => (
            <p key={cycle.join("/")}>
              {cycle.map((path, i) => (
                <span key={path}>
                  {i ? " ⇄ " : ""}
                  <FileButton path={path} onFocus={onFocus} />
                </span>
              ))}
            </p>
          ))
        ) : (
          <p>No import cycles.</p>
        )}
      </div>
    </section>
  );
}

function LensFocus({ path, onBack }: { path: string; onBack: () => void }) {
  return (
    <header>
      <button type="button" className="map-lens-back" onClick={onBack}>
        ← All files
      </button>
      <h2>{path}</h2>
    </header>
  );
}

function FileList({
  title,
  paths,
  onFocus,
}: {
  title: string;
  paths: string[];
  onFocus: (path: string) => void;
}) {
  return (
    <div className="map-lens-section">
      <h3>{title}</h3>
      {paths.length ? (
        paths.map((path) => <FileButton key={path} path={path} onFocus={onFocus} />)
      ) : (
        <p>None</p>
      )}
    </div>
  );
}

export function HistoryLens({
  snapshot,
  focus,
  onFocus,
  github,
}: {
  snapshot: MapSnapshot;
  focus: string | null;
  onFocus: (path: string | null) => void;
  github?: string;
}) {
  const { forward, reverse } = graph(snapshot);
  const histories = new Map(
    Object.entries(snapshot.hist.files).flatMap(([index, value]) => {
      const path = snapshot.tree[Number(index)]?.path;
      return path ? [[path, value] as const] : [];
    }),
  );
  const partners = new Map<
    string,
    { path: string; count: number; share: number; linked: boolean }[]
  >();
  for (const [left, right, count, share] of snapshot.hist.coupling) {
    const a = snapshot.tree[left]?.path;
    const b = snapshot.tree[right]?.path;
    if (!a || !b) continue;
    const isLinked = linked(a, b, forward, reverse);
    for (const [path, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = partners.get(path) ?? [];
      list.push({ path: other, count, share, linked: isLinked });
      partners.set(path, list);
    }
  }
  if (focus !== null) {
    const history = histories.get(focus);
    const prs = (history?.[3] ?? []).filter((number) => Number.isSafeInteger(number) && number > 0);
    return (
      <section className="map-lens" aria-label="History lens">
        <LensFocus path={focus} onBack={() => onFocus(null)} />
        <div className="map-lens-kpis">
          <b>
            {history?.[0] ?? 0}
            <small>merged PRs</small>
          </b>
          <b>
            {history?.[1] ?? 0}
            <small>fixed a bug</small>
          </b>
          <b>
            {partners.get(focus)?.length ?? 0}
            <small>change with it</small>
          </b>
        </div>
        <div className="map-lens-section">
          <h3>Latest PRs</h3>
          {prs.length ? (
            prs.map((number) => {
              const href = github ? githubItemHref(github, "pr", number) : null;
              return href ? (
                <a key={number} className="map-pr" href={href}>
                  #{number}
                </a>
              ) : (
                <span key={number} className="map-pr">
                  #{number}
                </span>
              );
            })
          ) : (
            <p>No merged PR changed this file in this window.</p>
          )}
        </div>
        <div className="map-lens-section">
          <h3>Changes together with</h3>
          {(partners.get(focus) ?? []).map((partner) => (
            <div className="map-lens-row" key={partner.path}>
              <FileButton path={partner.path} onFocus={onFocus} />
              <span>{partner.linked ? "import" : "no import"}</span>
              <span>
                {partner.count} · {Math.round(partner.share * 100)}%
              </span>
            </div>
          ))}
        </div>
      </section>
    );
  }
  const hotspots = changed(snapshot)
    .flatMap(({ seat, files }) =>
      files.flatMap((path) => {
        const history = histories.get(path);
        return history === undefined ? [] : [{ seat: seat.seat, path, history }];
      }),
    )
    .sort((a, b) => b.history[0] - a.history[0]);
  const fixed = [...histories.entries()]
    .filter(([, history]) => history[1] > 0)
    .sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0])
    .slice(0, 10);
  const unlinked = [...partners.entries()]
    .flatMap(([source, rows]) =>
      rows
        .filter((row) => source < row.path && !row.linked && !isTest(source) && !isTest(row.path))
        .map((row) => ({ source, ...row })),
    )
    .sort((a, b) => b.count - a.count);
  return (
    <section className="map-lens" aria-label="History lens">
      <header>
        <h2>History</h2>
        <p>
          {snapshot.hist.prCount} merged PRs · {snapshot.hist.fixCount} fixed a bug
        </p>
      </header>
      <HistoryRows
        title="Hotspots the seats are changing"
        rows={hotspots.map(({ path, history }) => ({
          path,
          text: `${history[0]} · ${history[1]}`,
        }))}
        onFocus={onFocus}
      />
      <HistoryRows
        title="Fixed most often"
        rows={fixed.map(([path, history]) => ({ path, text: `${history[1]} of ${history[0]}` }))}
        onFocus={onFocus}
      />
      <HistoryRows
        title="Change together, no import between them"
        rows={unlinked.map((row) => ({
          label: `${name(row.source)} + ${name(row.path)}`,
          text: `${row.count} PRs · ${Math.round(row.share * 100)}%`,
          focus: row.source,
        }))}
        onFocus={onFocus}
      />
    </section>
  );
}

function HistoryRows({
  title,
  rows,
  onFocus,
}: {
  title: string;
  rows: { path?: string; label?: string; text: string; focus?: string }[];
  onFocus: (path: string) => void;
}) {
  return (
    <div className="map-lens-section">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((row) => {
          const path = row.path ?? row.focus ?? "";
          return (
            <div className="map-lens-row" key={`${path}:${row.text}`}>
              <FileButton path={row.label ?? path} onFocus={() => onFocus(row.focus ?? path)} />
              <span>{row.text}</span>
            </div>
          );
        })
      ) : (
        <p>None in this history window.</p>
      )}
    </div>
  );
}
