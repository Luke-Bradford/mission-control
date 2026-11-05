import { expect, it } from "vitest";
import {
  fitName,
  linkPath,
  MIN_ROW,
  type RailGroup,
  railLayout,
  sideOfGroups,
} from "../src/comms/rails.ts";

/** `n` seats in groups of up to three, ids `s1`..`sn`. */
function crew(n: number): RailGroup[] {
  const groups: RailGroup[] = [];
  for (let i = 0; i < n; i += 3) {
    const ids = Array.from({ length: Math.min(3, n - i) }, (_, k) => `s${i + k + 1}`);
    groups.push({ key: `R${i / 3}`, ids, header: ids.length > 1 });
  }
  return groups;
}

const HUBS = ["capcom", "flight", "crew"] as const;

it.each([1, 3, 9, 20, 50])("places every one of %i seats once, in its own row", (n) => {
  const layout = railLayout(crew(n), { w: 360, h: 420 }, HUBS, 8);
  const seats = [...layout.seats.values()];
  expect(seats).toHaveLength(n);
  expect(layout.rowH).toBeGreaterThanOrEqual(MIN_ROW);
  for (const side of ["left", "right"] as const) {
    const ys = seats
      .filter((s) => s.side === side)
      .map((s) => s.y)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++)
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(layout.rowH - 0.01);
  }
  for (const s of seats) {
    expect(s.y).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(layout.h);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(layout.w);
  }
});

it("keeps 50 seats at the minimum row and grows the chart to scroll, instead of squeezing", () => {
  const layout = railLayout(crew(50), { w: 360, h: 420 }, HUBS, 8);
  expect(layout.rowH).toBe(MIN_ROW);
  expect(layout.h).toBeGreaterThan(420);
  const full = railLayout(crew(50), { w: 1920, h: 900 }, HUBS, 20);
  expect(full.h).toBeLessThanOrEqual(900);
  expect(full.rowH).toBeGreaterThanOrEqual(MIN_ROW);
});

it("seats the same seats on the same side at every size", () => {
  const small = railLayout(crew(20), { w: 360, h: 420 }, HUBS, 8);
  const big = railLayout(crew(20), { w: 2400, h: 1200 }, HUBS, 20);
  for (const [id, seat] of small.seats) expect(big.seats.get(id)?.side).toBe(seat.side);
  // And in the same order down each rail.
  const order = (l: typeof small, side: "left" | "right") =>
    [...l.seats]
      .filter(([, s]) => s.side === side)
      .sort(([, a], [, b]) => a.y - b.y)
      .map(([id]) => id);
  expect(order(big, "left")).toEqual(order(small, "left"));
  expect(order(big, "right")).toEqual(order(small, "right"));
});

it("balances the rails and keeps a role's seats together on one side", () => {
  const groups = crew(20);
  const sides = sideOfGroups(groups);
  const count = { left: 0, right: 0 };
  for (const g of groups) count[sides.get(g.key) as "left" | "right"] += g.ids.length;
  expect(Math.abs(count.left - count.right)).toBeLessThanOrEqual(3);
  const layout = railLayout(groups, { w: 800, h: 600 }, HUBS, 12);
  for (const g of groups) {
    const on = new Set(g.ids.map((id) => layout.seats.get(id)?.side));
    expect(on.size).toBe(1);
  }
});

it("puts CAPCOM, FLIGHT and #crew on the centre line, top to bottom", () => {
  const layout = railLayout(crew(9), { w: 500, h: 500 }, HUBS, 8);
  const [capcom, flight, crewHub] = HUBS.map((id) => layout.hubs.get(id));
  expect(capcom?.x).toBe(250);
  expect(flight?.x).toBe(250);
  expect(crewHub?.x).toBe(250);
  expect((capcom?.y as number) < (flight?.y as number)).toBe(true);
  expect((flight?.y as number) < (crewHub?.y as number)).toBe(true);
});

it("handles an empty crew and one seat", () => {
  expect(railLayout([], { w: 360, h: 420 }, HUBS, 8).seats.size).toBe(0);
  const one = railLayout(
    [{ key: "FLIGHT", ids: ["a"], header: false }],
    { w: 360, h: 420 },
    HUBS,
    8,
  );
  expect(one.seats.get("a")?.side).toBe("left");
});

it("shortens a name to fit with an ellipsis, and leaves a short one alone", () => {
  expect(fitName("GUIDO-1", 200)).toBe("GUIDO-1");
  const cut = fitName("ebull-agent-long-name", 70);
  expect(cut.endsWith("…")).toBe(true);
  expect(cut.length).toBeLessThan("ebull-agent-long-name".length);
  expect(fitName("ab", 10)).toBe("…");
});

it("bows a link between two seats on one rail towards the centre", () => {
  const same = linkPath({ x: 80, y: 40 }, { x: 80, y: 200 }, 200);
  expect(same.d).toMatch(/^M80\.0 40\.0 /);
  expect(same.mid.x).toBeGreaterThan(80);
  const across = linkPath({ x: 80, y: 40 }, { x: 320, y: 200 }, 200);
  expect(across.mid.x).toBeCloseTo(200, 0);
  expect(across.at(0)).toEqual({ x: 80, y: 40 });
  expect(across.at(1)).toEqual({ x: 320, y: 200 });
});
