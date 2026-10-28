import { seatCallSign } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { dockPosition } from "./agents.ts";
import { nodeWork } from "./cards.ts";
import { declutter, type LabelBox, labelKind } from "./labels.ts";
import { type LightProps, lightLayer } from "./lights.ts";
import type { MapNode } from "./model.ts";

/**
 * The stage's own palette: it stays the flat void in both themes. Files are plain nodes in one
 * muted tone, the tree's branches a hairline, so the seats' colours are the only colour on it.
 */
const NODE = "#354059";
const BRANCH = "#18213a";
const SIGNAL = "#9fe8ff";

type Props = LightProps & {
  nodes: MapNode[];
  /** The main areas, biggest first (layout.ts): their names label the stage. */
  areas?: string[];
  focus: string | null;
  home: number;
  rotate: boolean;
  /** Every seat on the repo, on stage or not, for the dock's size; the stage's count if absent. */
  dockSeats?: number;
  /** Bumped to frame the whole tree; `home` frames the active work (the tree when there is none). */
  overview?: number;
  selected: string | null;
  onSelect: (path: string) => void;
  /** A request to frame a seat's light; the camera then follows `seat` as its light moves. */
  seatFocus?: { seat: string; request: number } | null;
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
  const [unavailable, setUnavailable] = useState(false);
  const { nodes } = props;
  const areasKey = (props.areas ?? []).join("\n");
  // the dock is sized for every seat, so a seat joining or leaving the stage rebuilds nothing
  const seatCount = props.dockSeats ?? props.snapshot.seats.length;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = mountStage(el, () => setUnavailable(true));
    shell.current = stage;
    return () => {
      stage?.dispose();
      shell.current = null;
    };
  }, []);
  useEffect(() => {
    shell.current?.rebuild(nodes, seatCount, areasKey ? areasKey.split("\n") : []);
  }, [nodes, seatCount, areasKey]);
  // keyed on each prop, not the props object, so a parent's re-render that changed nothing (the
  // clock's tick) doesn't rebuild the paths and labels
  const {
    snapshot,
    names,
    indices,
    seat,
    onSeatSelect,
    areas,
    focus,
    home,
    rotate,
    dockSeats,
    overview,
    selected,
    onSelect,
    seatFocus,
  } = props;
  useEffect(() => {
    shell.current?.update({
      nodes,
      snapshot,
      names,
      indices,
      seat,
      onSeatSelect,
      areas,
      focus,
      home,
      rotate,
      dockSeats,
      overview,
      selected,
      onSelect,
      seatFocus,
    });
  }, [
    nodes,
    snapshot,
    names,
    indices,
    seat,
    onSeatSelect,
    areas,
    focus,
    home,
    rotate,
    dockSeats,
    overview,
    selected,
    onSelect,
    seatFocus,
  ]);
  return (
    <div className="map-stage" ref={host}>
      {unavailable && (
        <p role="status">3D map unavailable. Use file search to inspect this repo.</p>
      )}
    </div>
  );
}

