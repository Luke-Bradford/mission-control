import { type MapSnapshot, seatCallSign } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type ActivityProps, activityLayer } from "./activity.ts";
import { dockPosition } from "./agents.ts";
import { declutter, type LabelBox, labelKind } from "./labels.ts";
import { areaColor } from "./layout.ts";
import { BRIGHTNESS, fileStyle, type MapNode, pinToken } from "./model.ts";
import { emptyMotion, type MotionState, markerPosition } from "./motion.ts";

/** The stage's own palette: it stays the deep void in both themes (the prototype's look). */
const LINK = "#1c2741";
const SIGNAL = "#9fe8ff";

type Props = ActivityProps & {
  nodes: MapNode[];
  /** The main areas, biggest first (layout.ts): their colours tint untouched files and branches. */
  areas?: string[];
  snapshot: MapSnapshot;
  focus: string | null;
  home: number;
  rotate: boolean;
  /** Every seat on the repo, on stage or folded, for the dock's size; the stage's count if absent. */
  dockSeats?: number;
  /** Bumped to frame the whole tree; `home` frames the active work (the tree when there is none). */
  overview?: number;
  selected: string | null;
  indices: Record<string, number>;
  onSelect: (path: string) => void;
  agentFocus?: { seat: string; request: number } | null;
};

interface Stage {
  rebuild: (nodes: MapNode[], seatCount: number, areas: string[]) => void;
  update: (props: Props) => void;
  dispose: () => void;
}

/**
 * Geometry, picking and camera only; map meaning comes from the pure models. The renderer, camera
 * and controls live as long as the component (one WebGL context per visit, released on unmount);
 * only the tree's meshes and lines are rebuilt when its nodes change.
 */
export function MapScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<Stage | null>(null);
  const motion = useRef(emptyMotion());
  const [unavailable, setUnavailable] = useState(false);
  const { nodes } = props;
  const areasKey = (props.areas ?? []).join("\n");
  // the dock is sized for every seat, so a seat joining or leaving the stage rebuilds nothing
  const seatCount = props.dockSeats ?? props.snapshot.seats.length;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = mountStage(el, motion, () => setUnavailable(true));
    shell.current = stage;
    return () => {
      stage?.dispose();
      shell.current = null;
    };
  }, []);
  useEffect(() => {
    shell.current?.rebuild(nodes, seatCount, areasKey ? areasKey.split("\n") : []);
  }, [nodes, seatCount, areasKey]);
  useEffect(() => {
    shell.current?.update(props);
  }, [props]);
  return (
    <div className="map-stage" ref={host}>
      {unavailable && (
        <p role="status">3D map unavailable. Use file search to inspect this repo.</p>
      )}
    </div>
  );
}

