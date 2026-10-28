import { type MapSeat, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { orbPlacement, stateLabel } from "../src/map/agents.ts";
import { layoutTree } from "../src/map/model.ts";

const seat = (): MapSeat => structuredClone(mapSnapshotFixture.seats[0]);
describe("map agent meaning", () => {
  it("names observed calls, thinking only during a running turn, and hub stalls", () => {
    const s = seat();
    expect(stateLabel(s, 44_000)).toBe("reading src/util.ts 42s");
    s.calls[0] = { tool: "Bash", detail: "pnpm -s vitest run", files: [], since: 2000 };
    expect(stateLabel(s, 44_000)).toBe("running pnpm -s vitest run 42s");
    s.calls = [];
    s.recent = [{ file: "src/main.ts", at: 3000 }];
    expect(stateLabel(s, 15_000)).toBe("thinking");
    expect(stateLabel(s, 15_000, 3000)).toBe("thinking 12s");
    expect(stateLabel(s, 15_000, 1000)).toBe("thinking");
    s.state = "stalled";
    expect(stateLabel(s, 362_000)).toBe("stalled 6m");
    s.state = "idle";
    expect(stateLabel(s, 182_000)).toBe("idle 3m");
  });
  it("places parallel calls at their unique files' centroid and caps links, not the centroid", () => {
    const s = seat();
    const nodes = Array.from({ length: 16 }, (_, i) => ({
      path: `${i}`,
      parent: null,
      area: "",
      position: [i * 2, 0, 0] as [number, number, number],
      files: [`${i}`],
      count: 1,
    }));
    s.calls = nodes.map((n) => ({
      tool: "Read",
      detail: n.path,
      files: [n.path, n.path],
      since: 0,
    }));
    const p = orbPlacement(s, nodes, 0, 1000);
    expect(p.position).toEqual([15, 9, 0]);
    expect(p.links).toHaveLength(12);
    expect(p.more).toBe(4);
    expect(p.docked).toBe(false);
  });
  it("uses actual recent accesses without a thinking-file claim and docks after a minute", () => {
    const s = seat();
    const nodes = layoutTree(mapSnapshotFixture.tree);
    s.calls = [];
    const p = orbPlacement(s, nodes, 0, 10_000);
    const file = nodes.find((n) => n.path === "src/main.ts");
    expect(p.position).toEqual([
      file?.position[0],
      (file?.position[1] ?? 0) + 16,
      file?.position[2],
    ]);
    expect(p.links).toEqual([]);
    s.state = "idle";
    expect(orbPlacement(s, nodes, 0, 61_999).docked).toBe(false);
    expect(orbPlacement(s, nodes, 0, 62_000).docked).toBe(true);
    s.seat = "FLIGHT";
    s.state = "running";
    expect(orbPlacement(s, nodes, 0, 3000).docked).toBe(true);
  });
  it("resolves collapsed files, ignores unknown paths, and never uses scope as a location", () => {
    const s = seat();
    const nodes = layoutTree(mapSnapshotFixture.tree, [], true);
    expect(orbPlacement(s, nodes, 0, 3000).links).toEqual(["src"]);
    s.calls = [];
    s.recent = [];
    const p = orbPlacement(s, nodes, 0, 3000);
    s.scope.read.push("invented.ts");
    expect(orbPlacement(s, nodes, 0, 3000).position).toEqual(p.position);
  });
});
