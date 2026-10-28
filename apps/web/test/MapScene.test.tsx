import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lightPlacement } from "../src/map/agents.ts";
import { renderer } from "./mapRendererMock.ts";

const { MapScene, fileTip } = await import("../src/map/MapScene.tsx");

import { layoutTree } from "../src/map/model.ts";

const nodes = layoutTree(mapSnapshotFixture.tree);
// the fixture's seat read main.ts just now (a path the hub still keeps), and is reading util.ts
const fresh: MapSnapshot = structuredClone(mapSnapshotFixture);
fresh.seats[0].recent = [{ file: "src/main.ts", at: Date.now() - 1000 }];
fresh.seats[0].calls[0].since = Date.now();
const props = {
  nodes,
  snapshot: fresh,
  focus: null,
  selected: null,
  home: 0,
  rotate: false,
  indices: {},
  onSelect: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  renderer.render.mockClear();
  renderer.dispose.mockClear();
  renderer.fail = false;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders once when settled, pauses in hidden tabs, caps rotation and disposes on collapse", () => {
  const { rerender, unmount } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(60_000));
  expect(renderer.render).toHaveBeenCalledOnce();
  rerender(<MapScene {...props} rotate />);
  const before = renderer.render.mock.calls.length;
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render.mock.calls.length - before).toBeLessThanOrEqual(30);
  expect(renderer.render.mock.calls.length - before).toBeGreaterThan(0);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const hidden = renderer.render.mock.calls.length;
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledTimes(hidden);
  unmount();
  expect(renderer.dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("provides a searchable-file fallback when WebGL is unavailable", () => {
  renderer.fail = true;
  render(<MapScene {...props} />);
  expect(screen.getByRole("status").textContent).toContain("Use file search");
});

it("uses point LOD for a 5,000-file 1440×900 overview without aggregating file nodes", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  const tree = Array.from({ length: 5_000 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
  const nodes = layoutTree(tree);
  const snapshot = { ...structuredClone(props.snapshot), tree };
  render(<MapScene {...props} nodes={nodes} snapshot={snapshot} overview={1} />);
  act(() => vi.advanceTimersByTime(100));
  const scene = renderer.render.mock.lastCall?.[0] as THREE.Scene;
  const points = scene.children.find((child) => child instanceof THREE.Points) as THREE.Points;
  const spheres = scene.children.find(
    (child) => child instanceof THREE.InstancedMesh,
  ) as THREE.InstancedMesh;
  expect(nodes.filter((node) => node.count > 0)).toHaveLength(5_000);
  expect(nodes.filter((node) => node.count > 1)).toHaveLength(0);
  expect(points.geometry.getAttribute("position").count).toBe(5_000);
  expect(points.visible).toBe(true);
  expect(spheres.visible).toBe(false);
});

it("selects and describes a file point in the large-repo overview", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  const tree = Array.from({ length: 5_000 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
  const nodes = layoutTree(tree);
  const onSelect = vi.fn();
  const snapshot = { ...structuredClone(props.snapshot), tree };
  render(
    <MapScene {...props} nodes={nodes} snapshot={snapshot} overview={1} onSelect={onSelect} />,
  );
  act(() => vi.advanceTimersByTime(100));

  const scene = renderer.render.mock.lastCall?.[0] as THREE.Scene;
  const camera = renderer.render.mock.lastCall?.[1] as THREE.PerspectiveCamera;
  const points = scene.children.find((child) => child instanceof THREE.Points) as THREE.Points;
  const target = new THREE.Vector3().fromBufferAttribute(
    points.geometry.getAttribute("position") as THREE.BufferAttribute,
    0,
  );
  const projected = target.project(camera);
  const clientX = ((projected.x + 1) / 2) * 1440;
  const clientY = ((1 - projected.y) / 2) * 900;
  const spheres = scene.children.find(
    (child) => child instanceof THREE.InstancedMesh,
  ) as THREE.InstancedMesh;
  const pointRaycast = vi.spyOn(points, "raycast");
  const meshRaycast = vi.spyOn(spheres, "raycast");
  const canvas = screen.getByRole("application");
  Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    bottom: 900,
    height: 900,
    left: 0,
    right: 1440,
    toJSON() {},
    top: 0,
    width: 1440,
    x: 0,
    y: 0,
  });

  fireEvent.pointerDown(canvas, { clientX, clientY });
  fireEvent.pointerUp(canvas, { clientX, clientY });
  expect(pointRaycast).toHaveBeenCalled();
  expect(meshRaycast).not.toHaveBeenCalled();
  const selected = onSelect.mock.calls[0]?.[0];
  expect(selected).toMatch(/^src\/f\d+\.ts$/);
  fireEvent.pointerMove(canvas, { clientX, clientY });
  act(() => vi.advanceTimersByTime(40));
  expect(screen.getByRole("tooltip").textContent).toContain(selected);
});

/* Superseded by the seat-light architecture merged from main.
it("animates fixture deltas at at most 30 fps, opens the arc pair, and stops after settling", () => {
  const onArc = vi.fn();
  const { rerender, unmount } = render(<MapScene {...props} onArc={onArc} />);
  act(() => vi.advanceTimersByTime(100));
  let snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  const events: MotionEvent[] = [];
  for (const delta of mapDeltaFixture) {
    const seat = "seat" in delta ? delta.seat : null;
    events.push({
      delta,
      at: Date.now(),
      calls: snapshot.seats.find((s) => s.seat === seat)?.calls,
    });
    snapshot = applyDelta(snapshot, delta, Date.now()) ?? { ...snapshot, seq: delta.seq };
    rerender(<MapScene {...props} snapshot={snapshot} events={[...events]} onArc={onArc} />);
  }
  const before = renderer.render.mock.calls.length;
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render.mock.calls.length - before).toBeGreaterThan(1);
  expect(renderer.render.mock.calls.length - before).toBeLessThanOrEqual(30);
  const label = screen.getByRole("button", { name: "review: GUIDO-1 → RETRO-1" });
  fireEvent.click(label);
  expect(onArc).toHaveBeenCalledWith(
    expect.objectContaining({ from: "GUIDO-1", to: "RETRO-1", ticket: 7 }),
    label,
  );
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("button", { name: "review: GUIDO-1 → RETRO-1" })).toBeNull();
  const settled = renderer.render.mock.calls.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(renderer.render).toHaveBeenCalledTimes(settled);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("selects an orb without moving the camera, zooms explicitly, and resets Home", () => {
  const onAgentSelect = vi.fn();
  const { rerender } = render(<MapScene {...props} onAgentSelect={onAgentSelect} />);
  act(() => vi.advanceTimersByTime(100));
  const camera = renderer.render.mock.lastCall?.[1] as import("three").Camera;
  const home = camera.position.clone();
  fireEvent.click(
    screen.getByRole("button", {
      name: /^GUIDO-1 · #7 · 1 file · \+12 −3 \(churn\) · waiting on you$/,
    }),
  );
  expect(onAgentSelect).toHaveBeenCalledWith("GUIDO-1");
  rerender(<MapScene {...props} agent="GUIDO-1" />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.equals(home)).toBe(true);
  rerender(<MapScene {...props} agent="GUIDO-1" agentFocus={{ seat: "GUIDO-1", request: 1 }} />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.equals(home)).toBe(false);
  rerender(<MapScene {...props} home={1} agent="GUIDO-1" agentFocus={null} />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.equals(home)).toBe(true);
});

it("keeps live motion static under reduced motion and clears the arc after four seconds", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const events = mapDeltaFixture.map((delta) => ({ delta, at: Date.now() }));
  render(<MapScene {...props} events={events} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "review: GUIDO-1 → RETRO-1" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(4000));
  expect(renderer.render).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "review: GUIDO-1 → RETRO-1" })).toBeNull();
});

it("drops in-progress effects on tab hide and catches up silently on return", () => {
  const { rerender } = render(
    <MapScene {...props} events={mapDeltaFixture.map((delta) => ({ delta, at: Date.now() }))} />,
  );
  act(() => vi.advanceTimersByTime(500));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const before = renderer.render.mock.calls.length;
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats[0].calls = [];
  snapshot.seats[0].recent = [{ file: "src/main.ts", at: Date.now() }];
  rerender(<MapScene {...props} snapshot={snapshot} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledTimes(before);
  hidden.mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledTimes(before + 1);
  act(() => vi.advanceTimersByTime(60_000));
  expect(renderer.render).toHaveBeenCalledTimes(before + 1);
});

const submittedScene = () => renderer.render.mock.lastCall?.[0] as THREE.Scene;
const activityObjects = () => {
  const group = submittedScene().children.find(
    (object) => object instanceof THREE.Group,
  ) as THREE.Group;
  return {
    group,
    orbs: group.children.find(
      (object) =>
        object instanceof THREE.InstancedMesh && object.geometry instanceof THREE.SphereGeometry,
    ) as THREE.InstancedMesh,
    particles: group.children.find((object) => object instanceof THREE.Points) as THREE.Points,
  };
};
it("submits placed orb matrices and populated particle attributes to the renderer", () => {
  const { rerender } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const { orbs, particles } = activityObjects();
  const matrix = new THREE.Matrix4();
  props.snapshot.seats.forEach((seat, i) => {
    orbs.getMatrixAt(i, matrix);
    const actual = new THREE.Vector3().setFromMatrixPosition(matrix);
    const expected = orbPlacement(seat, nodes, i, Date.now()).position;
    actual.toArray().forEach((value, axis) => {
      expect(value).toBeCloseTo(expected[axis], 5);
    });
    expect(new THREE.Vector3().setFromMatrixScale(matrix).toArray()).toEqual([
      expect.closeTo(1.6),
      expect.closeTo(1.6),
      expect.closeTo(1.6),
    ]);
  });
  expect(particles.geometry.drawRange.count).toBe(0);
  const at = Date.now();
  let drawnAt = at;
  renderer.render.mockImplementationOnce(() => {
    drawnAt = Date.now();
  });
  rerender(
    <MapScene
      {...props}
      events={[
        {
          delta: { type: "edit", seq: 1, seat: "GUIDO-1", file: "src/main.ts", add: 8, rem: 0 },
          at,
        },
      ]}
    />,
  );
  act(() => vi.advanceTimersByTime(40));
  const geometry = particles.geometry;
  expect(geometry.drawRange).toEqual({ start: 0, count: 1 });
  const p = nodes.find((node) => node.path === "src/main.ts")?.position as number[];
  const u = (drawnAt - at) / 800;
  const outside = [p[0] + Math.cos(2.4) * 10, p[1] + Math.sin(2.4) * 10, p[2] + Math.cos(4.8) * 5];
  const position = geometry.getAttribute("position");
  [position.getX(0), position.getY(0), position.getZ(0)].forEach((value, axis) => {
    expect(value).toBeCloseTo(outside[axis] + (p[axis] - outside[axis]) * u, 5);
  });
  expect(geometry.getAttribute("size").getX(0)).toBeCloseTo(3.6);
  expect(Array.from(geometry.getAttribute("color").array).slice(0, 3)).toEqual(
    new THREE.Color("#808999").toArray().map((v) => expect.closeTo(v, 5)),
  );
  expect((position as THREE.BufferAttribute).version).toBeGreaterThan(0);
});
*/
it("releases labels, instance resources and geometries on seat removal and unmount", () => {
  const { rerender, unmount } = render(<MapScene {...props} areas={["src"]} />);
  act(() => vi.advanceTimersByTime(40));
  const watch = () => {
    const scene = submittedScene();
    const disposed: ReturnType<typeof vi.fn>[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        const resource = vi.fn();
        object.geometry.addEventListener("dispose", resource);
        disposed.push(resource);
        if (object instanceof THREE.InstancedMesh) {
          const instance = vi.fn();
          object.addEventListener("dispose", instance);
          disposed.push(instance);
        }
      }
    });
    return disposed;
  };
  const oldLabel = screen.getByRole("button", { name: "GUIDO-1" });
  const oldResources = watch();
  rerender(
    <MapScene
      {...props}
      areas={["src"]}
      snapshot={{ ...props.snapshot, seats: props.snapshot.seats.slice(1) }}
    />,
  );
  act(() => vi.advanceTimersByTime(40));
  expect(oldLabel.isConnected).toBe(false);
  for (const disposed of oldResources) expect(disposed).toHaveBeenCalledOnce();
  const labels = [...document.querySelectorAll(".map-seat-label, .map-area")];
  expect(labels.length).toBeGreaterThan(0);
  const remaining = watch();
  unmount();
  for (const disposed of remaining) expect(disposed).toHaveBeenCalledOnce();
  for (const label of labels) expect(label.isConnected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps one WebGL context per visit: new nodes rebuild the tree, unmount loses the context", () => {
  renderer.forceContextLoss.mockClear();
  const created = renderer.created;
  const { rerender, unmount } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const branchOnly = layoutTree([{ path: "branch/new.ts", lines: 1 }], nodes);
  rerender(<MapScene {...props} nodes={branchOnly} />);
  act(() => vi.advanceTimersByTime(40));
  expect(renderer.created - created).toBe(1);
  expect(renderer.dispose).not.toHaveBeenCalled();
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  expect(canvas.getAttribute("role")).toBe("application");
  expect(canvas.tabIndex).toBe(0);
  for (const label of document.querySelectorAll<HTMLElement>(".map-seat-label"))
    expect(label.tabIndex).toBe(-1);
  unmount();
  expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
  expect(renderer.forceContextLoss.mock.invocationCallOrder[0]).toBeLessThan(
    renderer.dispose.mock.invocationCallOrder[0] as number,
  );
});

