import { mapSnapshotFixture } from "@mc/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderer } from "./mapRendererMock.ts";

const { MapScene } = await import("../src/map/MapScene.tsx");

import { layoutTree } from "../src/map/model.ts";

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