function mountStage(
  el: HTMLDivElement,
  motion: { current: MotionState },
  unavailable: () => void,
): Stage | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    unavailable();
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvas = renderer.domElement;
  // focusable and driven by keys (OrbitControls pans on the arrows), so an application, not an image
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    "Repo map: drag to orbit, scroll to zoom, arrow keys to pan; find a file in Selected",
  );
  canvas.tabIndex = 0;
  el.append(canvas);
  const labels = document.createElement("div");
  labels.className = "map-labels";
  el.append(labels);
  const activityLabels = document.createElement("div");
  activityLabels.className = "map-labels";
  el.append(activityLabels);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.autoRotateSpeed = 0.5;
  controls.listenToKeyEvents(canvas);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  // theme tokens, read once per scene update rather than once per node
  const tokens = new Map<string, string>();
  const css = (token: string) => {
    let value = tokens.get(token);
    if (value === undefined) {
      value =
        getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "#808999";
      tokens.set(token, value);
    }
    return value;
  };
  const signal = new THREE.Color(SIGNAL);
  const white = new THREE.Color("white");
  const homeDirection = new THREE.Vector3(0.42, 0.2, 0.89).normalize();

  /** The tree's own objects: rebuilt when its nodes change, never the renderer. */
  type Graph = ReturnType<typeof buildGraph>;
  let g: Graph | null = null;
  const buildGraph = (nodes: MapNode[], seatCount: number, areas: string[]) => {
    const spheres = nodes.filter((n) => n.count > 0);
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial(),
      spheres.length,
    );
    const positions = new Map(nodes.map((n) => [n.path, new THREE.Vector3(...n.position)]));
    const linked = nodes.filter((n) => n.parent !== null);
    const edges = linked.flatMap((n) => [
      ...(positions.get(n.parent as string) ?? new THREE.Vector3()).toArray(),
      ...n.position,
    ]);
    // the backbone: each branch in its area's colour, a file's twig dimmer than a folder's limb
    const edgeColors = linked.flatMap((n) => {
      const c = new THREE.Color(areaColor(n.area, areas)).multiplyScalar(n.count ? 0.7 : 1);
      return [c.r, c.g, c.b, c.r, c.g, c.b];
    });
    const branches = new THREE.LineSegments(
      new THREE.BufferGeometry()
        .setAttribute("position", new THREE.Float32BufferAttribute(edges, 3))
        .setAttribute("color", new THREE.Float32BufferAttribute(edgeColors, 3)),
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    const imports = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: LINK,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    const highlighted = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.9 }),
    );
    scene.add(mesh, branches, imports, highlighted);
    // each main area's name at the middle of its files, in its colour
    const areaCentres = areas.flatMap((name) => {
      const files = nodes.filter((n) => n.count > 0 && n.area === name);
      if (!files.length) return [];
      const position = new THREE.Vector3();
      for (const f of files) position.add(new THREE.Vector3(...f.position));
      return [
        { name, color: areaColor(name, areas), position: position.divideScalar(files.length) },
      ];
    });
    const box = new THREE.Box3().setFromPoints([
      ...positions.values(),
      new THREE.Vector3(...dockPosition(nodes, 0)),
      new THREE.Vector3(...dockPosition(nodes, Math.max(0, seatCount - 1))),
      ...["HUB", "CAPCOM"].map((id) => new THREE.Vector3(...markerPosition(id, nodes))),
    ]);
    const filePositions = new Map(
      spheres.flatMap((n) => n.files.map((f) => [f, new THREE.Vector3(...n.position)] as const)),
    );
    return {
      nodes,
      spheres,
      mesh,
      branches,
      imports,
      highlighted,
      positions,
      filePositions,
      areas,
      areaCentres,
      centre: box.getCenter(new THREE.Vector3()),
      extent: box.getSize(new THREE.Vector3()),
      activity: activityLayer(scene, activityLabels, nodes, motion, css),
      importsFor: null as MapSnapshot["imports"] | null,
      dispose: () => {
        scene.remove(mesh, branches, imports, highlighted);
        mesh.dispose();
        mesh.geometry.dispose();
        mesh.material.dispose();
        for (const line of [branches, imports, highlighted]) {
          line.geometry.dispose();
          line.material.dispose();
        }
      },
    };
  };

  let atHome = true;
  /** What the home view frames: the active work (the default), or the whole tree. */
  let framing: "work" | "tree" = "work";
  /**
   * The active work's box: the files the stage's agents changed or have in flight, and their orbs;
   * at least 40 units a side so one file isn't framed edge to edge. null when nobody is working.
   */
  const workBox = (): THREE.Box3 | null => {
    if (!g || !current) return null;
    const points: THREE.Vector3[] = [];
    for (const seat of current.snapshot.seats) {
      const before = points.length;
      for (const file of [
        ...seat.scope.modified.map((c) => c.file),
        ...seat.calls.flatMap((c) => c.files),
      ]) {
        const p = g.filePositions.get(file);
        if (p) points.push(p);
      }
      const orb = g.activity.focus(seat.seat);
      // an orb counts only when its own seat has work on the tree, never one parked in the dock
      if (orb && points.length > before) points.push(new THREE.Vector3(...orb));
    }
    if (!points.length) return null;
    const box = new THREE.Box3().setFromPoints(points);
    const size = box.getSize(new THREE.Vector3());
    return box.expandByVector(
      new THREE.Vector3(
        Math.max(0, 40 - size.x) / 2,
        Math.max(0, 40 - size.y) / 2,
        Math.max(0, 40 - size.z) / 2,
      ),
    );
  };
  // from a little right of and above the middle, the box filling the stage
  const reset = () => {
    if (!g) return;
    const work = framing === "work" ? workBox() : null;
    const centre = work ? work.getCenter(new THREE.Vector3()) : g.centre;
    const extent = work ? work.getSize(new THREE.Vector3()) : g.extent;
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distance =
      Math.max(30, extent.y / 2 / half, extent.x / 2 / (half * Math.max(0.5, camera.aspect))) *
        (work ? 1.15 : 0.96) +
      extent.z / 2;
    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(homeDirection, distance);
    controls.update();
    atHome = true;
  };
  // a file or an agent the operator asked for, framed from the current viewing direction
  const frame3d = (target: THREE.Vector3, share: number) => {
    if (!g) return;
    const back = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(target);
    camera.position
      .copy(target)
      .addScaledVector(back, Math.max(45, Math.max(g.extent.x, g.extent.y) * share));
    controls.update();
    atHome = false;
  };
  controls.addEventListener("start", () => {
    atHome = false;
  });

  let current: Props | null = null;
  let previousHome = -1;
  let previousOverview: number | undefined;
  let overviewSeen = false; // the first update records the counter; later bumps frame the tree
  let workKey = "";
  let previousFocus: string | null = null;
  let previousAgentFocus: Props["agentFocus"];
  let frame: ReturnType<typeof setTimeout> | undefined;
  let lastDraw = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let lastMotion = Date.now();
  const previousChanges = new Map<string, { add: number; rem: number; level: number }>();
  let projected: { el: HTMLElement; position: THREE.Vector3 }[] = [];
  const flashes = new Map<string, number>();
  const frameMatrix = new THREE.Matrix4();
  const frameColor = new THREE.Color();
  const projectedPosition = new THREE.Vector3();
  const glows = new Map<string, number>();
  const visuals: {
    color: THREE.Color;
    size: number;
    path: string;
    position: THREE.Vector3;
    glow: number;
    burst: number;
  }[] = [];
  // A focused overlay button (an arc, an orb label) that hides or leaves hands focus to the stage.
  // `held` is the overlay that has focus; focus moving outside the stage forgets it, so the stage
  // never takes focus back from wherever the operator went.
  let held: HTMLElement | null = null;
  const vanished = (target: HTMLElement) => target.hidden || !target.isConnected;
  const focusIn = (e: FocusEvent) => {
    held = e.target instanceof HTMLElement && e.target !== canvas ? e.target : null;
  };
  const focusOut = (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (next instanceof Node && el.contains(next)) return;
    const target = e.target;
    held = null;
    // a button that blurs because it just hid: the stage takes focus, not the page
    if (next === null && target instanceof HTMLElement && target !== canvas && vanished(target))
      queueMicrotask(() => {
        if (document.activeElement === document.body || document.activeElement === null)
          canvas.focus({ preventScroll: true });
      });
  };
  el.addEventListener("focusin", focusIn);
  el.addEventListener("focusout", focusOut);
  // a removed element may leave without a blur: catch it on the next frame
  const keepFocus = () => {
    if (!held || !vanished(held)) return;
    const active = document.activeElement;
    if (active === held || active === document.body || active === null)
      canvas.focus({ preventScroll: true });
    held = null;
  };

  const draw = () => {
    frame = undefined;
    if (document.hidden || !g) return;
    const { activity, mesh } = g;
    lastDraw = performance.now();
    if (current?.rotate && !reduced.matches) controls.update();
    const now = Date.now();
    const moving = activity.draw(
      now,
      Math.min(0.1, (now - lastMotion) / 1000),
      camera,
      el.clientWidth,
      el.clientHeight,
    );
    lastMotion = now;
    glows.clear();
    for (const glow of activity.glows(now)) glows.set(glow.path, glow.at);
    let flashing = false;
    let changed = false;
    visuals.forEach((visual, i) => {
      const glow = glows.get(visual.path);
      const strength = glow === undefined ? 0 : Math.max(0, 1 - (now - glow) / 6000);
      const flash = flashes.get(visual.path);
      const burst =
        !reduced.matches && flash !== undefined ? Math.max(0, 1 - (now - flash) / 1200) : 0;
      if (burst) flashing = true;
      else flashes.delete(visual.path);
      if (strength === visual.glow && burst === visual.burst) return;
      visual.glow = strength;
      visual.burst = burst;
      changed = true;
      mesh.setColorAt(
        i,
        frameColor.copy(visual.color).lerp(white, Math.max(strength * 0.5, burst)),
      );
      const size = visual.size * (1 + strength * 0.3 + burst * 0.4);
      mesh.setMatrixAt(i, frameMatrix.makeScale(size, size, size).setPosition(visual.position));
    });
    if (changed) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    renderer.render(scene, camera);
    const w = el.clientWidth,
      h = el.clientHeight;
    for (const label of projected) {
      const p = projectedPosition.copy(label.position).project(camera);
      label.el.style.left = `${((p.x + 1) * w) / 2}px`;
      label.el.style.top = `${((1 - p.y) * h) / 2}px`;
      label.el.hidden = p.z > 1 || p.z < -1;
    }
    unclutter(w, h);
    keepFocus();
    if ((current?.rotate && !reduced.matches) || moving || flashing) schedule();
  };
  // labels never overlap: measured once per text, then placed, lifted or hidden each frame
  const sizes = new WeakMap<HTMLElement, { text: string; w: number; h: number }>();
  const unclutter = (w: number, h: number) => {
    const shown: { el: HTMLElement; box: LabelBox }[] = [];
    for (const container of [labels, activityLabels])
      for (const child of container.children) {
        const label = child as HTMLElement;
        const kind = label.hidden ? null : labelKind(label.className);
        if (!kind) continue;
        let size = sizes.get(label);
        if (!size || size.text !== label.textContent) {
          size = { text: label.textContent ?? "", w: label.offsetWidth, h: label.offsetHeight };
          if (size.w > 0) sizes.set(label, size);
        }
        const x = Number.parseFloat(label.style.left);
        const y = Number.parseFloat(label.style.top);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        shown.push({ el: label, box: { x, y, w: size.w, h: size.h, ...kind } });
      }
    const placed = declutter(
      shown.map((s) => s.box),
      w,
      h,
    );
    shown.forEach(({ el: label }, i) => {
      const place = placed[i];
      if (!place) return;
      label.hidden = place.hidden;
      label.style.left = `${place.x}px`;
      label.style.top = `${place.y}px`;
      label.classList.toggle("lifted", place.lift > 0);
      label.style.setProperty("--lift", `${place.lift}px`);
    });
  };
  const schedule = () => {
    if (frame === undefined && !document.hidden)
      frame = setTimeout(draw, Math.max(0, Math.ceil(1000 / 30 - (performance.now() - lastDraw))));
  };

  const update = (next: Props) => {
    current = next;
    if (!g) return;
    const { activity, mesh, spheres, positions, filePositions, areas } = g;
    tokens.clear();
    activity.update(next, reduced.matches);
    controls.autoRotate = next.rotate && !reduced.matches;
    if (next.home !== previousHome) {
      framing = "work";
      if (previousHome !== -1) reset();
      previousHome = next.home;
    }
    if (next.overview !== previousOverview) {
      if (overviewSeen) {
        framing = "tree";
        reset();
      }
      previousOverview = next.overview;
    }
    overviewSeen = true;
    // until the operator moves the camera, the home view follows the changed files: a new file in
    // the working set reframes it, a tool call doesn't
    if (next.rotate) atHome = false;
    const work = next.snapshot.seats
      .flatMap((seat) => seat.scope.modified.map((c) => c.file))
      .sort()
      .join("\n");
    if (work !== workKey) {
      workKey = work;
      if (atHome && framing === "work") reset();
    }
    if (next.focus !== previousFocus) {
      const p = next.focus ? positions.get(next.focus) : undefined;
      if (p) frame3d(p, 0.38);
      previousFocus = next.focus;
    }
    if (next.agentFocus !== previousAgentFocus) {
      const p = next.agentFocus ? activity.focus(next.agentFocus.seat) : undefined;
      if (p) frame3d(new THREE.Vector3(...p), 0.42);
      previousAgentFocus = next.agentFocus;
    }
    clearTimeout(expiry);
    const now = Date.now();
    const deadlines = [
      ...activity.nextExpiry(now),
      ...next.snapshot.seats.flatMap((s) => [
        ...(s.state !== "running" && !s.calls.length ? [s.since + 60_000] : []),
        ...s.recent.map((r) => r.at + 600_000),
      ]),
    ].filter((t) => t > now);
    if (deadlines.length)
      expiry = setTimeout(
        () => {
          if (current) update(current);
        },
        Math.min(...deadlines) - now + 1,
      );
    labels.replaceChildren();
    projected = [];
    const addLabel = (
      text: string,
      position: THREE.Vector3,
      className: string,
      token?: string,
      title?: string,
    ) => {
      const label = document.createElement("span");
      label.className = className;
      label.textContent = text;
      if (token) label.style.color = css(token);
      if (title) label.title = title;
      labels.append(label);
      projected.push({ el: label, position });
      return label;
    };
    // the selected agent's files, once per update rather than per node
    const seat = next.agent ? next.snapshot.seats.find((s) => s.seat === next.agent) : undefined;
    const agentFiles = next.agent
      ? new Set([
          ...(seat?.scope.read ?? []),
          ...(seat?.scope.modified.map((c) => c.file) ?? []),
          ...(seat?.calls.flatMap((c) => c.files) ?? []),
        ])
      : null;
    // a mark is a glyph with its words as a tooltip; a click selects its file for the drawer
    const addMark = (
      glyph: string,
      position: THREE.Vector3,
      token: string,
      title: string,
      path: string,
    ) => {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "map-mark";
      mark.tabIndex = -1;
      mark.textContent = glyph;
      mark.style.color = css(token);
      mark.title = title;
      mark.setAttribute("aria-label", title);
      mark.addEventListener("click", () => current?.onSelect(path));
      labels.append(mark);
      projected.push({ el: mark, position });
    };
    const matrix = new THREE.Matrix4();
    visuals.length = 0;
    spheres.forEach((node, i) => {
      const s = fileStyle(next.snapshot, node.files, node.area, now, next.indices);
      const untouched = s.brightness === BRIGHTNESS.untouched;
      const written = s.brightness === BRIGHTNESS.written || s.brightness === BRIGHTNESS.docked;
      // the prototype's steps, a size smaller: untouched files fine points, in scope a little
      // larger, modified grown by level, so no file reads as a blob
      const size =
        (node.count > 1 ? 1 + Math.log2(node.count) * 0.3 : 1) *
        (untouched ? 0.6 : written ? 1 + s.level * 0.35 : 0.8);
      matrix.makeScale(size, size, size).setPosition(...node.position);
      mesh.setMatrixAt(i, matrix);
      const color = untouched
        ? new THREE.Color(areaColor(node.area, areas)).multiplyScalar(0.7)
        : new THREE.Color(css(s.token)).multiplyScalar(
            s.brightness === BRIGHTNESS.written
              ? 1.15
              : s.brightness === BRIGHTNESS.docked
                ? 0.75
                : 0.72,
          );
      if (agentFiles && !node.files.some((f) => agentFiles.has(f))) color.multiplyScalar(0.25);
      if (node.path === next.selected) color.lerp(signal, 0.65);
      mesh.setColorAt(i, color);
      const p = new THREE.Vector3(...node.position);
      visuals.push({ color, size, path: node.path, position: p, glow: 0, burst: 0 });
      if (node.path === next.selected)
        addLabel("○", p, "map-ring map-picked", undefined, "selected");
      if (s.accessing || s.recent)
        addLabel(
          "○",
          p,
          `map-ring${s.recent && !s.accessing ? " faint" : ""}`,
          undefined,
          s.accessing ? "being accessed now" : "recently accessed",
        );
      if (s.overlap)
        addLabel(
          s.overlap === "write overlap" ? "◎" : "◌",
          p,
          `map-ring overlap${s.overlap === "shared" ? " shared" : ""}`,
          "--fg",
          s.overlap,
        );
      const previous = previousChanges.get(node.path);
      const edited =
        !document.hidden && previous && (s.add !== previous.add || s.rem !== previous.rem);
      const grew = edited && s.level > previous.level;
      if (grew) flashes.set(node.path, now);
      previousChanges.set(node.path, { add: s.add, rem: s.rem, level: s.level });
      // a file's +/− shows on the stage only while it is selected; the rail and tooltip carry it
      if (s.label && node.path === next.selected) {
        const change = addLabel(
          grew ? "▲ " : "",
          p.clone().add(new THREE.Vector3(0, size + 2, 0)),
          `map-change${edited ? " map-edited" : ""}${grew ? " map-level" : ""}`,
          undefined,
          s.source,
        );
        change.style.borderColor = css(s.token);
        for (const [cls, text] of [
          ["add", `+${s.add}`],
          ["rem", `−${s.rem}`],
        ] as const) {
          const part = document.createElement("b");
          part.className = cls;
          part.textContent = text;
          change.append(part);
        }
      }
      // findings and conflicts are small marks: their words are in the tooltip and the drawer
      if (s.findings.length) {
        const worst = (["Critical", "Important", "Minor"] as const).find((severity) =>
          s.findings.some((f) => f.severity === severity),
        );
        addMark(
          "▲",
          p.clone().add(new THREE.Vector3(0, size + 2.5, 0)),
          worst ? pinToken(worst) : "--muted",
          `${s.findings.length} review finding${s.findings.length === 1 ? "" : "s"} on ${node.path}:\n${s.findings.map((f) => `${f.severity} · line ${f.line} · ${f.summary}`).join("\n")}`,
          node.path,
        );
      }
      if (s.conflicts.length)
        addMark(
          "◆",
          p.clone().add(new THREE.Vector3(0, -size - 2.5, 0)),
          "--crit",
          `Merge conflict on ${node.path} between:\n${s.conflicts.map((c) => c.branches.join(" / ")).join("\n")}`,
          node.path,
        );
    });
    for (const area of g.areaCentres) {
      const label = addLabel(area.name, area.position, "map-area");
      label.style.color = area.color;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const lineOf = (pairs: MapSnapshot["imports"]) =>
      pairs.flatMap((link) => {
        const a = filePositions.get(link.from),
          b = filePositions.get(link.to);
        return a && b ? [...a.toArray(), ...b.toArray()] : [];
      });
    // import links change only with the tree's imports, not with every update
    if (g.importsFor !== next.snapshot.imports) {
      g.importsFor = next.snapshot.imports;
      g.imports.geometry.dispose();
      g.imports.geometry = new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(lineOf(next.snapshot.imports), 3),
      );
    }
    const selectedFiles = new Set(spheres.find((n) => n.path === next.selected)?.files ?? []);
    g.highlighted.geometry.dispose();
    g.highlighted.geometry = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        lineOf(
          next.snapshot.imports.filter((i) => selectedFiles.has(i.from) || selectedFiles.has(i.to)),
        ),
        3,
      ),
    );
    schedule();
  };

  const rebuild = (nodes: MapNode[], seatCount: number, areas: string[]) => {
    if (g) {
      g.activity.dispose();
      g.dispose();
    }
    g = buildGraph(nodes, seatCount, areas);
    visuals.length = 0;
    if (atHome) reset(); // the home view refits the new tree until the operator moves the camera
    if (current) update(current);
    else schedule();
  };

  const resize = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
    camera.updateProjectionMatrix();
    if (atHome) reset();
    schedule();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(el);
  controls.addEventListener("change", schedule);
  // panning with the arrow keys is the operator moving the camera, as a drag is
  const keyMove = (e: KeyboardEvent) => {
    if (e.key.startsWith("Arrow")) atHome = false;
  };
  canvas.addEventListener("keydown", keyMove);
  let down = [0, 0];
  const pointerDown = (e: PointerEvent) => {
    down = [e.clientX, e.clientY];
  };
  const pick = (e: PointerEvent) => {
    if (!g || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const rect = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = ray.intersectObject(g.mesh)[0];
    const agent = g.activity.pick(ray);
    if (agent) current?.onAgentSelect?.(current.agent === agent ? null : agent);
    else if (hit?.instanceId !== undefined) {
      const node = g.spheres[hit.instanceId];
      if (node) current?.onSelect(node.path);
    }
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pick);
  // hovering a file says what it is and who changed it; nothing is written on the stage for it
  const tip = document.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  el.append(tip);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const hover = (e: PointerEvent) => {
    clearTimeout(hoverTimer);
    if (e.buttons) {
      tip.hidden = true;
      return;
    }
    const { clientX, clientY } = e;
    hoverTimer = setTimeout(() => {
      if (!g || !current) return;
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          (-(clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.intersectObject(g.mesh)[0];
      const node = hit?.instanceId === undefined ? undefined : g.spheres[hit.instanceId];
      if (!node) {
        tip.hidden = true;
        return;
      }
      tip.textContent = fileTip(node, current);
      tip.hidden = false;
      const x = clientX - rect.left + 14;
      tip.style.left = `${Math.min(x, rect.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.min(clientY - rect.top + 14, rect.height - tip.offsetHeight - 8)}px`;
    }, 40);
  };
  const leave = () => {
    clearTimeout(hoverTimer);
    tip.hidden = true;
  };
  // the file under a tooltip moves with the camera
  controls.addEventListener("change", leave);
  canvas.addEventListener("pointermove", hover);
  canvas.addEventListener("pointerleave", leave);
  const visibility = () => {
    if (document.hidden) {
      clearTimeout(frame);
      frame = undefined;
      clearTimeout(expiry);
      g?.activity.clear();
      flashes.clear();
    } else if (current) {
      g?.activity.clear();
      lastMotion = Date.now();
      update(current);
    }
  };
  document.addEventListener("visibilitychange", visibility);
  const theme = new MutationObserver(() => {
    if (current) update(current);
  });
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const preference = () => {
    if (current) update(current);
  };
  reduced.addEventListener("change", preference);
  themeMedia.addEventListener("change", preference);
  resize();
  return {
    rebuild,
    update,
    dispose: () => {
      clearTimeout(frame);
      clearTimeout(expiry);
      observer.disconnect();
      theme.disconnect();
      controls.dispose();
      if (g) {
        g.activity.dispose();
        g.dispose();
        g = null;
      }
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", preference);
      themeMedia.removeEventListener("change", preference);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pick);
      canvas.removeEventListener("pointermove", hover);
      canvas.removeEventListener("keydown", keyMove);
      canvas.removeEventListener("pointerleave", leave);
      clearTimeout(hoverTimer);
      tip.remove();
      // release the WebGL context now, not when the browser collects the canvas: twenty visits
      // must not reach Chrome's limit of sixteen live contexts
      renderer.forceContextLoss();
      renderer.dispose();
      canvas.remove();
      labels.remove();
      activityLabels.remove();
    },
  };
}

/** A file's tooltip: its path, then each working agent's change or read, its findings and conflicts. */
export function fileTip(node: MapNode, props: Pick<Props, "snapshot" | "names">): string {
  const { snapshot } = props;
  const has = (f: string) => node.files.includes(f);
  const name = (seat: string) => props.names?.[seat] ?? seatCallSign(seat);
  const lines = [node.files.length > 1 ? `${node.path} · ${node.files.length} files` : node.path];
  for (const seat of snapshot.seats) {
    const changes = seat.scope.modified.filter((c) => has(c.file));
    if (changes.length) {
      const add = changes.reduce((n, c) => n + c.add, 0);
      const rem = changes.reduce((n, c) => n + c.rem, 0);
      const churn = changes.some((c) => c.source === "churn");
      lines.push(`${name(seat.seat)} +${add} −${rem}${churn ? " (edit churn)" : ""}`);
    } else if (seat.scope.read.some(has)) lines.push(`${name(seat.seat)} read it`);
    if (seat.calls.some((c) => c.files.some(has))) lines.push(`${name(seat.seat)} is on it now`);
  }
  const findings = snapshot.findings.filter((f) => has(f.file));
  if (findings.length)
    lines.push(`▲ ${findings.length} review finding${findings.length === 1 ? "" : "s"}`);
  for (const c of snapshot.conflicts.filter((c) => has(c.file)))
    lines.push(`◆ conflict: ${c.branches.join(" / ")}`);
  if (lines.length === 1) lines.push("untouched");
  return lines.join("\n");
}
