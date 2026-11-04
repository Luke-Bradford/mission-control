import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CrewLane, LANE_KINDS, LANE_MINUTES, laneTokens } from "../src/overview/CrewLane.tsx";
import { MIN, NOW, seatRow } from "./fixtures.ts";
import { observedContextDigest } from "./overviewDensityFixtures.ts";

afterEach(cleanup);

/** The start of the minute NOW falls in: the lane's last bucket. */
const END = Math.floor(NOW / MIN) * MIN;
const lane = (
  spans: { kind: "turn" | "checks" | "lock" | "review"; from: number; to: number | null }[],
) => ({
  agentId: "guido-1",
  spans,
  ticks: [],
});
const rowWith = (minutes: [number, number][], over: Parameters<typeof seatRow>[0] = {}) =>
  seatRow({ index: 2, digest: observedContextDigest(null, null, minutes), ...over });
const view = (
  row: ReturnType<typeof seatRow>,
  spans: Parameters<typeof lane>[0] = [],
  max = 100,
) => {
  const result = render(
    <CrewLane row={row} name="GUIDO-1" lane={lane(spans)} now={NOW} max={max} />,
  );
  const svg = result.container.querySelector("svg") as SVGSVGElement;
  return {
    svg,
    cell: result.container.firstElementChild as HTMLElement,
    bars: [...svg.querySelectorAll<SVGRectElement>(".crew-lane-bar")],
    // the band rects have no class: the bars are the ones with a class
    bands: [...svg.querySelectorAll<SVGRectElement>("rect:not(.crew-lane-bar)")],
  };
};

describe("laneTokens", () => {
  it("is sixty minutes ending at the current minute, zero where nothing was recorded", () => {
    const values = laneTokens(
      observedContextDigest(null, null, [
        [END, 9],
        [END - 59 * MIN, 5],
        [END - 60 * MIN, 99],
        [END + MIN, 99],
      ]),
      NOW,
    );
    expect(values).toHaveLength(LANE_MINUTES);
    expect(values[59]).toBe(9);
    expect(values[0]).toBe(5);
    expect(values.reduce((a, b) => a + b, 0)).toBe(14);
    expect(laneTokens(null, NOW)).toEqual(Array(LANE_MINUTES).fill(0));
  });
});

