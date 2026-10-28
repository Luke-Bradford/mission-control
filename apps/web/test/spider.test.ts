import { expect, it } from "vitest";
import {
  frameFor,
  hubPoint,
  LOOPS_SPOKE,
  labelBox,
  placeLabels,
  presenceOf,
  SpiderSim,
  spokeAnchors,
  spokesFor,
} from "../src/comms/spider.ts";
import { crewRow, seatRow } from "./fixtures.ts";

const f = frameFor({ w: 360, h: 460 });
const centre = hubPoint(f, "centre");

it("gives each role a spoke round FLIGHT, built-in roles first and the loops last", () => {
  const spokes = spokesFor(
    [
      seatRow({ id: "flight-1", role: "FLIGHT", index: 0 }),
      crewRow({ id: "ebull-ta", index: 1 }),
      seatRow({ id: "retro-1", role: "RETRO", index: 2 }),
      seatRow({ id: "guido-2", role: "GUIDO", index: 4 }),
      seatRow({ id: "guido-1", role: "GUIDO", index: 3 }),
      seatRow({ id: "ops-1", role: "OPS", index: 5 }),
      seatRow({ id: "inco-1", role: "INCO", index: 6 }),
    ],
    "flight-1",
  );
  expect(spokes.map((s) => s.key)).toEqual(["GUIDO", "INCO", "RETRO", "OPS", LOOPS_SPOKE]);
  // Seats keep config order on their spoke; FLIGHT has none, it is the centre.
  expect(spokes[0]?.ids).toEqual(["guido-1", "guido-2"]);
  expect(spokes.flatMap((s) => s.ids)).not.toContain("flight-1");
  // Alternating sides: right of FLIGHT (|angle| < 90) then left, clear of CAPCOM and #crew.
  const right = (angle: number) => Math.cos((angle * Math.PI) / 180) > 0;
  expect(spokes.map((s) => right(s.angle))).toEqual([true, false, true, false, true]);
  for (const s of spokes) expect(Math.abs(Math.sin((s.angle * Math.PI) / 180))).toBeLessThan(0.8);
});

it("reads presence from the HUD state and any pause", () => {
  expect(presenceOf(seatRow({ hudState: "running" }))).toBe("running");
  expect(presenceOf(seatRow({ hudState: "idle" }))).toBe("idle");
  expect(presenceOf(seatRow({ hudState: "blocked" }))).toBe("idle");
  expect(presenceOf(seatRow({ hudState: "stopped" }))).toBe("stopped");
  expect(presenceOf(seatRow({ hudState: "running", paused: true }))).toBe("stopped");
  expect(
    presenceOf(seatRow({ crewPause: { seats: ["guido-1"], reason: "", at: 1, by: "operator" } })),
  ).toBe("stopped");
});

function targets(ids: string[]) {
  const spokes = spokesFor(
    ids.map((id, index) => seatRow({ id, index, role: id.split("-")[0]?.toUpperCase() })),
    "flight-1",
  );
  const anchors = spokeAnchors(spokes, f);
  return ids.map((id) => {
    const a = anchors.get(id) ?? centre;
    return { id, x: a.x, y: a.y, r: 6, pinned: false };
  });
}

it("keeps every position when the same nodes are synced again", () => {
  const sim = new SpiderSim();
  const nodes = targets(["guido-1", "inco-1", "retro-1"]);
  sim.sync(nodes, centre, false);
  for (let i = 0; i < 40; i++) sim.step(1 / 30);
  const before = nodes.map((n) => sim.position(n.id));
  sim.sync(
    nodes.map((n) => ({ ...n })),
    centre,
    false,
  );
  expect(nodes.map((n) => sim.position(n.id))).toEqual(before);
});

it("starts the first layout on the anchors and springs a later arrival out along its spoke", () => {
  const sim = new SpiderSim();
  const first = targets(["guido-1", "inco-1"]);
  sim.sync(first, centre, false);
  for (const n of first) expect(sim.position(n.id)).toEqual({ x: n.x, y: n.y });
  const next = targets(["guido-1", "inco-1", "retro-1"]);
  const retro = next[2] as (typeof next)[number];
  sim.sync(next, centre, false);
  const start = sim.position("retro-1") as { x: number; y: number };
  // Partway in from its anchor, towards FLIGHT.
  expect(Math.hypot(start.x - centre.x, start.y - centre.y)).toBeLessThan(
    Math.hypot(retro.x - centre.x, retro.y - centre.y),
  );
  for (let i = 0; i < 300; i++) sim.step(1 / 30);
  const settled = sim.position("retro-1") as { x: number; y: number };
  expect(Math.hypot(settled.x - retro.x, settled.y - retro.y)).toBeLessThan(0.5);
  expect(sim.energy()).toBeLessThan(0.5);
});

