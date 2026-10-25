import type { MapSnapshot } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { areaTone, fileStyle, type MapNode, pinToken } from "./model.ts";

type Props = {
  nodes: MapNode[];
  snapshot: MapSnapshot;
  focus: string | null;
  home: number;
  rotate: boolean;
  selected: string | null;
  indices: Record<string, number>;
  onSelect: (path: string) => void;
};
type Shell = { update: (props: Props) => void; dispose: () => void };

/** Geometry, picking and camera only; all map meaning comes from model.ts. */
export function MapScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<Shell | null>(null);
  const view = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    home: number;
    focus: string | null;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { nodes } = props;
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
    const box = new THREE.Box3().setFromPoints([...positions.values()]);
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
    const draw = () => {
      frame = undefined;
      if (document.hidden) return;
      lastDraw = performance.now();
      if (current?.rotate && !reduced.matches) controls.update();
      renderer.render(scene, camera);
      const w = el.clientWidth,
        h = el.clientHeight;
      for (const label of projected) {
        const p = label.position.clone().project(camera);
        label.el.style.left = `${((p.x + 1) * w) / 2}px`;
        label.el.style.top = `${((1 - p.y) * h) / 2}px`;
        label.el.hidden = p.z > 1 || p.z < -1;
      }
      if (current?.rotate && !reduced.matches) schedule();
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
      clearTimeout(expiry);
      const now = Date.now();
      const deadlines = next.snapshot.seats
        .flatMap((s) => [
          ...(s.state !== "running" && !s.calls.length ? [s.since + 60_000] : []),
          ...s.recent.map((r) => r.at + 600_000),
        ])
        .filter((t) => t > now);
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
        mesh.setColorAt(i, color);
        const p = new THREE.Vector3(...node.position);
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
        const edited = previous && (s.add !== previous.add || s.rem !== previous.rem);
        const grew = edited && s.level > previous.level;
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
      if (hit?.instanceId !== undefined) current?.onSelect(spheres[hit.instanceId].path);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pick);
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(frame);
        frame = undefined;
      } else schedule();
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
        };
        clearTimeout(frame);
        clearTimeout(expiry);
        observer.disconnect();
        theme.disconnect();
        controls.dispose();
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
      },
    };
    resize();
    return () => {
      shell.current?.dispose();
      shell.current = null;
    };
  }, [nodes]);
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
