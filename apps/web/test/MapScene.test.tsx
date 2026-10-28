import { type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { orbPlacement } from "../src/map/agents.ts";
import { renderer } from "./mapRendererMock.ts";

const { MapScene, fileTip } = await import("../src/map/MapScene.tsx");

import { applyDelta, layoutTree } from "../src/map/model.ts";
import type { MotionEvent } from "../src/map/motion.ts";

const nodes = layoutTree(mapSnapshotFixture.tree);
const props = {
  nodes,
  snapshot: mapSnapshotFixture,
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

it("keeps rotation static for reduced motion and renders named severity pins", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const snapshot = {
    ...mapSnapshotFixture,
    findings: ["Critical", "Important", "Minor"].map((severity) => ({
      ...mapSnapshotFixture.findings[0],
      severity: severity as "Critical" | "Important" | "Minor",
    })),
  };
  const { unmount } = render(<MapScene {...props} snapshot={snapshot} rotate />);
  act(() => vi.advanceTimersByTime(1000));
  expect(renderer.render).toHaveBeenCalledOnce();
  // one small mark per file, its words in the tooltip; a click opens the file
  const mark = screen.getByRole("button", { name: /^3 review findings on src\/main\.ts/ });
  expect(mark.textContent).toBe("▲");
  for (const severity of ["Critical", "Important", "Minor"])
    expect(mark.getAttribute("title")).toContain(`${severity} · line 12 · Empty input throws`);
  fireEvent.click(mark);
  expect(props.onSelect).toHaveBeenCalledWith("src/main.ts");
  // the agent's one fact line; its live state is the tooltip
  const label = screen.getByRole("button", {
    name: /^GUIDO-1 · #7 · 1 file · \+12 −3 \(churn\) · waiting on you$/,
  });
  // on the stage: facts only, churn as "~", waiting on you as an amber dot; the words are its
  // accessible name and tooltip
  expect(label.textContent).toBe("GUIDO-1 · #7 · 1 file · ~+12 −3");
  expect(label.querySelector(".map-waits-dot")).not.toBeNull();
  expect(label.getAttribute("title")).toContain("reading src/util.ts");
  expect(label.getAttribute("title")).toContain("~ edit churn");
  unmount();
});

it("provides a searchable-file fallback when WebGL is unavailable", () => {
  renderer.fail = true;
  render(<MapScene {...props} />);
  expect(screen.getByRole("status").textContent).toContain("Use file search");
});

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
it("releases labels, instance resources and geometries on seat removal and unmount", () => {
  const { rerender, unmount } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const watch = () => {
    const scene = submittedScene();
    const disposed: ReturnType<typeof vi.fn>[] = [];
    scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Line ||
        object instanceof THREE.Points
      ) {
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
  const oldLabel = screen.getByRole("button", {
    name: /^GUIDO-1 · #7 · 1 file · \+12 −3 \(churn\) · waiting on you$/,
  });
  const oldResources = watch();
  rerender(
    <MapScene {...props} snapshot={{ ...props.snapshot, seats: props.snapshot.seats.slice(1) }} />,
  );
  act(() => vi.advanceTimersByTime(40));
  expect(oldLabel.isConnected).toBe(false);
  for (const disposed of oldResources) expect(disposed).toHaveBeenCalledOnce();
  const labels = [...document.querySelectorAll(".map-orb-label, .map-arc, .map-marker")];
  expect(labels.length).toBeGreaterThan(0);
  const remaining = watch();
  unmount();
  for (const disposed of remaining) expect(disposed).toHaveBeenCalledOnce();
  for (const label of labels) expect(label.isConnected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("updates only animated file instances and reuses colour and projection scratch objects", () => {
  const { rerender } = render(<MapScene {...props} />);
  act(() => vi.advanceTimersByTime(40));
  const mesh = submittedScene().children.find(
    (object) => object instanceof THREE.InstancedMesh,
  ) as THREE.InstancedMesh;
  rerender(
    <MapScene
      {...props}
      events={[
        {
          delta: { type: "edit", seq: 1, seat: "GUIDO-1", file: "src/main.ts", add: 8, rem: 0 },
          at: Date.now(),
        },
      ]}
    />,
  );
  act(() => vi.advanceTimersByTime(40));
  const writes = vi.spyOn(mesh, "setMatrixAt");
  const colors = vi.spyOn(THREE.Color.prototype, "clone");
  const vectors = vi.spyOn(THREE.Vector3.prototype, "clone");
  act(() => vi.advanceTimersByTime(200));
  const fileIndex = nodes
    .filter((node) => node.count > 0)
    .findIndex((node) => node.path === "src/main.ts");
  expect(writes.mock.calls.length).toBeGreaterThan(0);
  expect([...new Set(writes.mock.calls.map(([index]) => index))]).toEqual([fileIndex]);
  expect(colors).not.toHaveBeenCalled();
  expect(vectors).not.toHaveBeenCalled();
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
  for (const label of document.querySelectorAll<HTMLElement>(".map-orb-label"))
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
  const label = () =>
    screen.getByRole("button", {
      name: /^GUIDO-1 · #7 · 1 file · \+12 −3 \(churn\) · waiting on you$/,
    });
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

it("says in a file's tooltip what it is, who changed or read it, and its findings and conflicts", () => {
  const node = nodes.find((n) => n.path === "src/main.ts");
  if (!node) throw new Error("fixture node missing");
  const snapshot: MapSnapshot = {
    ...structuredClone(mapSnapshotFixture),
    conflicts: [
      { file: "src/main.ts", branches: ["a", "b"], shas: ["1".repeat(40), "2".repeat(40)] },
    ],
  };
  expect(fileTip(node, { snapshot, names: { "GUIDO-1": "GUIDO-1" } }).split("\n")).toEqual([
    "src/main.ts",
    "GUIDO-1 +12 −3 (edit churn)",
    "▲ 1 review finding",
    "◆ conflict: a / b",
  ]);
  const util = nodes.find((n) => n.path === "src/util.ts");
  if (!util) throw new Error("fixture node missing");
  expect(fileTip(util, { snapshot }).split("\n")).toEqual([
    "src/util.ts",
    "GUIDO-1 read it",
    "GUIDO-1 is on it now",
  ]);
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