it("reports how far nodes moved, so the loop can rest once the picture settles", () => {
  const sim = new SpiderSim();
  sim.sync(targets(["guido-1"]), centre, false);
  // Already on its anchor: nothing moves, from the first step on.
  expect(sim.step(1 / 30)).toBe(0);
  sim.sync(targets(["guido-1", "inco-1"]), centre, false);
  // The arrival springs out along its spoke, then comes to rest.
  expect(sim.step(1 / 30)).toBeGreaterThan(0.1);
  let steps = 0;
  while (sim.step(1 / 30) >= 0.05 && steps < 1_000) steps++;
  expect(steps).toBeLessThan(200);
});

it("spreads the spokes wider when the web is stretched tall", () => {
  const rows = ["guido-1", "inco-1", "retro-1", "fao-1"].map((id, index) =>
    seatRow({ id, index, role: id.split("-")[0]?.toUpperCase() }),
  );
  const flat = spokesFor(rows, "flight-1", 1);
  const tall = spokesFor(rows, "flight-1", 1.5);
  const spread = (spokes: typeof flat) =>
    Math.abs((spokes[0]?.angle ?? 0) - (spokes[2]?.angle ?? 0));
  expect(spread(tall)).toBeGreaterThan(spread(flat));
  const f2 = frameFor({ w: 360, h: 700 });
  expect(f2.ry / f2.rx).toBeCloseTo(1.5, 1);
});

it("puts every node straight on its anchor when motion is reduced", () => {
  const sim = new SpiderSim();
  sim.sync(targets(["guido-1"]), centre, true);
  const next = targets(["guido-1", "inco-1"]);
  sim.sync(next, centre, true);
  for (const n of next) expect(sim.position(n.id)).toEqual({ x: n.x, y: n.y });
});

it("holds pinned nodes still and pushes overlapping ones apart", () => {
  const sim = new SpiderSim();
  sim.sync(
    [
      { id: "hub", x: 100, y: 100, r: 10, pinned: true },
      { id: "seat", x: 102, y: 100, r: 6, pinned: false },
    ],
    { x: 100, y: 100 },
    true,
  );
  expect(sim.position("hub")).toEqual({ x: 100, y: 100 });
  const seat = sim.position("seat") as { x: number; y: number };
  expect(Math.hypot(seat.x - 100, seat.y - 100)).toBeGreaterThanOrEqual(10 + 6 + 9 - 0.01);
});

it("shares a spoke out among the seats present, keeping the spoke where it was", () => {
  const all = spokesFor(
    [seatRow({ id: "guido-1", index: 0 }), seatRow({ id: "guido-2", index: 1 })],
    "flight-1",
  );
  const both = spokeAnchors(all, f);
  const one = spokeAnchors(all, f, (id) => id === "guido-2");
  expect(one.has("guido-1")).toBe(false);
  expect(one.get("guido-2")).not.toEqual(both.get("guido-2"));
  expect(all[0]?.angle).toBe(
    spokesFor([seatRow({ id: "guido-2", index: 1 })], "flight-1")[0]?.angle,
  );
});

it("nudges a full name to a clear side instead of overlapping another name or node", () => {
  const nodes = [
    { id: "a", at: { x: 100, y: 100 }, r: 6, text: "GUIDO-CX", prefer: "below" as const },
    { id: "b", at: { x: 110, y: 122 }, r: 6, text: "RETRO-CX", prefer: "below" as const },
  ];
  const sides = placeLabels(nodes, f);
  // a's name would land on b's node below it, so it goes elsewhere.
  expect(sides.get("a")).not.toBe("below");
  const boxes = nodes.map((n) => labelBox(n.at, n.r, n.text, sides.get(n.id) ?? "below"));
  const discs = nodes.map((n) => ({
    x0: n.at.x - n.r,
    y0: n.at.y - n.r,
    x1: n.at.x + n.r,
    y1: n.at.y + n.r,
  }));
  const apart = (p: (typeof boxes)[number], q: (typeof boxes)[number]) =>
    p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0;
  expect(apart(boxes[0] as never, boxes[1] as never)).toBe(true);
  for (const box of boxes) for (const disc of discs) expect(apart(box, disc)).toBe(true);
});

it("keeps links short: CAPCOM and #crew sit close above and below FLIGHT, inside the web", () => {
  for (const where of ["above", "below"] as const) {
    const p = hubPoint(f, where);
    expect(p.x).toBe(centre.x);
    expect(Math.abs(p.y - centre.y)).toBeLessThan(f.ry * 0.5);
  }
});
