import { FINDING_SEVERITIES, type FindingSeverity, globMatches, type MapSnapshot } from "@mc/core";
import { githubItemHref } from "../links.ts";
import { seatToken, touchedFiles } from "./cards.ts";

export type MapLens = "changes" | "impact" | "history" | "ownership" | "review" | "conflicts";
export interface LensVisual {
  /** Changes: every seat that currently changed or read this file. */
  changes?: {
    seat: string;
    changed: boolean;
    read: boolean;
    add: number;
    rem: number;
    lines: number;
  }[];
  /** Impact: seat colour index and dependency distance (zero is a changed seed). */
  seat?: number;
  distance?: number;
  overlap?: boolean;
  /** Focused Impact: the file the focused file imports directly. */
  directImport?: boolean;
  /** History: merged-PR heat and a conspicuous bug-fix signal. */
  hotspot?: number;
  fixes?: number;
  confidence?: number;
  linked?: boolean;
  focused?: boolean;
  dim?: boolean;
  /** Ownership: the matching configured map area. */
  area?: string;
  hardRule?: boolean;
  /** Review: highest severity and number of findings for this file. */
  severity?: FindingSeverity;
  findings?: number;
  /** Conflicts: this file is in the hub's merge-conflict check. */
  conflict?: boolean;
}

/** The ownership areas' colours, in rules order: the mockup's three first, then other distinct tokens. */
const AREA_TOKENS = ["--r1", "--r3", "--r2", "--r4", "--r5", "--r6", "--r7", "--r8"] as const;

/** The repo's ownership rules: which area owns a path (null for none), and whether it is hard-rule. */
export interface Ownership {
  /** Area labels, in the rules' order. */
  labels: string[];
  /** Each area's colour, by its place in `labels`. */
  colours: Record<string, string>;
  globs: Record<string, string[]>;
  areaOf: (path: string) => string | null;
  isHardRule: (path: string) => boolean;
}
const ownershipCache = new WeakMap<object, Ownership>();
export function ownershipOf(rules: MapSnapshot["rules"] | undefined): Ownership | null {
  if (!rules) return null;
  const cached = ownershipCache.get(rules);
  if (cached) return cached;
  const areas = Object.entries(rules.areas);
  // a path's answer is kept: the map asks for every tile and folder on each draw
  const areaMemo = new Map<string, string | null>();
  const hardMemo = new Map<string, boolean>();
  const out: Ownership = {
    labels: areas.map(([label]) => label),
    colours: Object.fromEntries(
      areas.map(([label], i) => [label, `var(${AREA_TOKENS[i % AREA_TOKENS.length]})`]),
    ),
    globs: rules.areas,
    areaOf: (path) => {
      let hit = areaMemo.get(path);
      if (hit === undefined) {
        hit = areas.find(([, globs]) => globs.some((g) => globMatches(g, path)))?.[0] ?? null;
        areaMemo.set(path, hit);
      }
      return hit;
    },
    isHardRule: (path) => {
      let hit = hardMemo.get(path);
      if (hit === undefined) {
        // case-insensitive, as the engine reads hard rules
        hit = rules.hardRules.some((g) => globMatches(g, path, true));
        hardMemo.set(path, hit);
      }
      return hit;
    },
  };
  ownershipCache.set(rules, out);
  return out;
}

const isTest = (path: string) =>
  /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const isCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path);
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

