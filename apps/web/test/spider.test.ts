import { expect, it } from "vitest";
import {
  frameFor,
  hubPoint,
  LOOPS_SPOKE,
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
  for (let i = 0; i < 40; i++) sim.step(1 / 30, i / 30, true);
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
  for (let i = 0; i < 300; i++) sim.step(1 / 30, i / 30, false);
  const settled = sim.position("retro-1") as { x: number; y: number };
  expect(Math.hypot(settled.x - retro.x, settled.y - retro.y)).toBeLessThan(0.5);
  expect(sim.energy()).toBeLessThan(0.5);
});

it("drifts a few pixels round each anchor and never leaves it", () => {
  const sim = new SpiderSim();
  const nodes = targets(["guido-1"]);
  sim.sync(nodes, centre, false);
  const anchor = nodes[0] as (typeof nodes)[number];
  let furthest = 0;
  for (let i = 0; i < 600; i++) {
    sim.step(1 / 30, i / 30, true);
    const p = sim.position("guido-1") as { x: number; y: number };
    furthest = Math.max(furthest, Math.hypot(p.x - anchor.x, p.y - anchor.y));
  }
  expect(furthest).toBeGreaterThan(0.5);
  expect(furthest).toBeLessThan(6);
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
