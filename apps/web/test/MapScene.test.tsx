import { type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
