import { afterEach, beforeEach, expect, it } from "vitest";
import { createCrewMap, type MapParticipant, type MapSnapshot } from "../src/comms/crewMap.ts";
import { type DomHarness, installMapDom } from "./crewMapDom.ts";

let dom: DomHarness;
let host: HTMLElement;
beforeEach(() => {
  dom = installMapDom();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  dom.restore();
});

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const seat = (id: string, over: Partial<MapParticipant> = {}): MapParticipant => ({
  id,
  label: id.toUpperCase(),
  role: "server",
  kind: "seat",
  state: "idle",
  ...over,
});
const snapshot = (over: Partial<MapSnapshot> = {}): MapSnapshot => ({
  now: NOW,
  source: { kind: "live", label: "hub", ok: true },
  participants: [seat("flight-1", { role: "flight" }), seat("guido-1")],
  messages: [],
  waits: [],
  olderWaits: 0,
  ...over,
});
const settle = async () => {
  await new Promise((r) => setTimeout(r, 5));
  dom.frames(3);
};

const seatOf = (map: ReturnType<typeof createCrewMap>, id: string) => {
  const found = map._probe().seats.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no seat ${id}`);
  return found;
};
const button = (id: string) => {
  const node = host.querySelector<HTMLElement>(`.cm-seat[data-seat="${id}"]`);
  if (!node) throw new Error(`no button for ${id}`);
  return node;
};
/** A pointer event as the browser sends it; jsdom has no PointerEvent. */
function pointer(type: string, target: Element, x: number, y: number, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    ...init,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}
const drag = (
  map: ReturnType<typeof createCrewMap>,
  id: string,
  dx: number,
  dy: number,
  alt = true,
) => {
  const from = seatOf(map, id);
  const node = button(id);
  pointer("pointerdown", node, from.x, from.y);
  pointer("pointermove", node, from.x + dx / 2, from.y + dy / 2);
  pointer("pointermove", node, from.x + dx, from.y + dy);
  pointer("pointerup", node, from.x + dx, from.y + dy, { altKey: alt });
};

it("names each seat's state, context against its own limit, and the tool running", async () => {
  const map = createCrewMap(host);
  map.update(
    snapshot({
      participants: [
        seat("flight-1", { role: "flight", state: "running", contextTokens: 90_000 }),
        seat("guido-1", {
          state: "running",
          contextTokens: 90_000,
          contextLimit: 200_000,
          liveTool: "Edit",
          ticket: "mission-control#12",
        }),
        seat("guido-2", { state: "idle", contextTokens: 60_000 }),
        seat("guido-3", { state: "stopped" }),
        seat("guido-4", { state: "idle", hold: "stalled" }),
        seat("guido-5", { state: "idle", hold: "blocked" }),
        seat("guido-6", { state: "idle", hold: "error" }),
      ],
    }),
  );
  await settle();
  const working = seatOf(map, "guido-1");
  expect(working).toMatchObject({ state: "running", ctx: 90_000, lim: 200_000, tool: "Edit" });
  expect(working.sub).toMatch(/^working.*#12.*running Edit$/);
  expect(seatOf(map, "guido-2")).toMatchObject({ ctx: 60_000, lim: 150_000 });
  expect(seatOf(map, "guido-2").sub).toMatch(/^idle/);
  expect(seatOf(map, "guido-3")).toMatchObject({ state: "stopped", sub: "stopped" });
  for (const [id, word] of [
    ["guido-4", "stalled"],
    ["guido-5", "blocked"],
    ["guido-6", "error"],
  ] as const) {
    expect(seatOf(map, id).sub).toMatch(new RegExp(`^${word}`));
    expect(button(id).className).toContain("cm-is-hold");
    expect(button(id).className).not.toContain("cm-is-stopped");
  }
  expect(button("guido-3").className).not.toContain("cm-is-hold");
  expect(button("guido-1").getAttribute("aria-label")).toContain("90K of the 200K working limit");
  expect(button("guido-2").getAttribute("aria-label")).toContain("60K of the 150K working limit");
  map.destroy();
});

it("sends a light from sender to receiver in the sender's colour, and keeps the lane warm", async () => {
  const map = createCrewMap(host, { catchUp: false });
  map.update(snapshot());
  await settle();
  map.update(
    snapshot({
      messages: [{ id: "comms:1", at: NOW - 500, from: "guido-1", to: "flight-1", text: "done" }],
    }),
  );
  const [light] = map._probe().comets;
  expect(light).toMatchObject({ from: "guido-1", to: "flight-1", color: map.colorOf("guido-1") });
  const from = seatOf(map, "guido-1");
  const to = seatOf(map, "flight-1");
  expect(Math.hypot(light.start.x - from.x, light.start.y - from.y)).toBeLessThan(2);
  expect(Math.hypot(light.end.x - to.x, light.end.y - to.y)).toBeLessThan(2);
  expect(map.colorOf("guido-1")).not.toBe(map.colorOf("flight-1"));
  dom.frames(200);
  expect(map._probe().comets).toHaveLength(0);
  const lane = map._probe().lanes.find((l) => l.from === "guido-1" && l.to === "flight-1");
  expect(lane?.heat ?? 0).toBeGreaterThan(0);
  map.destroy();
});

it("shows no light under reduced motion, but the lane is still warm", async () => {
  dom.setReducedMotion(true);
  const map = createCrewMap(host, { catchUp: false });
  map.update(snapshot());
  await settle();
  map.update(
    snapshot({
      messages: [{ id: "comms:1", at: NOW - 500, from: "guido-1", to: "flight-1", text: "done" }],
    }),
  );
  expect(map._probe().comets).toHaveLength(0);
  expect(map._probe().lanes[0]?.heat ?? 0).toBeGreaterThan(0);
  dom.frames(5);
  expect(map._state().tier).toBe("still");
  expect(dom.pending()).toBe(0);
  map.destroy();
});

it("draws nothing in a hidden document, and wakes when it shows again", async () => {
  const map = createCrewMap(host, { catchUp: false });
  map.update(snapshot());
  await settle();
  dom.setHidden(true);
  dom.frames(2);
  expect(map._state().halted).toBe(true);
  expect(dom.pending()).toBe(0);
  map.update(
    snapshot({
      messages: [{ id: "comms:1", at: NOW - 500, from: "guido-1", to: "flight-1", text: "done" }],
    }),
  );
  expect(dom.pending()).toBe(0);
  dom.setHidden(false);
  expect(map._state().halted).toBe(false);
  expect(dom.pending()).toBe(1);
  map.destroy();
});

it("asks for a frame only while something moves", async () => {
  const map = createCrewMap(host, { catchUp: false });
  map.update(snapshot());
  await settle();
  dom.frames(20);
  // an idle crew falls to a timer, not a frame loop
  expect(["slow", "still"]).toContain(map._state().tier);
  expect(dom.pending()).toBe(0);
  map.destroy();
  dom.frames(2);
  expect(dom.pending()).toBe(0);
});

it("opens a seat's conversation on a click, and not at the end of a drag", async () => {
  const opened: unknown[] = [];
  const map = createCrewMap(host, { onOpenConversation: (selection) => opened.push(selection) });
  map.update(snapshot());
  await settle();
  button("guido-1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(opened).toEqual([{ type: "seat", id: "guido-1" }]);
  expect(button("guido-1").getAttribute("aria-pressed")).toBe("true");
  drag(map, "guido-1", 40, 20, false);
  button("guido-1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(opened).toHaveLength(1);
  map.destroy();
});

it("keeps a dragged seat where it was dropped, separately for the panel and the full view", async () => {
  const pins: unknown[] = [];
  const map = createCrewMap(host, { onPinsChange: (kept) => pins.push(structuredClone(kept)) });
  map.update(snapshot());
  await settle();
  const home = seatOf(map, "guido-1");
  drag(map, "guido-1", 50, 30);
  dom.frames(40);
  const moved = seatOf(map, "guido-1");
  expect(moved.x).toBeGreaterThan(home.x + 20);
  expect(map.getPins().panel?.["guido-1"]).toBeDefined();
  expect(map.getPins().full?.["guido-1"]).toBeUndefined();
  map.setView("full");
  dom.resize(900, 500);
  dom.frames(2);
  expect(map.getPins().panel?.["guido-1"]).toBeDefined();
  drag(map, "guido-1", -40, 25);
  dom.frames(40);
  expect(map.getPins().full?.["guido-1"]).toBeDefined();
  expect(map.getPins().full?.["guido-1"]).not.toEqual(map.getPins().panel?.["guido-1"]);
  expect(pins.length).toBeGreaterThanOrEqual(2);
  map.destroy();
});

it("springs a seat back home when it is dropped without Alt", async () => {
  const map = createCrewMap(host);
  map.update(snapshot());
  await settle();
  const home = seatOf(map, "guido-1");
  drag(map, "guido-1", 50, 30, false);
  dom.frames(120);
  const after = seatOf(map, "guido-1");
  expect(Math.hypot(after.x - home.x, after.y - home.y)).toBeLessThan(2);
  expect(map.getPins().panel?.["guido-1"]).toBeUndefined();
  map.destroy();
});

it("lists every seat in the roster and keeps the list scrollable", async () => {
  const map = createCrewMap(host);
  map.update(
    snapshot({
      participants: [
        seat("flight-1", { role: "flight" }),
        ...Array.from({ length: 20 }, (_, i) => seat(`guido-${i + 1}`)),
      ],
    }),
  );
  await settle();
  expect(host.querySelectorAll(".cm-roster li")).toHaveLength(21);
  map.destroy();
});

/** Every seat of a busy crew: FLIGHT, the operator, and `n` seats of every role. */
const busyCrew = (n: number): MapParticipant[] => {
  const roles = ["server", "web", "review", "plan"] as const;
  return [
    seat("flight-1", { role: "flight", state: "running", contextTokens: 80_000 }),
    { id: "CAPCOM", label: "CAPCOM", role: "operator", kind: "operator", state: "unknown" },
    ...Array.from({ length: n }, (_, i) =>
      seat(`seat-${i + 1}`, {
        role: roles[i % roles.length],
        state: i % 3 === 0 ? "running" : i % 3 === 1 ? "idle" : "stopped",
        contextTokens: 20_000 + i * 5_000,
        liveTool: i % 3 === 0 ? "Bash" : null,
        ticket: i % 3 === 0 ? `mission-control#${2000 + i}` : null,
      }),
    ),
  ];
};
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The panel stage is as wide as the Comms column (380 to 420) and 356 high; the full stage is the
// window less the 360 px side column and the header and chart bands.
it.each([
  ["panel", 420, 356],
  ["full", 1560, 700],
  ["full", 2200, 905],
])(
  "keeps twenty seats' name tags clear of each other and of other seats, %s %i x %i",
  async (view, width, height) => {
    dom.restore();
    dom = installMapDom({ width, height });
    const map = createCrewMap(host, { view: view as "panel" | "full" });
    map.update(snapshot({ participants: busyCrew(20) }));
    await settle();
    const { labels, dots } = map._probe();
    expect(labels.length).toBe(22);
    for (const [i, a] of labels.entries())
      for (const b of labels.slice(i + 1))
        expect(overlap(a, b), `${a.id} over ${b.id}`).toBe(false);
    for (const label of labels)
      for (const dot of dots) {
        if (dot.id === label.id) continue;
        const box = { x: dot.x - dot.r, y: dot.y - dot.r, w: dot.r * 2, h: dot.r * 2 };
        expect(overlap(label, box), `${label.id} over the seat ${dot.id}`).toBe(false);
      }
    map.destroy();
  },
);

