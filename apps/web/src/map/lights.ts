import { type MapSnapshot, seatCallSign } from "@mc/core";
import * as THREE from "three";
import { agentColor } from "../hud/AgentTag.tsx";
import { lightPlacement, type Position, touchedNodes } from "./agents.ts";
import type { MapNode } from "./model.ts";

export interface LightProps {
  snapshot: MapSnapshot;
  /** Each seat's call sign (the crew's display name). */
  names?: Record<string, string>;
  indices: Record<string, number>;
  /** The selected seat: the others dim. */
  seat?: string | null;
  onSeatSelect?: (seat: string | null) => void;
}

/** The stage's void: a dimmed mark fades towards it, never to grey. */
const VOID = new THREE.Color("#04060c");
/**
 * Circles only: a seat's light is the largest and brightest; a file seats touched is a smaller
 * flat disc facing the camera, split into equal arcs, one per seat, when several have.
 */
const LIGHT_SIZE = 1.4;
/** A seat's light carries a thin outline in the stage's ink, so it never reads as one of its discs. */
const INK = new THREE.Color("#dbe4f5");
const MARK_SIZE = 0.85;
/** A disc sits this far in front of its node, towards the camera, so the node never pokes through. */
const MARK_LIFT = 0.45;

/** A seat's colour token: its place in config order, FLIGHT its own (AgentTag's agentColor). */
export const seatToken = (seat: string, indices: Record<string, number>, order: number): string =>
  agentColor(seat === "FLIGHT" ? "flight" : (indices[seat] ?? Math.max(0, order))).slice(4, -1);

/**
 * The seats on the stage: one small solid light each, on the node it last touched, a thin path of
 * its colour through the nodes it visited, and a disc on every node a seat touched (read or
 * changed), in arcs of each seat's colour when shared. Pooled geometry and DOM projection only;
 * the meaning is in agents.ts and cards.ts.
 */
