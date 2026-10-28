import type { MapSnapshot } from "@mc/core";
import * as THREE from "three";
import { agentColor } from "../hud/AgentTag.tsx";
import { haloSize, orbPlacement, type Position, stateLabel } from "./agents.ts";
import { branchList, changeTotals, factLine, stageLine, waitsOnYou } from "./cards.ts";
import type { MapNode } from "./model.ts";
import {
  arcPoint,
  emptyMotion,
  endpoint,
  type MessageArc,
  type MotionEvent,
  type MotionState,
  motionDelta,
  motionEpoch,
  reconcileMotion,
  sampleMotion,
} from "./motion.ts";

export interface ActivityProps {
  snapshot: MapSnapshot;
  /** Each seat's call sign (the crew's display name), for its fact line. */
  names?: Record<string, string>;
  indices: Record<string, number>;
  events?: MotionEvent[];
  epoch?: number;
  agent?: string | null;
  onAgentSelect?: (seat: string | null) => void;
  onArc?: (arc: MessageArc, button: HTMLButtonElement) => void;
}

/** Pooled geometry and DOM projection only. Agent and event meaning lives in the pure models. */
export function activityLayer(
  scene: THREE.Scene,
  labels: HTMLElement,
  nodes: MapNode[],
  memory: { current: MotionState },
  css: (token: string) => string,
) {
  const group = new THREE.Group();
  scene.add(group);
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const ring = new THREE.RingGeometry(0.94, 1, 32);
  let orbs = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial(), 0);
  let halos = new THREE.InstancedMesh(
    ring,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.3 }),
    0,
  );
  const beams = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }),
  );
  group.add(orbs, halos, beams);
  const particleGeometry = new THREE.BufferGeometry();
  const coordinates = new Float32Array(200 * 3),
    colors = new Float32Array(200 * 3),
    sizes = new Float32Array(200);
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(coordinates, 3));
  particleGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  particleGeometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const particles = new THREE.Points(
    particleGeometry,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      vertexShader:
        "attribute float size; varying vec3 tint; void main(){ tint=color; gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader:
        "varying vec3 tint; void main(){ float d=length(gl_PointCoord-vec2(0.5)); if(d>0.5) discard; gl_FragColor=vec4(tint,1.0-smoothstep(0.2,0.5,d)); }",
    }),
  );
  particles.frustumCulled = false;
  group.add(particles);
  const arcPool = Array.from({ length: 10 }, () => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(25 * 3), 3),
      ),
      new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
    );
    line.frustumCulled = false;
    line.visible = false;
    group.add(line);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-arc";
    button.hidden = true;
    labels.append(button);
    return { line, button };
  });
  let current: ActivityProps | null = null;
  let agents: {
    id: string;
    position: Position;
    goal: Position;
    placement: ReturnType<typeof orbPlacement>;
    label: HTMLButtonElement;
  }[] = [];
  let markers: { id: string; el: HTMLElement; position: Position }[] = [];
  let reduced = false;
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  const projected = new THREE.Vector3();
  const positionVector = new THREE.Vector3();
  const scaleVector = new THREE.Vector3();
  const arcSample: Position = [0, 0, 0];
  const palette = new Map<string, THREE.Color>();
  const nodePositions = new Map(nodes.map((n) => [n.path, n.position]));
  const colorOf = (id: string) => {
    const cached = palette.get(id);
    if (cached) return cached;
    const index = current?.snapshot.seats.findIndex((s) => s.seat === id) ?? -1;
    const variable = agentColor(
      id === "FLIGHT" ? "flight" : (current?.indices[id] ?? Math.max(0, index)),
    );
    const color = new THREE.Color(
      css(index < 0 && id !== "FLIGHT" ? "--muted" : variable.slice(4, -1)),
    );
    palette.set(id, color);
    return color;
  };
  const dim = (id: string) => (current?.agent && current.agent !== id ? 0.22 : 1);
  const project = (
    el: HTMLElement,
    position: Position,
    camera: THREE.Camera,
    width: number,
    height: number,
    yOffset = 0,
  ) => {
    const p = projected.set(position[0], position[1] + yOffset, position[2]).project(camera);
    el.style.left = `${((p.x + 1) * width) / 2}px`;
    el.style.top = `${((1 - p.y) * height) / 2}px`;
    el.hidden = p.z < -1 || p.z > 1;
  };
  const update = (props: ActivityProps, prefersReduced: boolean) => {
    current = props;
    reduced = prefersReduced;
    palette.clear();
    palette.set("spark:add", new THREE.Color(css("--ok")));
    palette.set("spark:remove", new THREE.Color(css("--crit")));
    memory.current = motionEpoch(memory.current, props.epoch ?? 0);
    if (!document.hidden)
      for (const event of props.events ?? [])
        memory.current = motionDelta(memory.current, event, props.snapshot, nodes);
    memory.current = reconcileMotion(memory.current, props.snapshot, nodes, Date.now());
    if (orbs.count !== props.snapshot.seats.length) {
      group.remove(orbs, halos);
      orbs.dispose();
      halos.dispose();
      orbs = new THREE.InstancedMesh(sphere, orbs.material, props.snapshot.seats.length);
      halos = new THREE.InstancedMesh(ring, halos.material, props.snapshot.seats.length);
      group.add(orbs, halos);
      beams.geometry.dispose();
      beams.geometry = new THREE.BufferGeometry()
        .setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(props.snapshot.seats.length * 12 * 6), 3),
        )
        .setAttribute(
          "color",
          new THREE.BufferAttribute(new Float32Array(props.snapshot.seats.length * 12 * 6), 3),
        );
    }
    const previous = new Map(agents.map((a) => [a.id, a]));
    agents = props.snapshot.seats.map((seat, index) => {
      const placement = orbPlacement(seat, nodes, index, Date.now());
      const old = previous.get(seat.seat);
      const label = old?.label ?? document.createElement("button");
      label.type = "button";
      label.className = "map-orb-label";
      // the agent cards carry the same selection in the tab order; an orb label is for the pointer
      label.tabIndex = -1;
      // facts only on the stage: who, which ticket, how much changed. Waiting on you is an amber
      // dot; the words, the live state, churn and branches are its accessible name and tooltip.
      const name = props.names?.[seat.seat];
      const text = document.createTextNode(stageLine(seat, name));
      if (waitsOnYou(seat)) {
        const dot = document.createElement("i");
        dot.className = "map-waits-dot";
        dot.setAttribute("aria-hidden", "true");
        label.replaceChildren(dot, text);
      } else label.replaceChildren(text);
      label.setAttribute("aria-label", factLine(seat, name));
      const { churn } = changeTotals(seat);
      label.title = [
        factLine(seat, name),
        `${stateLabel(seat, Date.now(), memory.current.ended[seat.seat])}${placement.more ? ` · +${placement.more} more files in flight` : ""}`,
        ...(churn
          ? ["~ edit churn: some lines counted from Edit and Write calls, not the diff"]
          : []),
        ...(seat.branches.length > 1 ? [`branches: ${branchList(seat)}`] : []),
      ].join("\n");
      label.style.color = colorOf(seat.seat).getStyle();
      label.style.opacity = String(dim(seat.seat) * (placement.docked ? 0.75 : 1));
      label.setAttribute("aria-pressed", String(props.agent === seat.seat));
      label.onclick = () =>
        current?.onAgentSelect?.(current.agent === seat.seat ? null : seat.seat);
      if (!old) labels.append(label);
      return {
        id: seat.seat,
        label,
        placement,
        goal: placement.position,
        position: document.hidden ? placement.position : (old?.position ?? placement.position),
      };
    });
    for (const old of previous.values())
      if (!agents.some((a) => a.id === old.id)) old.label.remove();
    for (const marker of markers) marker.el.remove();
    // CAPCOM, HUB and other message ends are named only while a message arc is in the air
    const ids = [
      ...new Set(sampleMotion(memory.current, Date.now()).arcs.flatMap((a) => [a.from, a.to])),
    ];
    markers = ids
      .filter((id) => !agents.some((a) => a.id === id))
      .map((id) => {
        const el = document.createElement("span");
        el.className = "map-marker";
        el.textContent = id;
        el.title =
          id === "HUB"
            ? "Hub calls; outgoing payload size unavailable"
            : id === "CAPCOM"
              ? id
              : "Message participant; no seat data";
        labels.append(el);
        return { id, el, position: endpoint(id, props.snapshot, nodes, Date.now()) };
      });
    for (const id of ids) colorOf(id);
  };
  const draw = (
    now: number,
    seconds: number,
    camera: THREE.Camera,
    width: number,
    height: number,
  ) => {
    if (!current) return false;
    const sampled = sampleMotion(memory.current, now);
    let moving = false;
    const linkPositions = beams.geometry.getAttribute("position");
    const linkColors = beams.geometry.getAttribute("color");
    let linkCount = 0;
    agents.forEach((agent, i) => {
      const distance = Math.hypot(
        agent.position[0] - agent.goal[0],
        agent.position[1] - agent.goal[1],
        agent.position[2] - agent.goal[2],
      );
      const amount = reduced || distance < 0.02 ? 1 : 1 - 0.12 ** Math.max(0, seconds);
      for (let axis = 0; axis < 3; axis++)
        agent.position[axis] += (agent.goal[axis] - agent.position[axis]) * amount;
      if (agent.position.some((v, axis) => v !== agent.goal[axis])) moving = true;
      const seat = current?.snapshot.seats[i];
      if (!seat) return;
      const color = tint
        .copy(colorOf(agent.id))
        .multiplyScalar(dim(agent.id) * (agent.placement.docked ? 0.4 : 1));
      matrix.makeScale(1.6, 1.6, 1.6).setPosition(...agent.position);
      orbs.setMatrixAt(i, matrix);
      orbs.setColorAt(i, color);
      const size = haloSize(seat) ?? 0;
      matrix.compose(
        positionVector.fromArray(agent.position),
        camera.quaternion,
        scaleVector.set(size, size, size),
      );
      halos.setMatrixAt(i, matrix);
      halos.setColorAt(i, color);
      for (const path of agent.placement.links) {
        const p = nodePositions.get(path);
        if (!p) continue;
        linkPositions.setXYZ(linkCount, ...agent.position);
        linkPositions.setXYZ(linkCount + 1, ...p);
        linkColors.setXYZ(linkCount, color.r, color.g, color.b);
        linkColors.setXYZ(linkCount + 1, color.r, color.g, color.b);
        linkCount += 2;
      }
      project(agent.label, agent.position, camera, width, height, 4);
    });
    for (const mesh of [orbs, halos]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    beams.geometry.setDrawRange(0, linkCount);
    if (linkPositions) linkPositions.needsUpdate = true;
    if (linkColors) linkColors.needsUpdate = true;
    beams.frustumCulled = false;
    let count = 0;
    if (!reduced)
      for (const particle of sampled.particles) {
        const u = (now - particle.at) / particle.life;
        if (u < 0 || u >= 1) continue;
        for (let axis = 0; axis < 3; axis++)
          coordinates[count * 3 + axis] =
            particle.from[axis] + (particle.to[axis] - particle.from[axis]) * u;
        const color =
          particle.kind === "add" || particle.kind === "remove"
            ? colorOf(`spark:${particle.kind}`)
            : colorOf(particle.seat);
        tint.copy(color).multiplyScalar(dim(particle.seat));
        colors[count * 3] = tint.r;
        colors[count * 3 + 1] = tint.g;
        colors[count * 3 + 2] = tint.b;
        sizes[count] = particle.size;
        count++;
      }
    particleGeometry.setDrawRange(0, count);
    for (const attribute of Object.values(particleGeometry.attributes))
      attribute.needsUpdate = true;
    const end = (id: string) =>
      agents.find((a) => a.id === id)?.position ??
      markers.find((marker) => marker.id === id)?.position ??
      arcSample;
    arcPool.forEach(({ line, button }, i) => {
      const arc = sampled.arcs[i];
      line.visible = !!arc;
      button.hidden = !arc;
      if (!arc) return;
      const a = end(arc.from),
        b = end(arc.to);
      const positions = line.geometry.getAttribute("position");
      for (let j = 0; j <= 24; j++) positions.setXYZ(j, ...arcPoint(a, b, j / 24, arcSample));
      positions.needsUpdate = true;
      line.material.color.copy(colorOf(arc.from));
      const opacity = reduced
        ? 1
        : Math.max(0, Math.min(1, (now - arc.at) / 250, (arc.at + 4000 - now) / 600));
      line.material.opacity = opacity * 0.75 * dim(arc.from);
      button.textContent = `${arc.kind}${arc.count > 1 ? ` ×${arc.count}` : ""}`;
      button.setAttribute(
        "aria-label",
        `${arc.kind}${arc.count > 1 ? ` ×${arc.count}` : ""}: ${arc.from} → ${arc.to}`,
      );
      button.style.color = colorOf(arc.from).getStyle();
      button.style.opacity = String(opacity * dim(arc.from));
      button.onclick = () => current?.onArc?.(arc, button);
      project(button, arcPoint(a, b, 0.5, arcSample), camera, width, height);
    });
    for (const marker of markers) project(marker.el, marker.position, camera, width, height);
    return !reduced && (moving || sampled.active);
  };
  return {
    update,
    draw,
    focus: (id: string) => agents.find((a) => a.id === id)?.goal,
    pick: (ray: THREE.Raycaster) => {
      const hit = ray.intersectObject(orbs)[0];
      return hit?.instanceId === undefined ? null : (agents[hit.instanceId]?.id ?? null);
    },
    glows: (now: number) => (reduced ? [] : sampleMotion(memory.current, now).glows),
    nextExpiry: (now: number) => sampleMotion(memory.current, now).arcs.map((a) => a.at + 4000),
    clear: () => {
      memory.current = { ...emptyMotion(), seq: memory.current.seq, epoch: memory.current.epoch };
      for (const a of agents) a.position = [...a.goal];
    },
    dispose: () => {
      for (const a of agents) a.label.remove();
      for (const m of markers) m.el.remove();
      for (const { line, button } of arcPool) {
        line.geometry.dispose();
        line.material.dispose();
        button.remove();
      }
      for (const mesh of [orbs, halos]) {
        mesh.dispose();
        mesh.material.dispose();
      }
      sphere.dispose();
      ring.dispose();
      beams.geometry.dispose();
      beams.material.dispose();
      particleGeometry.dispose();
      particles.material.dispose();
      scene.remove(group);
    },
  };
}
