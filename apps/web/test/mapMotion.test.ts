import { type MapDelta, type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { applyDelta, layoutTree } from "../src/map/model.ts";
import {
  arcPoint,
  emptyMotion,
  flowStyle,
  type MotionEvent,
  motionDelta,
  reconcileMotion,
  sampleMotion,
} from "../src/map/motion.ts";

const nodes = layoutTree(mapSnapshotFixture.tree);
describe("map call motion", () => {
  it("ports the prototype's payload bands", () => {
    expect([99, 100, 999, 1000, 3999, 4000].map(flowStyle)).toEqual([
      { count: 1, size: 3.6 },
      { count: 2, size: 5.2 },
      { count: 2, size: 5.2 },
      { count: 3, size: 7 },
      { count: 3, size: 7 },
      { count: 4, size: 9 },
    ]);
  });
  it("animates the fixture's writes, edits and message without replaying snapshot activity", () => {
    let state = emptyMotion();
    let snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
    expect(sampleMotion(state, 3000).particles).toEqual([]);
    for (const delta of mapDeltaFixture) {
      state = motionDelta(state, { delta, at: 3000 }, snapshot, nodes);
      snapshot = applyDelta(snapshot, delta, 3000) ?? { ...snapshot, seq: delta.seq };
    }
    expect(state.particles.map((p) => p.kind)).toEqual(["write", "add", "remove"]);
    expect(state.arcs[0]).toMatchObject({
      from: "GUIDO-1",
      to: "RETRO-1",
      kind: "review",
      count: 1,
    });
    expect(sampleMotion(state, 10_000)).toMatchObject({ particles: [], arcs: [], glows: [] });
  });
  it("flows successful read payloads into the agent and hub payloads through HUB", () => {
    const end: MapDelta = {
      seq: 1,
      type: "call.end",
      seat: "GUIDO-1",
      files: ["src/util.ts"],
      resultTok: 1000,
      error: false,
      refused: false,
      why: null,
      tests: null,
    };
    const read = motionDelta(emptyMotion(), { delta: end, at: 3000 }, mapSnapshotFixture, nodes);
    expect(read.particles).toHaveLength(3);
    expect(read.particles[0].from).toEqual(nodes.find((n) => n.path === "src/util.ts")?.position);
    expect(
      motionDelta(
        emptyMotion(),
        { delta: { ...end, error: true }, at: 3000 },
        mapSnapshotFixture,
        nodes,
      ).particles,
    ).toEqual([]);
    const start: MapDelta = {
      seq: 2,
      type: "call.start",
      seat: "GUIDO-1",
      tool: "mcp__mc__status",
      detail: "status",
      files: [],
    };
    const hub = motionDelta(read, { delta: start, at: 4000 }, mapSnapshotFixture, nodes);
    expect(hub.particles.filter((p) => p.kind === "hub")).toHaveLength(1);
    const returned = motionDelta(
      hub,
      { delta: { ...end, seq: 3, files: [] }, at: 4500 },
      mapSnapshotFixture,
      nodes,
    );
    expect(returned.particles.filter((p) => p.kind === "hub")).toHaveLength(4);
    expect(returned.particles.at(-1)?.from).toEqual(hub.particles.at(-1)?.to);
  });
  it("caps sparks at five per direction, keeps the points budget bounded, and ignores duplicate frames", () => {
    const event = {
      delta: {
        seq: 1,
        type: "edit",
        seat: "GUIDO-1",
        file: "src/main.ts",
        add: 1000,
        rem: 9,
      } as MapDelta,
      at: 3000,
    };
    let state = motionDelta(emptyMotion(), event, mapSnapshotFixture, nodes);
    expect(state.particles.filter((p) => p.kind === "add")).toHaveLength(5);
    expect(state.particles.filter((p) => p.kind === "remove")).toHaveLength(2);
    expect(motionDelta(state, event, mapSnapshotFixture, nodes)).toBe(state);
    for (let seq = 2; seq < 100; seq++)
      state = motionDelta(
        state,
        { ...event, delta: { ...event.delta, seq } },
        mapSnapshotFixture,
        nodes,
      );
    expect(state.particles.length).toBeLessThanOrEqual(200);
    expect(sampleMotion(state, 9000).active).toBe(false);
  });
  it("groups a directed pair's burst for four seconds and ports the curved arc geometry", () => {
    const delta: MapDelta = {
      seq: 1,
      type: "message",
      from: "GUIDO-1",
      to: "CAPCOM",
      kind: "question",
      ticket: 7,
    };
    let s = motionDelta(emptyMotion(), { delta, at: 3000 }, mapSnapshotFixture, nodes);
    s = motionDelta(s, { delta: { ...delta, seq: 2 }, at: 3500 }, mapSnapshotFixture, nodes);
    expect(s.arcs).toHaveLength(1);
    expect(s.arcs[0].count).toBe(2);
    expect(sampleMotion(s, 7499).arcs).toHaveLength(1);
    expect(sampleMotion(s, 7500).arcs).toEqual([]);
    expect(arcPoint([0, 0, 0], [10, 0, 0], 0)).toEqual([0, 0, 0]);
    expect(arcPoint([0, 0, 0], [10, 0, 0], 1)).toEqual([10, 0, 0]);
    expect(arcPoint([0, 0, 0], [10, 0, 0], 0.5)).toEqual([5, 4.75, 0]);
  });
});

it("replaces cached calls and drops departed seats and completion times from old runs", () => {
  const snapshot = structuredClone(mapSnapshotFixture);
  const state = emptyMotion();
  state.calls = {
    "GUIDO-1": [{ tool: "ambiguous", detail: "old", files: ["src/util.ts"], since: 0 }],
    departed: snapshot.seats[0].calls,
  };
  state.ended = { "GUIDO-1": 1, departed: 2 };
  snapshot.seats[0].since = 3000;
  const next = reconcileMotion(state, snapshot, nodes, 4000);
  expect(next.calls).toEqual(Object.fromEntries(snapshot.seats.map((s) => [s.seat, s.calls])));
  expect(next.ended).toEqual({});
});
it("keeps unresolved effects bounded and resolves each once at its original time", () => {
  const snapshot = structuredClone(mapSnapshotFixture);
  const event = {
    delta: {
      type: "edit",
      seq: 1,
      seat: "NEW-1",
      file: "branch/new.ts",
      add: 8,
      rem: 0,
    } as MapDelta,
    at: 3000,
  };
  let state = motionDelta(emptyMotion(), event, snapshot, nodes);
  expect(state.pending).toHaveLength(1);
  expect(state.particles).toHaveLength(0);
  snapshot.seats.push({ ...snapshot.seats[0], seat: "NEW-1" });
  const layout = layoutTree([{ path: "branch/new.ts", lines: 1 }], nodes);
  state = reconcileMotion(state, snapshot, layout, 3300);
  expect(state.pending).toHaveLength(0);
  expect(state.particles).toHaveLength(1);
  expect(state.particles[0].at).toBe(3000);
  expect(reconcileMotion(state, snapshot, layout, 3400).particles).toHaveLength(1);
  expect(motionDelta(state, event, snapshot, layout)).toBe(state);
  const expired = reconcileMotion(
    motionDelta(emptyMotion(), event, snapshot, nodes),
    snapshot,
    layout,
    4000,
  );
  expect(expired.particles).toHaveLength(0);
  expect(expired.glows[0].at).toBe(3000); // Glow is still alive; the spark is not.
  const stale = reconcileMotion(
    motionDelta(emptyMotion(), event, snapshot, nodes),
    snapshot,
    layout,
    6000,
  );
  expect(stale.pending).toHaveLength(0);
  expect(stale.glows).toHaveLength(0);
  let bounded = emptyMotion();
  for (let seq = 1; seq <= 100; seq++)
    bounded = motionDelta(bounded, { ...event, delta: { ...event.delta, seq } }, snapshot, nodes);
  expect(bounded.pending.length).toBeLessThanOrEqual(64);
});
it("keeps a waiting read's call metadata when the refetch has already removed the call", () => {
  const snapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats[0].calls = [
    { tool: "Read", detail: "new", files: ["branch/new.ts"], since: 2000 },
  ];
  const event: MotionEvent = {
    delta: {
      type: "call.end",
      seq: 1,
      seat: "GUIDO-1",
      files: ["branch/new.ts"],
      resultTok: 10,
      error: false,
      refused: false,
      why: null,
      tests: null,
    },
    at: 3000,
    calls: structuredClone(snapshot.seats[0]?.calls),
  };
  let state = motionDelta(emptyMotion(), event, snapshot, nodes);
  snapshot.seats[0].calls = [];
  state = reconcileMotion(state, snapshot, nodes, 3100);
  const layout = layoutTree([{ path: "branch/new.ts", lines: 1 }], nodes);
  state = reconcileMotion(state, snapshot, layout, 3200);
  expect(state.particles).toHaveLength(1);
  expect(state.particles[0]).toMatchObject({ kind: "read", at: 3000 });
});

it("does not let a late resolved event replace a newer file glow", () => {
  const snapshot = structuredClone(mapSnapshotFixture);
  const delta: MapDelta = {
    type: "edit",
    seq: 1,
    seat: "GUIDO-1",
    file: "branch/new.ts",
    add: 8,
    rem: 0,
  };
  let state = motionDelta(emptyMotion(), { delta, at: 3000 }, snapshot, nodes);
  const layout = layoutTree([{ path: "branch/new.ts", lines: 1 }], nodes);
  state = motionDelta(state, { delta: { ...delta, seq: 2 }, at: 3400 }, snapshot, layout);
  state = reconcileMotion(state, snapshot, layout, 3400);
  expect(state.glows[0].at).toBe(3400);
  expect(state.particles.map((particle) => particle.at).sort()).toEqual([3000, 3400]);
});