function mountStage(el: HTMLDivElement, unavailable: () => void): Stage | null {
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
  const seatLabels = document.createElement("div");
  seatLabels.className = "map-labels";
  el.append(seatLabels);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.autoRotateSpeed = 0.5;
  controls.listenToKeyEvents(canvas);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  // theme tokens, read once per scene update rather than once per seat
  const tokens = new Map<string, string>();
  const css = (token: string) => {
    let value = tokens.get(token);
    if (value === undefined) {
      value =
        // the stage's own tokens (the seats' palette) are defined on the map page, not the root
        getComputedStyle(el).getPropertyValue(token).trim() || "#808999";
      tokens.set(token, value);
    }
    return value;
  };
  const homeDirection = new THREE.Vector3(0.42, 0.2, 0.89).normalize();

  /** The tree's own objects: rebuilt when its nodes change, never the renderer. */
  type Graph = ReturnType<typeof buildGraph>;
  let g: Graph | null = null;
  const buildGraph = (nodes: MapNode[], seatCount: number, areas: string[]) => {
    const spheres = nodes.filter((n) => n.count > 0);
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial(),
      spheres.length,
    );
    const positions = new Map(nodes.map((n) => [n.path, new THREE.Vector3(...n.position)]));
    const linked = nodes.filter((n) => n.parent !== null);
    const edges = linked.flatMap((n) => [
      ...(positions.get(n.parent as string) ?? new THREE.Vector3()).toArray(),
      ...n.position,
    ]);
    const branches = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(edges, 3),
      ),
      new THREE.LineBasicMaterial({ color: BRANCH, depthWrite: false }),
    );
    scene.add(mesh, branches);
    // each main area's name at the middle of its files
    const areaCentres = areas.flatMap((name) => {
      const files = nodes.filter((n) => n.count > 0 && n.area === name);
      if (!files.length) return [];
      const position = new THREE.Vector3();
      for (const f of files) position.add(new THREE.Vector3(...f.position));
      return [{ name, position: position.divideScalar(files.length) }];
    });
    const box = new THREE.Box3().setFromPoints([
      ...positions.values(),
      new THREE.Vector3(...dockPosition(nodes, 0)),
      new THREE.Vector3(...dockPosition(nodes, Math.max(0, seatCount - 1))),
    ]);
    const filePositions = new Map(
      spheres.flatMap((n) => n.files.map((f) => [f, new THREE.Vector3(...n.position)] as const)),
    );
    return {
      nodes,
      spheres,
      mesh,
      positions,
      filePositions,
      areaCentres,
      centre: box.getCenter(new THREE.Vector3()),
      extent: box.getSize(new THREE.Vector3()),
      lights: lightLayer(scene, seatLabels, nodes, css),
      dispose: () => {
        scene.remove(mesh, branches);
        mesh.dispose();
        mesh.geometry.dispose();
        mesh.material.dispose();
        branches.geometry.dispose();
        branches.material.dispose();
      },
    };
  };

  let atHome = true;
  /** What the home view frames: the active work (the default), or the whole tree. */
  let framing: "work" | "tree" = "work";
  /**
   * The active work's box: the files the stage's seats changed or have in flight, and their
   * lights; at least 40 units a side so one file isn't framed edge to edge. null when nobody works.
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
      const light = g.lights.goal(seat.seat);
      // a light counts only when its own seat has work on the tree, never one in the dock
      if (light && points.length > before) points.push(new THREE.Vector3(...light));
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
  // a file or a seat the operator asked for, framed from the current viewing direction
  const frame3d = (target: THREE.Vector3, share: number) => {
    if (!g) return;
    const back = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(target);
    camera.position
      .copy(target)
      .addScaledVector(back, Math.max(110, Math.max(g.extent.x, g.extent.y) * share));
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
  let previousSeatFocus: Props["seatFocus"];
  /** The followed light's position at the last frame: the camera moves with it from there. */
  let followed: { seat: string; at: THREE.Vector3 } | null = null;
  let frame: ReturnType<typeof setTimeout> | undefined;
  let lastDraw = 0;
  let lastMotion = Date.now();
  let projected: { el: HTMLElement; position: THREE.Vector3 }[] = [];
  const projectedPosition = new THREE.Vector3();
  const step = new THREE.Vector3();
  // A focused overlay button (a seat's label) that hides or leaves hands focus to the stage.
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

  /** The camera moves with the followed seat's light, keeping the operator's own angle and zoom. */
  const follow = () => {
    const seat = current?.seat ?? null;
    const at = seat ? g?.lights.position(seat) : undefined;
    if (!seat || !at) {
      followed = null;
      return;
    }
    if (followed?.seat === seat) {
      step.set(...at).sub(followed.at);
      if (step.lengthSq() > 0) {
        controls.target.add(step);
        camera.position.add(step);
      }
      followed.at.set(...at);
    } else followed = { seat, at: new THREE.Vector3(...at) };
  };

  const draw = () => {
    frame = undefined;
    if (document.hidden || !g) return;
    lastDraw = performance.now();
    if (current?.rotate && !reduced.matches) controls.update();
    const now = Date.now();
    const w = el.clientWidth,
      h = el.clientHeight;
    const moving = g.lights.draw(Math.min(0.1, (now - lastMotion) / 1000), camera, w, h);
    lastMotion = now;
    follow();
    renderer.render(scene, camera);
    for (const label of projected) {
      const p = projectedPosition.copy(label.position).project(camera);
      label.el.style.left = `${((p.x + 1) * w) / 2}px`;
      label.el.style.top = `${((1 - p.y) * h) / 2}px`;
      label.el.hidden = p.z > 1 || p.z < -1;
    }
    unclutter(w, h);
    keepFocus();
    if ((current?.rotate && !reduced.matches) || moving) schedule();
  };
  // labels never overlap: measured once per text, then placed, lifted or hidden each frame
  const sizes = new WeakMap<HTMLElement, { text: string; w: number; h: number }>();
  const unclutter = (w: number, h: number) => {
    const shown: { el: HTMLElement; box: LabelBox }[] = [];
    for (const container of [labels, seatLabels])
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
    const { lights, mesh, spheres, positions } = g;
    tokens.clear();
    lights.update(next, reduced.matches, Date.now());
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
    if (next.seatFocus !== previousSeatFocus) {
      const p = next.seatFocus ? lights.goal(next.seatFocus.seat) : undefined;
      if (p) {
        lights.settle(next.seatFocus?.seat);
        frame3d(new THREE.Vector3(...p), 0.42);
      }
      previousSeatFocus = next.seatFocus;
      followed = null;
    }
    labels.replaceChildren();
    projected = [];
    const addLabel = (text: string, position: THREE.Vector3, className: string) => {
      const label = document.createElement("span");
      label.className = className;
      label.textContent = text;
      label.hidden = true; // placed on the next frame
      labels.append(label);
      projected.push({ el: label, position });
      return label;
    };
    const matrix = new THREE.Matrix4();
    const plain = new THREE.Color(NODE);
    const picked = new THREE.Color(SIGNAL);
    spheres.forEach((node, i) => {
      const chosen = node.path === next.selected;
      // a collapsed folder is a little larger with more files, never a blob
      const size = (node.count > 1 ? 0.4 + Math.log2(node.count) * 0.14 : 0.4) * (chosen ? 1.8 : 1);
      matrix.makeScale(size, size, size).setPosition(...node.position);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, chosen ? picked : plain);
      // the selected node's +/− shows on the stage; the card says whose they are
      if (chosen) {
        const changed = nodeWork(next.snapshot, node.files).flatMap((w) => w.changed ?? []);
        if (changed.length) {
          const change = addLabel(
            "",
            new THREE.Vector3(...node.position).add(new THREE.Vector3(0, 5, 0)),
            "map-change",
          );
          for (const [cls, text] of [
            ["add", `+${changed.reduce((n, c) => n + c.add, 0)}`],
            ["rem", `−${changed.reduce((n, c) => n + c.rem, 0)}`],
          ] as const) {
            const part = document.createElement("b");
            part.className = cls;
            part.textContent = text;
            change.append(part);
          }
        }
      }
    });
    for (const area of g.areaCentres) addLabel(area.name, area.position, "map-area");
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    schedule();
  };

  const rebuild = (nodes: MapNode[], seatCount: number, areas: string[]) => {
    if (g) {
      g.lights.dispose();
      g.dispose();
    }
    g = buildGraph(nodes, seatCount, areas);
    followed = null;
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
  const rayAt = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    return ray;
  };
  const pick = (e: PointerEvent) => {
    if (!g || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const ray = rayAt(e.clientX, e.clientY);
    const seat = g.lights.pick(ray);
    const hit = ray.intersectObject(g.mesh)[0];
    if (seat) current?.onSeatSelect?.(current.seat === seat ? null : seat);
    else if (hit?.instanceId !== undefined) {
      const node = g.spheres[hit.instanceId];
      if (node) current?.onSelect(node.path);
    }
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pick);
  // hovering a file says what it is and who changed or read it
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
      const hit = rayAt(clientX, clientY).intersectObject(g.mesh)[0];
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
    } else if (current) {
      // back from a hidden tab: the lights are where their seats are now, without the journey
      g?.lights.settle();
      followed = null;
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
      observer.disconnect();
      theme.disconnect();
      controls.dispose();
      if (g) {
        g.lights.dispose();
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
      seatLabels.remove();
    },
  };
}

/** A file's tooltip: its path, then each seat that touched it: changed (+/−), read, or both. */
export function fileTip(node: MapNode, props: Pick<Props, "snapshot" | "names">): string {
  const name = (seat: string) => props.names?.[seat] ?? seatCallSign(seat);
  const lines = [
    node.files.length > 1 ? `${node.path} · ${node.files.length} files` : node.path,
    ...nodeWork(props.snapshot, node.files).map(({ seat, changed, read }) =>
      [
        name(seat),
        ...(changed
          ? [`changed +${changed.add} −${changed.rem}${changed.churn ? " (edit churn)" : ""}`]
          : []),
        ...(read ? ["read"] : []),
      ].join(" · "),
    ),
  ];
  if (lines.length === 1) lines.push("untouched");
  return lines.join("\n");
}