it("hands focus to the stage when a focused overlay label leaves, never when focus went elsewhere", async () => {
  const { rerender, unmount } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  const without = { ...props.snapshot, seats: props.snapshot.seats.slice(1) };
  const label = () => screen.getByRole("button", { name: "GUIDO-1" });
  act(() => label().focus());
  rerender(<MapScene {...props} snapshot={without} />);
  await act(async () => {
    vi.advanceTimersByTime(40);
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(canvas);
  // focus moved outside the stage first: the stage leaves it there
  rerender(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const outside = document.createElement("button");
  document.body.append(outside);
  act(() => label().focus());
  act(() => outside.focus());
  rerender(<MapScene {...props} snapshot={without} />);
  await act(async () => {
    vi.advanceTimersByTime(40);
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(outside);
  outside.remove();
  unmount();
});

it("opens on the changed files, follows them until an arrow key moves it, and frames the whole repo", () => {
  const tree = [
    ...mapSnapshotFixture.tree,
    ...Array.from({ length: 30 }, (_, i) => ({ path: `apps/web/src/w${i}.tsx`, lines: 40 })),
    ...Array.from({ length: 30 }, (_, i) => ({ path: `apps/server/src/s${i}.ts`, lines: 40 })),
  ];
  const big = layoutTree(tree);
  const at = (path: string) =>
    new THREE.Vector3(...(big.find((n) => n.path === path)?.position ?? [0, 0, 0]));
  const camera = () => renderer.render.mock.lastCall?.[1] as THREE.PerspectiveCamera;
  const snapshot = (file: string): MapSnapshot => {
    const s: MapSnapshot = structuredClone(mapSnapshotFixture);
    // idle with an unmerged change: its orb sits over that change
    Object.assign(s.seats[0], { calls: [], recent: [], state: "idle", since: 0 });
    s.seats[0].scope.modified = [{ file, add: 5, rem: 1, source: "diff" }];
    return s;
  };
  const base = { ...props, nodes: big, dockSeats: 1 };
  // a stage with a size, so the camera has an aspect to frame with
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  // how far from the middle of the view a file is (0 is dead centre)
  const offCentre = (path: string) => {
    camera().updateMatrixWorld();
    const p = at(path).project(camera());
    return Math.hypot(p.x, p.y);
  };
  const far = "apps/web/src/w29.tsx";
  const { rerender, unmount } = render(<MapScene {...base} snapshot={snapshot("src/main.ts")} />);
  act(() => vi.advanceTimersByTime(40));
  const work = camera().position.distanceTo(at("src/main.ts"));
  // the work (the file and its orb just above it) fills the view
  expect(offCentre("src/main.ts")).toBeLessThan(0.3);
  rerender(<MapScene {...base} snapshot={snapshot("src/main.ts")} overview={1} />);
  act(() => vi.advanceTimersByTime(40));
  expect(camera().position.distanceTo(at("src/main.ts"))).toBeGreaterThan(work);
  // Home view: back to the work, which then follows the changed files
  rerender(<MapScene {...base} snapshot={snapshot("src/main.ts")} overview={1} home={1} />);
  act(() => vi.advanceTimersByTime(40));
  const away = offCentre(far);
  rerender(<MapScene {...base} snapshot={snapshot(far)} overview={1} home={1} />);
  act(() => vi.advanceTimersByTime(40));
  expect(offCentre(far)).toBeLessThan(0.3);
  expect(offCentre(far)).toBeLessThan(away);
  // an arrow key is the operator moving the camera: the work no longer drags it back
  fireEvent.keyDown(document.querySelector("canvas") as HTMLCanvasElement, { key: "ArrowLeft" });
  act(() => vi.advanceTimersByTime(40));
  const moved = camera().position.clone();
  rerender(
    <MapScene {...base} snapshot={snapshot("apps/server/src/s3.ts")} overview={1} home={1} />,
  );
  act(() => vi.advanceTimersByTime(40));
  expect(camera().position.toArray()).toEqual(moved.toArray());
  unmount();
});

const submittedScene = () => renderer.render.mock.lastCall?.[0] as THREE.Scene;
const layer = () => {
  const group = submittedScene().children.find((o) => o instanceof THREE.Group) as THREE.Group;
  const get = (name: string) => group.getObjectByName(name) as THREE.InstancedMesh;
  return {
    lights: get("lights"),
    marks: (n: number) => get(`marks-${n}`),
    paths: group.getObjectByName("paths") as THREE.LineSegments,
  };
};
const at = (mesh: THREE.InstancedMesh, i: number) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(i, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
};
const node = (path: string) =>
  new THREE.Vector3(...(nodes.find((n) => n.path === path)?.position ?? [NaN, NaN, NaN]));

it("draws no warnings: no finding, conflict, question or failure marks, only the seat's name", () => {
  const snapshot: MapSnapshot = {
    ...structuredClone(mapSnapshotFixture),
    conflicts: [
      { file: "src/main.ts", branches: ["a", "b"], shas: ["1".repeat(40), "2".repeat(40)] },
    ],
  };
  // the fixture's seat has a question, a refusal and a review finding
  expect(snapshot.seats[0]?.badges.questions.length).toBeGreaterThan(0);
  const { container, unmount } = render(<MapScene {...props} snapshot={snapshot} />);
  act(() => vi.advanceTimersByTime(100));
  expect(container.querySelector(".map-mark, .map-ring, .map-waits-dot, .map-arc")).toBeNull();
  expect(container.textContent).not.toMatch(/[▲◆]/);
  const label = screen.getByRole("button", { name: "GUIDO-1" });
  expect(label.textContent).toBe("GUIDO-1");
  expect(label.getAttribute("title")).toBeNull();
  unmount();
});

it("puts each seat's light on its node, a path through its visits and a disc on each file it touched", () => {
  render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const { lights, marks, paths } = layer();
  // the fixture's seat read main.ts, then is reading util.ts: its light is on util.ts
  expect(lights.count).toBe(1);
  expect(at(lights, 0).distanceTo(node("src/util.ts"))).toBeCloseTo(0, 5);
  expect(lightPlacement(props.snapshot.seats[0], nodes, 0, Date.now()).trail).toEqual([
    "src/main.ts",
    "src/util.ts",
  ]);
  // one segment, main.ts to the light
  expect(paths.geometry.drawRange.count).toBe(2);
  const line = paths.geometry.getAttribute("position");
  expect(
    new THREE.Vector3(line.getX(0), line.getY(0), line.getZ(0)).distanceTo(node("src/main.ts")),
  ).toBeCloseTo(0, 5);
  // one kind of mark: a whole disc on each file it touched, changed (main.ts) or read (util.ts)
  const discs = marks(1);
  expect(discs.count).toBe(2);
  expect(discs.geometry).toBeInstanceOf(THREE.CircleGeometry);
  for (const [i, path] of ["src/main.ts", "src/util.ts"].entries())
    expect(at(discs, i).distanceTo(node(path))).toBeLessThan(0.5);
  // the light is the brightest, largest circle; the disc is the seat's colour, a little dimmer
  const size = (mesh: THREE.InstancedMesh) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    return new THREE.Vector3().setFromMatrixScale(matrix).x;
  };
  expect(size(lights)).toBeGreaterThan(size(discs));
  const light = new THREE.Color(),
    disc = new THREE.Color();
  lights.getColorAt(0, light);
  discs.getColorAt(0, disc);
  expect(light.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(disc.getHSL({ h: 0, s: 0, l: 0 }).l);
});

it("splits a shared file's disc into equal arcs, one per seat, in seat order", () => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats.push(
    {
      ...structuredClone(snapshot.seats[0]),
      seat: "GUIDO-2",
      calls: [],
      recent: [],
      scope: { read: ["src/main.ts"], modified: [] },
    },
    {
      ...structuredClone(snapshot.seats[0]),
      seat: "RETRO-1",
      calls: [],
      recent: [],
      scope: { read: ["src/main.ts"], modified: [] },
    },
  );
  const root = document.documentElement.style;
  for (const [token, colour] of [
    ["--seat-1", "#ff0000"],
    ["--seat-2", "#00ff00"],
    ["--seat-3", "#0000ff"],
  ])
    root.setProperty(token, colour);
  render(
    <MapScene
      {...props}
      snapshot={snapshot}
      indices={{ "GUIDO-1": 0, "GUIDO-2": 1, "RETRO-1": 2 }}
    />,
  );
  act(() => vi.advanceTimersByTime(40));
  const thirds = layer().marks(3);
  // main.ts is shared by three seats: three arcs of a third each; util.ts is GUIDO-1's alone
  expect(thirds.count).toBe(3);
  expect((thirds.geometry as THREE.CircleGeometry).parameters.thetaLength).toBeCloseTo(
    (Math.PI * 2) / 3,
  );
  expect(layer().marks(1).count).toBe(1);
  // in seat order: GUIDO-1 red, GUIDO-2 green, RETRO-1 blue, each its own arc
  const strongest = [0, 1, 2].map((i) => {
    const c = new THREE.Color();
    thirds.getColorAt(i, c);
    const channels = [c.r, c.g, c.b];
    return "rgb"[channels.indexOf(Math.max(...channels))];
  });
  expect(strongest).toEqual(["r", "g", "b"]);
  for (const token of ["--seat-1", "--seat-2", "--seat-3"]) root.removeProperty(token);
  const turns = [0, 1, 2].map((i) => {
    const matrix = new THREE.Matrix4();
    thirds.getMatrixAt(i, matrix);
    return new THREE.Quaternion().setFromRotationMatrix(matrix.extractRotation(matrix));
  });
  expect(turns[0]?.angleTo(turns[1] as THREE.Quaternion)).toBeCloseTo((Math.PI * 2) / 3, 3);
});

it("glides a light to the next node at at most 30 fps, then settles; reduced motion jumps", () => {
  const { rerender, unmount } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(100));
  const moved: MapSnapshot = structuredClone(mapSnapshotFixture);
  moved.seats[0].calls = [{ tool: "Edit", detail: "", files: ["src/main.ts"], since: Date.now() }];
  moved.seats[0].recent = [{ file: "src/util.ts", at: 1 }];
  const before = renderer.render.mock.calls.length;
  rerender(<MapScene {...props} snapshot={moved} />);
  act(() => vi.advanceTimersByTime(100));
  // on its way: between the two nodes
  const midway = at(layer().lights, 0);
  expect(midway.distanceTo(node("src/main.ts"))).toBeGreaterThan(0.01);
  expect(midway.distanceTo(node("src/util.ts"))).toBeGreaterThan(0.01);
  act(() => vi.advanceTimersByTime(900));
  expect(renderer.render.mock.calls.length - before).toBeGreaterThan(1);
  expect(renderer.render.mock.calls.length - before).toBeLessThanOrEqual(31);
  act(() => vi.advanceTimersByTime(10_000));
  expect(at(layer().lights, 0).distanceTo(node("src/main.ts"))).toBeCloseTo(0, 5);
  const settled = renderer.render.mock.calls.length;
  act(() => vi.advanceTimersByTime(5000));
  expect(renderer.render).toHaveBeenCalledTimes(settled);
  unmount();
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const again = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(100));
  again.rerender(<MapScene {...props} snapshot={moved} />);
  act(() => vi.advanceTimersByTime(40));
  expect(at(layer().lights, 0).distanceTo(node("src/main.ts"))).toBeCloseTo(0, 5);
  again.unmount();
});

it("selects a seat from its label, frames it on request and follows its light as it moves", () => {
  const onSeatSelect = vi.fn();
  const { rerender } = render(<MapScene {...props} onSeatSelect={onSeatSelect} />);
  act(() => vi.advanceTimersByTime(100));
  const camera = renderer.render.mock.lastCall?.[1] as THREE.PerspectiveCamera;
  const home = camera.position.clone();
  fireEvent.click(screen.getByRole("button", { name: "GUIDO-1" }));
  expect(onSeatSelect).toHaveBeenCalledWith("GUIDO-1");
  // selecting from the stage doesn't move the camera
  rerender(<MapScene {...props} seat="GUIDO-1" />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.toArray()).toEqual(home.toArray());
  // the selector asks to frame it
  rerender(<MapScene {...props} seat="GUIDO-1" seatFocus={{ seat: "GUIDO-1", request: 1 }} />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.equals(home)).toBe(false);
  const framed = camera.position.clone();
  // it moves to main.ts: the camera moves with it, by the same step
  const moved: MapSnapshot = structuredClone(mapSnapshotFixture);
  moved.seats[0].calls = [{ tool: "Edit", detail: "", files: ["src/main.ts"], since: Date.now() }];
  moved.seats[0].recent = [{ file: "src/util.ts", at: 1 }];
  rerender(
    <MapScene
      {...props}
      snapshot={moved}
      seat="GUIDO-1"
      seatFocus={{ seat: "GUIDO-1", request: 1 }}
    />,
  );
  act(() => vi.advanceTimersByTime(10_000));
  const step = node("src/main.ts").sub(node("src/util.ts"));
  const travelled = camera.position.clone().sub(framed);
  travelled.toArray().forEach((value, axis) => {
    expect(value).toBeCloseTo(step.toArray()[axis] as number, 3);
  });
  // Home view lets it go
  rerender(<MapScene {...props} snapshot={moved} home={1} seatFocus={null} />);
  act(() => vi.advanceTimersByTime(100));
  expect(camera.position.equals(framed.clone().add(step))).toBe(false);
});

it("says in a file's tooltip who changed it (+/−), read it or both, and nothing else", () => {
  const main = nodes.find((n) => n.path === "src/main.ts");
  const util = nodes.find((n) => n.path === "src/util.ts");
  if (!main || !util) throw new Error("fixture node missing");
  const snapshot: MapSnapshot = {
    ...structuredClone(mapSnapshotFixture),
    conflicts: [
      { file: "src/main.ts", branches: ["a", "b"], shas: ["1".repeat(40), "2".repeat(40)] },
    ],
  };
  expect(fileTip(main, { snapshot, names: { "GUIDO-1": "GUIDO-1" } }).split("\n")).toEqual([
    "src/main.ts",
    "GUIDO-1 · changed +12 −3 (edit churn) · read",
  ]);
  expect(fileTip(util, { snapshot }).split("\n")).toEqual(["src/util.ts", "GUIDO-1 · read"]);
  snapshot.seats = [];
  expect(fileTip(util, { snapshot }).split("\n")).toEqual(["src/util.ts", "untouched"]);
});