export function lightLayer(
  scene: THREE.Scene,
  labels: HTMLElement,
  nodes: MapNode[],
  css: (token: string) => string,
) {
  const group = new THREE.Group();
  scene.add(group);
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  type Marks = THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  // the lights, then one disc mesh per number of arcs ("marks-1" whole, "marks-2" halves, ...),
  // made when a node first has that many seats
  const ring = new THREE.RingGeometry(1, 1.16, 40);
  const meshes: Record<string, Marks> = {
    lights: new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial(), 0),
    outlines: new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial(), 0),
  };
  const arcs = new Map<number, THREE.CircleGeometry>();
  const arc = (n: number) => {
    let geometry = arcs.get(n);
    if (!geometry) {
      geometry = new THREE.CircleGeometry(1, 32, 0, (Math.PI * 2) / n);
      arcs.set(n, geometry);
    }
    return geometry;
  };
  const paths = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  paths.frustumCulled = false;
  paths.name = "paths";
  for (const [key, mesh] of Object.entries(meshes)) mesh.name = key;
  group.add(meshes.lights, meshes.outlines, paths);
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  /** Each disc arc: its node, its seat's colour, and which of the node's `n` arcs it is. */
  let marks: { at: Position; color: THREE.Color; n: number; k: number }[] = [];
  let current: LightProps | null = null;
  let reduced = false;
  let seats: {
    id: string;
    position: Position;
    goal: Position;
    color: THREE.Color;
    trail: Position[];
    label: HTMLButtonElement;
  }[] = [];
  const matrix = new THREE.Matrix4();
  const projected = new THREE.Vector3();
  const facing = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const towards = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const scale = new THREE.Vector3(MARK_SIZE, MARK_SIZE, MARK_SIZE);
  const zAxis = new THREE.Vector3(0, 0, 1);

  /** An instanced mesh holding exactly `count`, replaced only when the count changes. */
  const sized = (key: string, count: number) => {
    const old = meshes[key];
    if (old && old.count === count) return old;
    if (old) {
      group.remove(old);
      old.dispose();
    }
    const next = new THREE.InstancedMesh(
      old?.geometry ?? arc(Number(key.slice(6))),
      old?.material ?? new THREE.MeshBasicMaterial({ depthWrite: false }),
      count,
    );
    next.name = key;
    next.frustumCulled = false;
    group.add(next);
    meshes[key] = next;
    return next;
  };

  const update = (props: LightProps, prefersReduced: boolean, now: number) => {
    current = props;
    reduced = prefersReduced;
    const previous = new Map(seats.map((s) => [s.id, s]));
    // a lit seat stands out by dimming the rest towards the void
    const shade = (id: string, base: THREE.Color) =>
      props.seat && props.seat !== id ? base.clone().lerp(VOID, 0.72) : base.clone();
    // seats sharing a node sit side by side on it
    const sharing = new Map<string, number>();
    seats = props.snapshot.seats.map((seat, order) => {
      const placement = lightPlacement(seat, nodes, order, now);
      const k = placement.node === null ? 0 : (sharing.get(placement.node) ?? 0);
      if (placement.node !== null) sharing.set(placement.node, k + 1);
      const goal: Position = [
        placement.position[0] + k * LIGHT_SIZE * 2.4,
        placement.position[1],
        placement.position[2],
      ];
      const base = new THREE.Color(css(seatToken(seat.seat, props.indices, order)));
      const color = shade(seat.seat, base);
      if (placement.docked) color.lerp(VOID, 0.35);
      const old = previous.get(seat.seat);
      const label = old?.label ?? document.createElement("button");
      label.type = "button";
      label.className = "map-seat-label";
      // the selector carries the same choice in the tab order; a stage label is for the pointer
      label.tabIndex = -1;
      label.textContent = props.names?.[seat.seat] ?? seatCallSign(seat.seat);
      label.style.color = color.getStyle();
      label.setAttribute("aria-pressed", String(props.seat === seat.seat));
      label.onclick = () => current?.onSeatSelect?.(current.seat === seat.seat ? null : seat.seat);
      if (!old) {
        // unplaced until its first frame, never shown at the stage's corner
        label.hidden = true;
        labels.append(label);
      }
      return {
        id: seat.seat,
        label,
        goal,
        // a light glides from where it was; a new one, or any under reduced motion, starts there
        position: old && !prefersReduced && !document.hidden ? old.position : [...goal],
        color,
        trail: placement.trail.flatMap((path) => {
          const p = byPath.get(path)?.position;
          return p ? [p] : [];
        }),
      };
    });
    for (const old of previous.values())
      if (!seats.some((s) => s.id === old.id)) old.label.remove();

    // a disc on each node a seat touched; a shared node's disc in equal arcs, in seat order
    const colours = new Map(seats.map((s) => [s.id, s.color.clone().lerp(VOID, 0.2)]));
    marks = [];
    for (const [path, ids] of touchedNodes(props.snapshot, nodes)) {
      const node = byPath.get(path);
      if (!node) continue;
      ids.forEach((id, k) => {
        const color = colours.get(id);
        if (color) marks.push({ at: node.position, color, n: ids.length, k });
      });
    }
    const counts = new Map<number, number>();
    for (const mark of marks) counts.set(mark.n, (counts.get(mark.n) ?? 0) + 1);
    for (const key of Object.keys(meshes))
      if (key.startsWith("marks-") && !counts.has(Number(key.slice(6)))) sized(key, 0);
    for (const [n, count] of counts) {
      const mesh = sized(`marks-${n}`, count);
      marks
        .filter((mark) => mark.n === n)
        .forEach((mark, i) => {
          mesh.setColorAt(i, mark.color);
        });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const lights = sized("lights", seats.length);
    const outlines = sized("outlines", seats.length);
    seats.forEach((s, i) => {
      lights.setColorAt(i, s.color);
      outlines.setColorAt(
        i,
        props.seat && props.seat !== s.id ? INK.clone().lerp(VOID, 0.72) : INK,
      );
    });
    for (const mesh of [lights, outlines])
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const segments = seats.reduce((n, s) => n + s.trail.length, 0);
    paths.geometry.dispose();
    paths.geometry = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(new Float32Array(segments * 6), 3))
      .setAttribute("color", new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
  };

  /** Glide each light towards its node; true while one is still moving. */
  const draw = (seconds: number, camera: THREE.Camera, width: number, height: number) => {
    if (!current) return false;
    let moving = false;
    const lights = meshes.lights;
    const outlines = meshes.outlines;
    const line = paths.geometry.getAttribute("position");
    const tint = paths.geometry.getAttribute("color");
    let v = 0;
    seats.forEach((s, i) => {
      const distance = Math.hypot(
        s.position[0] - s.goal[0],
        s.position[1] - s.goal[1],
        s.position[2] - s.goal[2],
      );
      const amount = reduced || distance < 0.02 ? 1 : 1 - 0.1 ** Math.max(0, seconds);
      for (let axis = 0; axis < 3; axis++)
        s.position[axis] += (s.goal[axis] - s.position[axis]) * amount;
      if (s.position.some((value, axis) => value !== s.goal[axis])) moving = true;
      lights.setMatrixAt(
        i,
        matrix.makeScale(LIGHT_SIZE, LIGHT_SIZE, LIGHT_SIZE).setPosition(...s.position),
      );
      // the outline faces the camera at the light's rim, just in front of it
      spot.set(...s.position);
      towards.copy(camera.position).sub(spot).normalize().multiplyScalar(LIGHT_SIZE);
      outlines?.setMatrixAt(
        i,
        matrix.compose(
          spot.add(towards),
          camera.quaternion,
          scale.set(LIGHT_SIZE, LIGHT_SIZE, LIGHT_SIZE),
        ),
      );
      // the path runs node to node and ends at the light, so it grows as the light moves
      const points = [...s.trail.slice(0, -1), s.position];
      if (s.trail.length === 0) points.length = 0;
      for (let j = 1; j < points.length; j++) {
        for (const p of [points[j - 1] as Position, points[j] as Position]) {
          line?.setXYZ(v, ...p);
          tint?.setXYZ(v, s.color.r, s.color.g, s.color.b);
          v++;
        }
      }
      const p = projected.set(s.position[0], s.position[1] + 3.2, s.position[2]).project(camera);
      s.label.style.left = `${((p.x + 1) * width) / 2}px`;
      s.label.style.top = `${((1 - p.y) * height) / 2}px`;
      s.label.hidden = p.z < -1 || p.z > 1;
    });
    lights.instanceMatrix.needsUpdate = true;
    lights.computeBoundingSphere();
    if (outlines) outlines.instanceMatrix.needsUpdate = true;
    scale.set(MARK_SIZE, MARK_SIZE, MARK_SIZE);
    // each disc faces the camera, its arcs turned into place: the first from the top, clockwise
    const placed = new Map<number, number>();
    for (const mark of marks) {
      const mesh = meshes[`marks-${mark.n}`];
      if (!mesh) continue;
      const i = placed.get(mark.n) ?? 0;
      placed.set(mark.n, i + 1);
      turn.setFromAxisAngle(zAxis, Math.PI / 2 - ((mark.k + 1) * Math.PI * 2) / mark.n);
      facing.copy(camera.quaternion).multiply(turn);
      spot.set(...mark.at);
      towards.copy(camera.position).sub(spot).normalize().multiplyScalar(MARK_LIFT);
      mesh.setMatrixAt(i, matrix.compose(spot.add(towards), facing, scale));
    }
    for (const [key, mesh] of Object.entries(meshes))
      if (key.startsWith("marks-")) mesh.instanceMatrix.needsUpdate = true;
    paths.geometry.setDrawRange(0, v);
    if (line) line.needsUpdate = true;
    if (tint) tint.needsUpdate = true;
    return !reduced && moving;
  };

  return {
    update,
    draw,
    /** Where a seat's light is now (between nodes while it glides), and where it is going. */
    position: (id: string) => seats.find((s) => s.id === id)?.position,
    goal: (id: string) => seats.find((s) => s.id === id)?.goal,
    pick: (ray: THREE.Raycaster) => {
      const hit = ray.intersectObject(meshes.lights)[0];
      return hit?.instanceId === undefined ? null : (seats[hit.instanceId]?.id ?? null);
    },
    /** Lights (or one seat's) jump to their nodes, without the journey. */
    settle: (id?: string) => {
      for (const s of seats) if (id === undefined || s.id === id) s.position = [...s.goal];
    },
    dispose: () => {
      for (const s of seats) s.label.remove();
      for (const mesh of Object.values(meshes)) {
        mesh.dispose();
        mesh.material.dispose();
      }
      sphere.dispose();
      ring.dispose();
      for (const geometry of arcs.values()) geometry.dispose();
      paths.geometry.dispose();
      paths.material.dispose();
      scene.remove(group);
    },
  };
}