it("names the fullest seat in the strip as a button that opens its conversation", async () => {
  const opened: unknown[] = [];
  const map = createCrewMap(host, { onOpenConversation: (selection) => opened.push(selection) });
  map.update(
    snapshot({
      participants: [
        seat("flight-1", { role: "flight", state: "running", contextTokens: 10_000 }),
        seat("guido-1", { state: "running", contextTokens: 120_000 }),
      ],
    }),
  );
  await settle();
  const name = host.querySelector<HTMLButtonElement>(".cm-strip button.cm-name");
  expect(name?.textContent).toBe("GUIDO-1");
  name?.click();
  expect(opened).toEqual([{ type: "seat", id: "guido-1" }]);
  // the hidden tables are visually hidden the way the rest of the app does it
  expect(host.querySelector(".cm-tables")?.classList.contains("sr-only")).toBe(true);
  map.destroy();
});

// A normal crew: FLIGHT, CAPCOM and eight seats. Every dot has its own place, in every view.
it.each([
  ["panel", 300, 330],
  ["panel", 360, 356],
  ["panel", 420, 356],
  ["full", 1560, 700],
  ["full", 2200, 905],
])("gives CAPCOM and every seat its own place, %s %i x %i", async (view, width, height) => {
  dom.restore();
  dom = installMapDom({ width, height });
  const map = createCrewMap(host, { view: view as "panel" | "full" });
  // CAPCOM and FLIGHT talk the most, so their dots are the biggest
  const talk = Array.from({ length: 60 }, (_, i) => ({
    id: `t${i}`,
    at: NOW - 60_000 - i * 1000,
    from: i % 2 ? "CAPCOM" : "flight-1",
    to: i % 2 ? "flight-1" : "CAPCOM",
    text: "x",
  }));
  map.update(snapshot({ participants: busyCrew(8), messages: talk }));
  await settle();
  const { dots, labels } = map._probe();
  expect(dots.map((d) => d.id)).toContain("CAPCOM");
  // a seat's context ring sits about 12 px outside its dot: two dots keep that apart
  const ring = 12;
  for (const [i, a] of dots.entries())
    for (const b of dots.slice(i + 1))
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} on ${b.id}`).toBeGreaterThan(
        a.r + b.r + ring,
      );
  // CAPCOM's name tag is not hidden by a seat either
  for (const label of labels)
    for (const dot of dots) {
      if (dot.id === label.id) continue;
      const box = { x: dot.x - dot.r, y: dot.y - dot.r, w: dot.r * 2, h: dot.r * 2 };
      expect(overlap(label, box), `${label.id} over the seat ${dot.id}`).toBe(false);
    }
  map.destroy();
});

it("paints every seat's name on the small map, with its context and a stuck seat's word", async () => {
  dom.restore();
  dom = installMapDom({ width: 420, height: 356 });
  const map = createCrewMap(host);
  const crew = busyCrew(20);
  crew.push(seat("guido-30", { state: "idle", hold: "blocked", contextTokens: 30_000 }));
  map.update(snapshot({ participants: crew }));
  await settle();
  const names: string[] = [];
  for (const node of host.querySelectorAll<HTMLElement>(".cm-seat")) {
    const tag = node.querySelector<HTMLElement>(".cm-lab");
    expect(tag?.hidden, `${node.dataset.seat} has no tag`).toBe(false);
    const text = tag?.firstChild?.nodeValue ?? "";
    expect(text, `${node.dataset.seat} has no name`).not.toBe("");
    names.push(text);
  }
  // no two seats wear the same short name
  expect(new Set(names).size).toBe(names.length);
  // a stopped seat keeps its name too
  expect(button("seat-3").querySelector<HTMLElement>(".cm-lab")?.hidden).toBe(false);
  // a crowded map keeps the name on the tag and the figure in the Seats list, under the same name
  expect(host.querySelector('.cm-roster li button[aria-label^="SEAT-2,"]')?.getAttribute("aria-label")).toMatch(/context 25K/);
  expect(button("guido-30").querySelector(".cm-lab small")?.textContent).toBe("blocked");
  map.destroy();
});