describe("CrewLane", () => {
  it("draws one bar for each minute with tokens, at that minute's place and on the account's scale", () => {
    const { bars, cell } = view(
      rowWith([
        [END, 100],
        [END - 2 * MIN, 50],
        [END - 59 * MIN, 25],
        [END - 10 * MIN, 0],
      ]),
    );
    expect(cell.getAttribute("role")).toBe("cell");
    expect(cell.classList.contains("crew-lane")).toBe(true);
    // oldest first: minute 0, minute 57, minute 59; a minute without tokens has no bar
    expect(bars.map((bar) => bar.getAttribute("x"))).toEqual(["0.1", "57.1", "59.1"]);
    // the tallest minute fills the 24-unit bar area; the others are in proportion
    expect(bars.map((bar) => Number(bar.getAttribute("height")))).toEqual([6, 12, 24]);
    expect(bars.map((bar) => Number(bar.getAttribute("y")))).toEqual([18, 12, 0]);
    expect(bars.every((bar) => bar.getAttribute("width") === "0.8")).toBe(true);
    // the seat's colour, from its index
    expect(bars[0]?.getAttribute("fill")).toBe("var(--seat-3)");
  });

  it("draws a minute that is a sliver of the scale one unit tall, not invisible", () => {
    const { bars } = view(rowWith([[END, 1]]), [], 1_000_000);
    expect(Number(bars[0]?.getAttribute("height"))).toBe(1);
  });

  it("draws nothing for a seat with no digest or minutes outside the hour", () => {
    expect(view(seatRow({ digest: null })).bars).toHaveLength(0);
    expect(
      view(
        rowWith([
          [END - 61 * MIN, 500],
          [END + 5 * MIN, 500],
        ]),
      ).bars,
    ).toHaveLength(0);
  });

  it("paints a band for each kind of recorded work, with the kind's colour, across its minutes", () => {
    const { bands } = view(rowWith([]), [
      { kind: "turn", from: NOW - 30 * MIN, to: NOW - 20 * MIN },
      { kind: "checks", from: NOW - 20 * MIN, to: NOW - 10 * MIN },
      { kind: "lock", from: NOW - 10 * MIN, to: NOW - 5 * MIN },
      { kind: "review", from: NOW - 5 * MIN, to: NOW },
    ]);
    expect(bands.map((band) => band.getAttribute("fill"))).toEqual(
      LANE_KINDS.map((entry) => entry.color),
    );
    expect(bands.map((band) => Number(band.getAttribute("x")))).toEqual([30, 40, 50, 55]);
    expect(bands.map((band) => Number(band.getAttribute("width")))).toEqual([10, 10, 5, 5]);
    expect(bands.every((band) => band.getAttribute("y") === "27")).toBe(true);
  });

  it("clips a span that began before the hour to the lane's left edge and drops one that ended before it", () => {
    const { bands } = view(rowWith([]), [
      { kind: "turn", from: NOW - 90 * MIN, to: NOW - 50 * MIN },
      { kind: "checks", from: NOW - 120 * MIN, to: NOW - 61 * MIN },
    ]);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.getAttribute("x")).toBe("0");
    expect(bands[0]?.getAttribute("width")).toBe("10");
  });

  it("runs an open span to now", () => {
    const { bands } = view(rowWith([], { hudState: "running" }), [
      { kind: "turn", from: NOW - 15 * MIN, to: null },
    ]);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.getAttribute("x")).toBe("45");
    expect(bands[0]?.getAttribute("width")).toBe("15");
  });

  it("does not paint a parked seat's open turn as work, but still paints its other open and closed spans", () => {
    const parked = rowWith([], { hudState: "parked" });
    const { bands } = view(parked, [
      { kind: "turn", from: NOW - 40 * MIN, to: null },
      { kind: "turn", from: NOW - 50 * MIN, to: NOW - 45 * MIN },
      { kind: "review", from: NOW - 30 * MIN, to: null },
    ]);
    expect(bands.map((band) => band.getAttribute("fill"))).toEqual([
      "var(--accent)",
      "var(--think)",
    ]);
    expect(bands.map((band) => Number(band.getAttribute("x")))).toEqual([10, 30]);
  });

  it("paints the same open turn for a seat that is running", () => {
    const { bands } = view(rowWith([], { hudState: "running" }), [
      { kind: "turn", from: NOW - 40 * MIN, to: null },
    ]);
    expect(bands).toHaveLength(1);
  });

  it("leaves the label and the hover to say what the seat did: tokens, and the kinds of work in order", () => {
    const { svg } = view(
      rowWith([
        [END, 1200],
        [END - MIN, 800],
      ]),
      [
        { kind: "review", from: NOW - 5 * MIN, to: NOW },
        { kind: "turn", from: NOW - 30 * MIN, to: NOW - 20 * MIN },
        { kind: "turn", from: NOW - 15 * MIN, to: NOW - 10 * MIN },
      ],
    );
    const label = "GUIDO-1, last hour: 2.0k tokens · Review, Working";
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe(label);
    expect(svg.querySelector("title")?.textContent).toBe(label);
  });

  it("says there was no recorded work, and zero tokens, for a quiet hour", () => {
    const { svg } = view(rowWith([]));
    expect(svg.getAttribute("aria-label")).toBe("GUIDO-1, last hour: 0 tokens · no recorded work");
  });

  it("does not name a parked seat's dropped open turn in its label", () => {
    const { svg } = view(rowWith([], { hudState: "parked" }), [
      { kind: "turn", from: NOW - 40 * MIN, to: null },
    ]);
    expect(svg.getAttribute("aria-label")).toBe("GUIDO-1, last hour: 0 tokens · no recorded work");
  });
});
