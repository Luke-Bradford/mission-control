import { type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { orbPlacement } from "../src/map/agents.ts";
import { renderer } from "./mapRendererMock.ts";

const { MapScene } = await import("../src/map/MapScene.tsx");

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
  for (const severity of ["Critical", "Important", "Minor"])
    expect(screen.getByText(`▲ ${severity}`)).toBeTruthy();
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
    events.push({ delta, at: Date.now(), snapshot });
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
  fireEvent.click(screen.getByRole("button", { name: /GUIDO-1 · #7 · reading/ }));
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
  const oldLabel = screen.getByRole("button", { name: /GUIDO-1 · #7 · reading/ });
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