/** Complete reverse reach and direct imports around a focused file. */
export function impactFocusLinks(
  snapshot: MapSnapshot,
  path: string | null,
): { from: string; to: string }[] {
  if (path === null) return [];
  const { forward, reverse } = graph(snapshot);
  const related = new Set([...downstream(path, reverse).keys(), ...(forward.get(path) ?? [])]);
  related.delete(path);
  return [...related].map((to) => ({ from: path, to }));
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

function lineCounts(seat: MapSnapshot["seats"][number], path: string) {
  const change = seat.scope.modified.find((item) => item.file === path);
  const add = change?.add ?? 0;
  const rem = change?.rem ?? 0;
  return { add, rem, lines: add + rem };
}

/**
 * Changes, inside a time window: a seat keeps a file only if one of its ticks for it falls in the
 * window (the mockup's inWin); a file no seat keeps drops out.
 */
export function windowVisuals(
  visual: Record<string, LensVisual>,
  seats: MapSnapshot["seats"],
  win: [from: number, to: number],
): Record<string, LensVisual> {
  const seen = new Map(
    seats.map((seat) => [
      seat.seat,
      new Set(
        seat.recent.filter((tick) => tick.at >= win[0] && tick.at <= win[1]).map((t) => t.file),
      ),
    ]),
  );
  const out: Record<string, LensVisual> = {};
  for (const [path, v] of Object.entries(visual)) {
    const changes = (v.changes ?? []).filter((change) => seen.get(change.seat)?.has(path));
    if (changes.length) out[path] = { ...v, changes };
  }
  return out;
}

const severityOrder = Object.fromEntries(
  FINDING_SEVERITIES.map((severity, i) => [severity, i]),
) as Record<FindingSeverity, number>;
/** The highest severity among a file's findings. */
const topSeverity = (findings: MapSnapshot["findings"]) =>
  [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0]?.severity;

/** Changes: every seat's changed and read files, with the lines it moved. */
function changesVisuals(snapshot: MapSnapshot): Record<string, LensVisual> {
  const out: Record<string, LensVisual> = {};
  snapshot.seats.forEach((seat) => {
    const changed = new Set(
      seat.scope.modified
        .filter((change) => change.add + change.rem > 0)
        .map((change) => change.file),
    );
    const read = new Set([...seat.scope.read, ...touchedFiles(seat)]);
    for (const path of new Set([...changed, ...read])) {
      const visual = out[path] ?? { changes: [] };
      out[path] = visual;
      visual.changes?.push({
        seat: seat.seat,
        changed: changed.has(path),
        read: read.has(path),
        ...lineCounts(seat, path),
      });
    }
  });
  return out;
}

/** Per-file map styling data for the active lens. */
export function lensVisuals(
  snapshot: MapSnapshot,
  lens: MapLens,
  focus: string | null,
): Record<string, LensVisual> {
  if (lens === "changes") return changesVisuals(snapshot);
  if (lens === "ownership") {
    const owner = ownershipOf(snapshot.rules);
    if (!owner) return {};
    return Object.fromEntries(
      snapshot.tree.map(({ path }) => [
        path,
        { area: owner.areaOf(path) ?? undefined, hardRule: owner.isHardRule(path) },
      ]),
    );
  }
  if (lens === "review") {
    const grouped = new Map<string, MapSnapshot["findings"]>();
    for (const finding of snapshot.findings) {
      const rows = grouped.get(finding.file) ?? [];
      rows.push(finding);
      grouped.set(finding.file, rows);
    }
    return Object.fromEntries(
      [...grouped].map(([path, findings]) => [
        path,
        { severity: topSeverity(findings), findings: findings.length },
      ]),
    );
  }
  if (lens === "conflicts") {
    // the seats' changes, faded, with the files that conflict marked on them
    const out = changesVisuals(snapshot);
    for (const { file } of snapshot.conflicts) out[file] = { ...out[file], conflict: true };
    return out;
  }
  if (lens === "impact") {
    const { forward, reverse } = graph(snapshot);
    const out: Record<string, LensVisual> = {};
    const codeChanged = changed(snapshot).map(({ seat, files }) => ({
      seat,
      files: files.filter((path) => isCode(path) && !isTest(path)),
    }));
    const overlap = importOverlaps(codeChanged, forward);
    codeChanged.forEach(({ files }, seat) => {
      const code = files.filter((path) => reverse.has(path));
      for (const path of code) {
        const prior = out[path];
        out[path] = {
          seat: prior?.seat ?? seat,
          distance: 0,
          overlap: overlap.has(path),
          focused: focus === path,
        };
      }
      for (const [path, distance] of downstreamFrom(code, reverse)) {
        const prior = out[path];
        out[path] = {
          seat: prior?.seat ?? seat,
          distance: Math.min(prior?.distance ?? Infinity, distance),
          overlap: false,
          focused: focus === path,
        };
      }
    });
    if (focus !== null) {
      const reaches = downstream(focus, reverse);
      const imports = forward.get(focus) ?? new Set<string>();
      const related = new Set([focus, ...reaches.keys(), ...imports]);
      for (const path of related) {
        const prior = out[path];
        if (path === focus || reaches.has(path)) {
          const focusDistance = path === focus ? 0 : (reaches.get(path) as number);
          out[path] = {
            ...prior,
            seat: prior?.seat ?? 0,
            distance: Math.min(prior?.distance ?? Infinity, focusDistance),
            focused: path === focus,
            dim: false,
          };
        } else {
          const { distance: _distance, seat: _seat, ...rest } = prior ?? {};
          out[path] = { ...rest, directImport: true, focused: false, dim: false };
        }
      }
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

function importOverlaps(seats: ReturnType<typeof changed>, forward: Graph["forward"]): Set<string> {
  const paths = new Set<string>();
  for (const other of seats) {
    for (const owner of seats) {
      if (owner.seat.seat === other.seat.seat) continue;
      for (const path of other.files) {
        // A shared file is a normal edit conflict, not an import-chain overlap.
        const targets = new Set(owner.files.filter((target) => target !== path));
        if (targets.size && importChain(path, targets, forward)) paths.add(path);
      }
    }
  }
  return paths;
}

function FileButton({ path, onFocus }: { path: string; onFocus: (path: string) => void }) {
  const parts = path.split("/");
  const filename = parts.at(-1) ?? path;
  const directory =
    parts.length > 3
      ? `…/${parts.slice(-3, -1).join("/")}/`
      : parts.length > 1
        ? `${parts.slice(0, -1).join("/")}/`
        : "";
  return (
    <button
      type="button"
      className="map-lens-file"
      onClick={() => onFocus(path)}
      title={path}
      aria-label={path}
    >
      <span className="map-lens-directory">{directory}</span>
      <span className="map-lens-filename">{filename}</span>
    </button>
  );
}

export function LensTabs({ lens, onChange }: { lens: MapLens; onChange: (lens: MapLens) => void }) {
  return (
    <fieldset className="map-lens-tabs">
      <legend className="sr-only">Map lens</legend>
      {(["changes", "impact", "history", "ownership", "review", "conflicts"] as const).map(
        (item) => (
          <button
            type="button"
            key={item}
            aria-pressed={lens === item}
            onClick={() => onChange(item)}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ),
      )}
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
  const allChanged = changed(snapshot).filter(({ files }) => files.length > 0);
  const allChangedCode = allChanged.map(({ seat, files }) => ({
    seat,
    files: files.filter((path) => isCode(path) && !isTest(path)),
  }));
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
          paths={[...reaches.keys()]
            .filter((path) => (reaches.get(path) ?? 0) > 1 && !isTest(path))
            .sort()}
          onFocus={onFocus}
        />
      </section>
    );
  }
  const untested = allChangedCode.flatMap(({ seat, files }) =>
    files
      .filter((path) => !isTest(path) && ![...downstream(path, reverse).keys()].some(isTest))
      .map((path) => ({ seat: seat.seat, path })),
  );
  const overlap = allChangedCode.flatMap((owner) =>
    allChangedCode
      .filter((other) => other.seat.seat !== owner.seat.seat)
      .flatMap((other) =>
        other.files.flatMap((path) => {
          const chain = importChain(
            path,
            new Set(owner.files.filter((target) => target !== path)),
            forward,
          );
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
      {allChanged.map(({ seat, files }, index) => {
        const code = allChangedCode[index]?.files.filter((path) => forward.has(path)) ?? [];
        const reached = downstreamFrom(code, reverse);
        const direct = [...reached.values()].filter((distance) => distance === 1).length;
        return (
          <div className="map-lens-section" key={seat.seat}>
            <h3>{seat.seat}</h3>
            <p>
              {files.length} files changed → <b>{direct}</b> import them · <b>{reached.size}</b>{" "}
              depend on them
            </p>
            {files.some(isTest) && (
              <p className="map-lens-note">
                Test files changed separately: {files.filter(isTest).length}
              </p>
            )}
            <div className="map-lens-columns">
              <span>changed file</span>
              <span>tests · import · depend</span>
            </div>
            {code.map((path) => (
              <div className="map-lens-row" key={path}>
                <FileButton path={path} onFocus={onFocus} />
                <span>{[...downstream(path, reverse).keys()].filter(isTest).length}</span>
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
  const hotspots = [...new Set(changed(snapshot).flatMap(({ files }) => files))]
    .filter((path) => !isTest(path))
    .flatMap((path) => {
      const history = histories.get(path);
      return history === undefined ? [] : [{ path, history }];
    })
    .sort((a, b) => b.history[0] - a.history[0]);
  const fixed = [...histories.entries()]
    .filter(([path, history]) => history[1] > 0 && !isTest(path))
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
        columns="PRs · fixes"
        rows={hotspots.map(({ path, history }) => ({
          path,
          text: `${history[0]} · ${history[1]}`,
        }))}
        onFocus={onFocus}
      />
      <HistoryRows
        title="Fixed most often"
        columns="fixes · PRs"
        rows={fixed.map(([path, history]) => ({ path, text: `${history[1]} of ${history[0]}` }))}
        onFocus={onFocus}
      />
      <HistoryRows
        title="Change together, no import between them"
        columns="PRs · share"
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

const noNames: Record<string, string> = {};
const noIndices: Record<string, number> = {};

/** A seat's colour dot and call sign. */
function SeatTag({
  seat,
  names,
  indices,
}: {
  seat: string;
  names: Record<string, string>;
  indices: Record<string, number>;
}) {
  return (
    <span className="map-lens-note">
      <i
        className="map-lens-seat-dot"
        style={{ background: `var(${seatToken(seat, indices[seat] ?? 0)})` }}
        aria-hidden="true"
      />
      {names[seat] ?? seat}
    </span>
  );
}

interface SeatProps {
  /** Each seat's call sign. */
  names?: Record<string, string>;
  /** Each seat's colour, its place in config order. */
  indices?: Record<string, number>;
}

export function OwnershipLens({
  snapshot,
  names = noNames,
  indices = noIndices,
  onFocus,
}: SeatProps & {
  snapshot: MapSnapshot;
  onFocus: (path: string) => void;
}) {
  const owner = ownershipOf(snapshot.rules);
  const header = (
    <header>
      <h2>Ownership</h2>
      <p>areas and hard-rule files from repository rules</p>
    </header>
  );
  if (!owner)
    return (
      <section className="map-lens" aria-label="Ownership lens">
        {header}
        <div className="map-lens-section">
          <p>Ownership rules are not available in this map snapshot yet.</p>
        </div>
      </section>
    );
  // null is the files no area owns
  const areas = new Map<string | null, { files: number; lines: number }>(
    [...owner.labels, null].map((label) => [label, { files: 0, lines: 0 }]),
  );
  for (const file of snapshot.tree) {
    const row = areas.get(owner.areaOf(file.path));
    if (!row) continue;
    row.files++;
    row.lines += file.lines;
  }
  const owned = snapshot.tree.length - (areas.get(null)?.files ?? 0);
  const changed = snapshot.seats.flatMap((seat) =>
    seat.scope.modified
      .filter((change) => change.add + change.rem > 0)
      .map((change) => ({ seat: seat.seat, path: change.file, add: change.add, rem: change.rem })),
  );
  const hardFiles = snapshot.tree.filter((file) => owner.isHardRule(file.path)).length;
  const hardChanged = changed.filter(({ path }) => owner.isHardRule(path));
  return (
    <section className="map-lens" aria-label="Ownership lens">
      {header}
      <div className="map-lens-kpis">
        <b>
          {owned}
          <small>of {snapshot.tree.length} files owned by an area</small>
        </b>
        <b>
          {owner.labels.length}
          <small>areas</small>
        </b>
      </div>
      <div className="map-lens-section">
        <h3>Area coverage</h3>
        <div className="map-lens-covbar" aria-hidden="true">
          {owner.labels.map((label) => (
            <i
              key={label}
              style={{
                width: `${(100 * (areas.get(label)?.files ?? 0)) / Math.max(1, snapshot.tree.length)}%`,
                background: owner.colours[label],
              }}
            />
          ))}
        </div>
        <div className="map-lens-columns">
          <span>area</span>
          <span>files · lines</span>
        </div>
        {[...areas.entries()].map(([area, row]) => (
          <div className="map-lens-row" key={area ?? "(none)"}>
            <span>
              {area ?? "none"}{" "}
              <span className="map-lens-note">
                {area === null ? "everything else" : owner.globs[area]?.join(", ")}
              </span>
            </span>
            <span>
              {row.files} · {row.lines.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      <div className="map-lens-section">
        <h3>Files changing now</h3>
        {changed.length ? (
          changed.map(({ seat, path }) => (
            <div className="map-lens-row" key={`${seat}:${path}`}>
              <FileButton path={path} onFocus={onFocus} />
              <span>
                {names[seat] ?? seat} · {owner.areaOf(path) ?? "none"}
              </span>
            </div>
          ))
        ) : (
          <p>None</p>
        )}
      </div>
      <div className="map-lens-section">
        <h3>
          Hard-rule files changed · {new Set(hardChanged.map(({ path }) => path)).size} of{" "}
          {hardFiles}
        </h3>
        {hardChanged.length ? (
          hardChanged.map(({ seat, path, add, rem }) => (
            <div className="map-lens-row" key={`${seat}:${path}`}>
              <FileButton path={path} onFocus={onFocus} />
              <SeatTag seat={seat} names={names} indices={indices} />
              <span>
                <span className="add">+{add}</span> <span className="rem">−{rem}</span>
              </span>
            </div>
          ))
        ) : (
          <p>None</p>
        )}
        <p className="map-lens-note">
          Hard-rule globs: {snapshot.rules.hardRules.join(", ") || "none"}
        </p>
      </div>
    </section>
  );
}

export function ReviewLens({
  snapshot,
  names = noNames,
  onFocus,
}: Pick<SeatProps, "names"> & {
  snapshot: MapSnapshot;
  onFocus: (path: string) => void;
}) {
  const rows = new Map<string, MapSnapshot["findings"]>();
  for (const finding of snapshot.findings) {
    const group = rows.get(finding.file) ?? [];
    group.push(finding);
    rows.set(finding.file, group);
  }
  const rank = (findings: MapSnapshot["findings"]) =>
    Math.min(...findings.map((finding) => severityOrder[finding.severity]));
  return (
    <section className="map-lens" aria-label="Review lens">
      <header>
        <h2>Review findings</h2>
        <p>
          {snapshot.findings.length} findings on {rows.size} files
        </p>
      </header>
      {[...rows.entries()]
        .sort(([, a], [, b]) => rank(a) - rank(b) || b.length - a.length)
        .map(([path, findings]) => (
          <div className="map-lens-section" key={path}>
            <FileButton path={path} onFocus={onFocus} />
            {[...findings]
              .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
              .map((finding, i) => (
                <p
                  // biome-ignore lint/suspicious/noArrayIndexKey: two findings can share seat, ticket, round and line
                  key={`${finding.seat}:${finding.ticket}:${finding.round}:${finding.line}:${i}`}
                >
                  <b className={`map-severity map-severity-${finding.severity.toLowerCase()}`}>
                    {finding.severity}
                  </b>{" "}
                  {finding.summary}
                  <br />
                  <span className="map-lens-note">
                    line {finding.line || "—"} · {names[finding.seat] ?? finding.seat} · #
                    {finding.ticket} round {finding.round}
                  </span>
                </p>
              ))}
          </div>
        ))}
      {rows.size === 0 && (
        <div className="map-lens-section">
          <p>No review findings in this map snapshot.</p>
        </div>
      )}
    </section>
  );
}

/** Files with a conflict: the hub sends one row per file and branch pair, so a file can have several. */
export const conflictFiles = (conflicts: MapSnapshot["conflicts"]) =>
  new Set(conflicts.map((conflict) => conflict.file)).size;
/** Distinct branch pairs across the conflicts (a pair counts once, however many files). */
export const conflictPairs = (conflicts: MapSnapshot["conflicts"]) =>
  new Set(conflicts.map((conflict) => [...conflict.branches].sort().join("\n"))).size;
/** "N files that conflict between open branches · P branch pairs", or what is known when some went unchecked. */
export function conflictSummary(snapshot: MapSnapshot): string {
  const files = conflictFiles(snapshot.conflicts);
  const unchecked = snapshot.conflictsUnchecked.length;
  if (files === 0)
    return unchecked
      ? `No conflicts among the branches checked · ${unchecked} unchecked`
      : "No merge conflicts found between open branches";
  const pairs = conflictPairs(snapshot.conflicts);
  return `${files} ${files === 1 ? "file conflicts" : "files that conflict"} between open branches · ${pairs} branch ${pairs === 1 ? "pair" : "pairs"}${unchecked ? ` · ${unchecked} unchecked` : ""}`;
}

export function ConflictsLens({
  snapshot,
  names = noNames,
  indices = noIndices,
  onFocus,
}: SeatProps & {
  snapshot: MapSnapshot;
  onFocus: (path: string) => void;
}) {
  const byFile = new Map<string, MapSnapshot["conflicts"]>();
  for (const conflict of snapshot.conflicts) {
    const rows = byFile.get(conflict.file) ?? [];
    rows.push(conflict);
    byFile.set(conflict.file, rows);
  }
  return (
    <section className="map-lens" aria-label="Conflicts lens">
      <header>
        <h2>Conflicts</h2>
        <p>{conflictSummary(snapshot)}</p>
      </header>
      {[...byFile].map(([file, pairs]) => {
        // the seats that changed this file
        const owners = snapshot.seats.filter((seat) =>
          seat.scope.modified.some((change) => change.file === file),
        );
        const seatOn = (branch: string) =>
          owners.find((seat) => seat.branches.includes(branch)) ??
          snapshot.seats.find((seat) => seat.branches.includes(branch));
        return (
          <div className="map-lens-section" key={file}>
            <FileButton path={file} onFocus={onFocus} />
            {pairs.map((pair) => (
              <div className="map-lens-pair" key={pair.branches.join(":")}>
                {pair.branches.map((branch) => {
                  const seat = seatOn(branch);
                  const ticket = seat?.tickets[branch];
                  return (
                    <p className="map-lens-branch" key={branch}>
                      {ticket !== undefined && <span className="map-lens-note">#{ticket}</span>}
                      <code>{branch}</code>
                      {seat && <SeatTag seat={seat.seat} names={names} indices={indices} />}
                    </p>
                  );
                })}
              </div>
            ))}
            {owners.length > 0 && (
              <p className="map-lens-note">
                {owners.map((seat) => names[seat.seat] ?? seat.seat).join(", ")} changed it here
              </p>
            )}
          </div>
        );
      })}
      {snapshot.conflictsUnchecked.length > 0 && (
        <div className="map-lens-section">
          <h3>Unchecked branches</h3>
          {snapshot.conflictsUnchecked.map((row) => (
            <p key={row.branch}>
              <code>{row.branch}</code> · {row.reason}
            </p>
          ))}
        </div>
      )}
      {byFile.size === 0 && (
        <div className="map-lens-section">
          <p>{conflictSummary(snapshot)}.</p>
        </div>
      )}
    </section>
  );
}

function HistoryRows({
  title,
  columns,
  rows,
  onFocus,
}: {
  title: string;
  columns?: string;
  rows: { path?: string; label?: string; text: string; focus?: string }[];
  onFocus: (path: string) => void;
}) {
  return (
    <div className="map-lens-section">
      <h3>{title}</h3>
      {columns && (
        <div className="map-lens-columns">
          <span>file</span>
          <span>{columns}</span>
        </div>
      )}
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
