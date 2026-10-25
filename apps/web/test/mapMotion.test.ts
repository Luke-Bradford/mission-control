import { type MapDelta, type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { applyDelta, layoutTree } from "../src/map/model.ts";
import { arcPoint, emptyMotion, flowStyle, motionDelta, sampleMotion } from "../src/map/motion.ts";

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
