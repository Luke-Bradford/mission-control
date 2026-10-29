import {
  MAP_RECENT_MS,
  type MapDelta,
  type MapSeat,
  type MapSnapshot,
  mapSnapshotFixture,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import { dockPosition, lightPlacement, seatTrail, stateLabel } from "../src/map/agents.ts";
import { applyDelta, layoutTree, type MapNode } from "../src/map/model.ts";

const seat = (): MapSeat => structuredClone(mapSnapshotFixture.seats[0]);
const line = (n: number): MapNode[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `f${i}`,
    parent: null,
    area: "",
    position: [i * 10, 0, 0] as [number, number, number],
    files: [`f${i}`],
    count: 1,
  }));

describe("map seat meaning", () => {
  it("names observed calls, thinking only during a running turn, and stalls", () => {
    const s = seat();
    expect(stateLabel(s, 44_000)).toBe("reading src/util.ts 42s");
    s.calls[0] = { tool: "Bash", detail: "pnpm -s vitest run", files: [], since: 2000 };
    expect(stateLabel(s, 44_000)).toBe("running pnpm -s vitest run 42s");
    s.calls = [];
    expect(stateLabel(s, 15_000)).toBe("thinking");
    s.state = "stalled";
    expect(stateLabel(s, 362_000)).toBe("stalled 6m");
    s.state = "idle";
    expect(stateLabel(s, 182_000)).toBe("idle 3m");
  });

  it("runs a seat's path through the nodes it visited in time order, each run of visits once", () => {
    const s = seat();
    s.recent = [
      { file: "f0", at: 1 },
      { file: "f1", at: 2 },
      { file: "f1", at: 3 },
      { file: "not-on-the-map", at: 4 },
      { file: "f2", at: 5 },
    ];
    s.calls = [{ tool: "Read", detail: "f3", files: ["f3"], since: 6 }];
    expect(seatTrail(s, line(4), 10)).toEqual(["f0", "f1", "f2", "f3"]);
    // the light sits on the node it last touched: the call in flight
    const placed = lightPlacement(s, line(4), 0, 10);
    expect(placed.node).toBe("f3");
    expect(placed.position).toEqual([30, 0, 0]);
  });

  it("drops accesses the hub no longer keeps, and a name-only listing never moves the light", () => {
    const s = seat();
    s.recent = [
      { file: "f0", at: 1000 },
      { file: "f1", at: 2000 },
    ];
    s.calls = [{ tool: "Glob", detail: "**/*", files: ["f2", "f3"], since: 3000 }];
    expect(seatTrail(s, line(4), 3000)).toEqual(["f0", "f1"]);
    expect(lightPlacement(s, line(4), 0, 3000).node).toBe("f1");
    // fifteen minutes after f0, it has aged out; after f1, so has the path
    expect(seatTrail(s, line(4), 1000 + MAP_RECENT_MS + 1)).toEqual(["f1"]);
    expect(seatTrail(s, line(4), 2000 + MAP_RECENT_MS + 1)).toEqual([]);
  });

  it("keeps the last twelve nodes of a long path", () => {
    const s = seat();
    s.calls = [];
    s.recent = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}`, at: i }));
    expect(seatTrail(s, line(20), 20)).toEqual(Array.from({ length: 12 }, (_, i) => `f${i + 8}`));
  });

  it("rests a seat with no access on the file it changed most, else in the dock", () => {
    const s = seat();
    Object.assign(s, { calls: [], recent: [], state: "idle", since: 0 });
    s.scope.modified = [
      { file: "f1", add: 2, rem: 0, source: "diff" },
      { file: "f2", add: 40, rem: 3, source: "diff" },
    ];
    const nodes = line(3);
    expect(lightPlacement(s, nodes, 0, 120_000)).toMatchObject({ node: "f2", docked: true });
    s.scope.modified = [];
    expect(lightPlacement(s, nodes, 2, 120_000)).toMatchObject({
      node: null,
      position: dockPosition(nodes, 2),
    });
  });

  it("moves the light from file to file as call deltas arrive", () => {
    let snapshot: MapSnapshot = { ...structuredClone(mapSnapshotFixture), seq: 10 };
    Object.assign(snapshot.seats[0] as MapSeat, { calls: [], recent: [] });
    const nodes = layoutTree(snapshot.tree);
    const at = () => lightPlacement(snapshot.seats[0] as MapSeat, nodes, 0, 5000).node;
    const start = (seq: number, tool: string, file: string): MapDelta => ({
      seq,
      type: "call.start",
      seat: "GUIDO-1",
      tool,
      detail: file,
      files: [file],
    });
    const end = (seq: number, file: string): MapDelta => ({
      seq,
      type: "call.end",
      seat: "GUIDO-1",
      files: [file],
      resultTok: 10,
      error: false,
      refused: false,
      why: null,
      tests: null,
    });
    const lights: (string | null)[] = [];
    for (const delta of [
      start(11, "Edit", "src/main.ts"),
      end(12, "src/main.ts"),
      start(13, "Read", "src/util.ts"),
      end(14, "src/util.ts"),
    ]) {
      snapshot = applyDelta(snapshot, delta, 4000 + delta.seq) as MapSnapshot;
      lights.push(at());
    }
    expect(lights).toEqual(["src/main.ts", "src/main.ts", "src/util.ts", "src/util.ts"]);
    // each access is listed once, at its end, as the server lists them
    expect(snapshot.seats[0]?.recent).toEqual([
      { file: "src/main.ts", at: 4012 },
      { file: "src/util.ts", at: 4014 },
    ]);
    expect(seatTrail(snapshot.seats[0] as MapSeat, nodes, 5000)).toEqual([
      "src/main.ts",
      "src/util.ts",
    ]);
  });
});
