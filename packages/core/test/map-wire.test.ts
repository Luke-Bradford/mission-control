import { expect, it } from "vitest";
import { mapSnapshotFixture } from "../src/map-fixture.ts";
import { joinMapGraph, type MapPayload, packMapTree, unpackMap } from "../src/map-wire.ts";

it("round trips paths without sorting away graph indexes, including Unicode and repeated prefixes", () => {
  const tree = [
    { path: "a/😀.ts", lines: 4 },
    { path: "a/😁.ts", lines: 9 },
    { path: "a", lines: 1 },
    { path: "z", lines: 0 },
  ];
  const { imports: _, hist: __, ...base } = mapSnapshotFixture;
  const wire: MapPayload = { ...base, tree: packMapTree(tree), graphKey: "tree" };
  const light = unpackMap(JSON.parse(JSON.stringify(wire)));
  expect(light.tree).toEqual(tree);
  const graph = {
    key: "tree",
    imports: [[0, 1]] as [number, number][],
    hist: mapSnapshotFixture.hist,
  };
  const full = joinMapGraph(light, graph);
  expect(full.imports).toEqual([{ from: "a/😀.ts", to: "a/😁.ts" }]);
  expect(joinMapGraph({ ...light, seq: 99 }, graph).imports).toBe(full.imports);
  expect(() => joinMapGraph({ ...light, graphKey: "other" }, graph)).toThrow("changed");
  expect(() => joinMapGraph(light, { ...graph, imports: [[0, 99]] })).toThrow("index");
  expect(unpackMap(mapSnapshotFixture)).toBe(mapSnapshotFixture);
});
it("rejects invalid prefix lengths instead of drawing a misleading path", () => {
  const { imports: _, hist: __, ...base } = mapSnapshotFixture;
  expect(() => unpackMap({ ...base, tree: [[1, "x", 1]], graphKey: "key" })).toThrow("prefix");
});
