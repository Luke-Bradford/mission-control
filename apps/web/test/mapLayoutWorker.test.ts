import { expect, it } from "vitest";
import { handleLayoutRequest } from "../src/map/layoutWorkerCore.ts";

it("lays out 10,000 individual files through the worker message path", () => {
  const tree = Array.from({ length: 10_000 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
  const { id, nodes } = handleLayoutRequest({ id: 7, tree, imports: [] });
  const files = nodes.filter((node) => node.count > 0);
  expect(id).toBe(7);
  expect(files).toHaveLength(10_000);
  expect(files.every((node) => node.count === 1 && node.files[0] === node.path)).toBe(true);
});
