import type { MapSnapshot } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type ActivityProps, activityLayer } from "./activity.ts";
import { dockPosition } from "./agents.ts";
import { areaTone, fileStyle, type MapNode, pinToken } from "./model.ts";
import { emptyMotion, markerPosition } from "./motion.ts";

type Props = ActivityProps & {
  nodes: MapNode[];
  snapshot: MapSnapshot;
  focus: string | null;
  home: number;
  rotate: boolean;
  selected: string | null;
  indices: Record<string, number>;
  onSelect: (path: string) => void;
  agentFocus?: { seat: string; request: number } | null;
};
type Shell = { update: (props: Props) => void; dispose: () => void };

/** Geometry, picking and camera only; map meaning comes from the pure models. */
export function MapScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<Shell | null>(null);
  const motion = useRef(emptyMotion());
  const view = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    home: number;
    focus: string | null;
    agentFocus: Props["agentFocus"];
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { nodes } = props;
  const seatCount = props.snapshot.seats.length;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.setAttribute("aria-label", "Repo map: drag to orbit, scroll to zoom");
    el.append(renderer.domElement);
    const labels = document.createElement("div");
    labels.className = "map-labels";
    el.append(labels);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.autoRotateSpeed = 0.5;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const spheres = nodes.filter((n) => n.count > 0);
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial(),
      spheres.length,
    );
    scene.add(mesh);
    const positions = new Map(nodes.map((n) => [n.path, new THREE.Vector3(...n.position)]));
    const edges = nodes.flatMap((n) =>
      n.parent !== null
        ? [...(positions.get(n.parent) ?? new THREE.Vector3()).toArray(), ...n.position]
        : [],
    );
    const branches = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(edges, 3),
      ),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.25 }),
    );
    scene.add(branches);
    const imports = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.15 }),
    );
    scene.add(imports);
    const highlighted = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 }),
    );
    scene.add(highlighted);
    const box = new THREE.Box3().setFromPoints([
      ...positions.values(),
      new THREE.Vector3(...dockPosition(nodes, seatCount)),
      ...["HUB", "CAPCOM"].map((id) => new THREE.Vector3(...markerPosition(id, nodes))),
    ]);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(30, box.getSize(new THREE.Vector3()).length() * 0.8);
    const reset = () => {
      controls.target.copy(centre);
      camera.position.copy(centre).add(new THREE.Vector3(radius * 0.5, radius * 0.4, radius));
      controls.update();
    };
    if (view.current) {
      camera.position.copy(view.current.position);
      controls.target.copy(view.current.target);
      controls.update();
    } else reset();
    let current: Props | null = null;
    let previousHome = view.current?.home ?? -1;
    let previousFocus: string | null = view.current?.focus ?? null;
    let frame: ReturnType<typeof setTimeout> | undefined;
    let lastDraw = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const previousChanges = new Map<string, { add: number; rem: number; level: number }>();
    let projected: { el: HTMLElement; position: THREE.Vector3 }[] = [];
    const css = (token: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "#808999";
    const activityLabels = document.createElement("div");
    activityLabels.className = "map-labels";
    el.append(activityLabels);
    const activity = activityLayer(scene, activityLabels, nodes, motion, css);
    let previousAgentFocus = view.current?.agentFocus;
    let lastMotion = Date.now();
    const flashes = new Map<string, number>();
    const frameMatrix = new THREE.Matrix4();
    const frameColor = new THREE.Color();
    const white = new THREE.Color("white");
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
    const draw = () => {
      frame = undefined;
      if (document.hidden) return;
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
      if ((current?.rotate && !reduced.matches) || moving || flashing) schedule();
    };
    const schedule = () => {
      if (frame === undefined && !document.hidden)
        frame = setTimeout(
          draw,
          Math.max(0, Math.ceil(1000 / 30 - (performance.now() - lastDraw))),
        );
    };
    const update = (next: Props) => {
      current = next;
      activity.update(next, reduced.matches);
      controls.autoRotate = next.rotate && !reduced.matches;
      if (next.home !== previousHome) {
        reset();
        previousHome = next.home;
      }
      if (next.focus !== previousFocus) {
        const p = next.focus ? positions.get(next.focus) : undefined;
        if (p) {
          controls.target.copy(p);
          camera.position.copy(p).add(new THREE.Vector3(20, 15, 35));
          controls.update();
        }
        previousFocus = next.focus;
      }
      if (next.agentFocus !== previousAgentFocus) {
        const p = next.agentFocus ? activity.focus(next.agentFocus.seat) : undefined;
        if (p) {
          controls.target.set(...p);
          camera.position.set(p[0] + 20, p[1] + 15, p[2] + 35);
          controls.update();
        }
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
      };
      const matrix = new THREE.Matrix4();
      visuals.length = 0;
      spheres.forEach((node, i) => {
        const s = fileStyle(next.snapshot, node.files, node.area, Date.now(), next.indices);
        const size = (node.count > 1 ? 1 + Math.log2(node.count) * 0.3 : 0.8) * (1 + s.level * 0.4);
        matrix.makeScale(size, size, size).setPosition(...node.position);
        mesh.setMatrixAt(i, matrix);
        const color = new THREE.Color(css(s.token));
        if (s.brightness === 0.3) {
          const hsl = color.getHSL({ h: 0, s: 0, l: 0 });
          color.setHSL(areaTone(node.area), 0.15, hsl.l);
        } else color.multiplyScalar(s.brightness);
        if (next.agent) {
          const seat = next.snapshot.seats.find((seat) => seat.seat === next.agent);
          const files = [
            ...(seat?.scope.read ?? []),
            ...(seat?.scope.modified.map((c) => c.file) ?? []),
            ...(seat?.calls.flatMap((c) => c.files) ?? []),
          ];
          if (!node.files.some((f) => files.includes(f))) color.multiplyScalar(0.25);
        }
        mesh.setColorAt(i, color);
        const p = new THREE.Vector3(...node.position);
        visuals.push({ color, size, path: node.path, position: p, glow: 0, burst: 0 });
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
        if (s.label)
          addLabel(
            `${grew ? "▲ " : ""}+${s.add} −${s.rem}`,
            p.clone().add(new THREE.Vector3(0, size + 2, 0)),
            `map-change${edited ? " map-edited" : ""}${grew ? " map-level" : ""}`,
            s.token,
            s.source,
          );
        for (const [j, finding] of s.findings.entries())
          addLabel(
            `▲ ${finding.severity}`,
            p.clone().add(new THREE.Vector3(0, size + 5 + j * 4, 0)),
            "map-pin",
            pinToken(finding.severity),
            finding.summary,
          );
        for (const c of s.conflicts)
          addLabel(
            `Conflict: ${c.branches.join(" / ")}`,
            p.clone().add(new THREE.Vector3(0, -5, 0)),
            "map-pin",
            "--crit",
          );
      });
      for (const node of nodes.filter((n) => n.path === n.area))
        addLabel(node.area, new THREE.Vector3(...node.position), "map-area", "--muted");
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const filePositions = new Map(
        spheres.flatMap((n) => n.files.map((f) => [f, new THREE.Vector3(...n.position)] as const)),
      );
      const links = next.snapshot.imports.flatMap((link) => {
        const a = filePositions.get(link.from),
          b = filePositions.get(link.to);
        return a && b ? [...a.toArray(), ...b.toArray()] : [];
      });
      imports.geometry.dispose();
      imports.geometry = new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(links, 3),
      );
      const selectedFiles = spheres.find((n) => n.path === next.selected)?.files ?? [];
      const selectedLinks = next.snapshot.imports
        .filter((i) => selectedFiles.includes(i.from) || selectedFiles.includes(i.to))
        .flatMap((i) => {
          const a = filePositions.get(i.from),
            b = filePositions.get(i.to);
          return a && b ? [...a.toArray(), ...b.toArray()] : [];
        });
      highlighted.geometry.dispose();
      highlighted.geometry = new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(selectedLinks, 3),
      );
      highlighted.material.color.set(css("--accent"));
      imports.material.color.set(css("--accent"));
      imports.material.opacity = 0.12;
      branches.material.color.set(css("--muted"));
      schedule();
    };
    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight, false);
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    controls.addEventListener("change", schedule);
    let down = [0, 0];
    const pointerDown = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
    };
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.intersectObject(mesh)[0];
      const agent = activity.pick(ray);
      if (agent) current?.onAgentSelect?.(current.agent === agent ? null : agent);
      else if (hit?.instanceId !== undefined) current?.onSelect(spheres[hit.instanceId].path);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pick);
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(frame);
        frame = undefined;
        clearTimeout(expiry);
        activity.clear();
        flashes.clear();
      } else if (current) {
        activity.clear();
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
    shell.current = {
      update,
      dispose: () => {
        view.current = {
          position: camera.position.clone(),
          target: controls.target.clone(),
          home: current?.home ?? 0,
          focus: current?.focus ?? null,
          agentFocus: current?.agentFocus,
        };
        clearTimeout(frame);
        clearTimeout(expiry);
        observer.disconnect();
        theme.disconnect();
        controls.dispose();
        activity.dispose();
        mesh.dispose();
        document.removeEventListener("visibilitychange", visibility);
        reduced.removeEventListener("change", preference);
        themeMedia.removeEventListener("change", preference);
        renderer.domElement.removeEventListener("pointerdown", pointerDown);
        renderer.domElement.removeEventListener("pointerup", pick);
        for (const object of [mesh, branches, imports, highlighted]) {
          object.geometry.dispose();
          object.material.dispose();
        }
        renderer.dispose();
        renderer.domElement.remove();
        labels.remove();
        activityLabels.remove();
      },
    };
    resize();
    return () => {
      shell.current?.dispose();
      shell.current = null;
    };
  }, [nodes, seatCount]);
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
