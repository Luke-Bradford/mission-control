import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";

type Props = Record<string, unknown>;
const seen: Props[] = [];
vi.mock("../src/map/MapTreemap.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/map/MapTreemap.tsx")>();
  const Original = original.MapTreemap as unknown as (props: Props) => ReactElement;
  return {
    ...original,
    MapTreemap: (props: Props) => {
      seen.push(props);
      return <Original {...props} />;
    },
  };
});

it("hands the treemap the same props across a 5 s clock tick, so it is not drawn again", () => {
  vi.useFakeTimers();
  try {
    const value: MapSnapshot = structuredClone(mapSnapshotFixture);
    value.tree = [
      { path: "src/a.ts", lines: 10 },
      { path: "src/b.ts", lines: 10 },
    ];
    const now = Date.now();
    value.seats[0].recent = [{ file: "src/a.ts", at: now - 60_000 }];
    value.seats[0].scope = {
      read: ["src/b.ts"],
      modified: [{ file: "src/a.ts", add: 3, rem: 1, source: "diff" }],
    };
    render(<CrewMapView snapshot={value} />);
    const before = seen.at(-1) as Props;
    const count = seen.length;
    act(() => vi.advanceTimersByTime(5_000));
    const after = seen.at(-1) as Props;
    // the page re-rendered for the tick, with the same props throughout
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      expect(Object.is(before[key], after[key]), key).toBe(true);
    expect(seen.length).toBeGreaterThan(count);
  } finally {
    vi.useRealTimers();
  }
});

it("draws the treemap without a lens, focus or focus links", () => {
  render(<CrewMapView snapshot={structuredClone(mapSnapshotFixture)} />);
  const props = seen.at(-1) as Props;
  for (const gone of ["lens", "focus", "focusLinks"]) expect(props).not.toHaveProperty(gone);
});
