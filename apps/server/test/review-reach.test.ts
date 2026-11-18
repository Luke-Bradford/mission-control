import { expect, it } from "vitest";
import { REVIEW_REACH_MAX, reviewReach } from "../src/review/reach.ts";

const imports = [
  { from: "src/b.ts", to: "src/a.ts" },
  { from: "src/c.ts", to: "src/a.ts" },
  { from: "src/c.ts", to: "src/z.ts" },
  { from: "src/a.ts", to: "src/z.ts" },
];

it("lists the changed files and the files that import them, leaving out the changed ones", () => {
  expect(reviewReach(imports, ["src/a.ts", "src/b.ts"])).toEqual({
    changed: ["src/a.ts", "src/b.ts"],
    changedMore: 0,
    importers: ["src/c.ts"],
    importersMore: 0,
  });
});

it("caps both lists and counts the rest", () => {
  const name = (prefix: string, n: number) => `${prefix}${String(n).padStart(3, "0")}.ts`;
  const over = REVIEW_REACH_MAX + 2;
  const changed = Array.from({ length: over }, (_, n) => name("c", n));
  const importers = Array.from({ length: over }, (_, n) => name("i", n));
  const reach = reviewReach(
    importers.flatMap((from) => changed.map((to) => ({ from, to }))),
    changed,
  );
  expect(reach?.changed).toHaveLength(REVIEW_REACH_MAX);
  expect(reach?.changedMore).toBe(2);
  expect(reach?.importers).toHaveLength(REVIEW_REACH_MAX);
  expect(reach?.importersMore).toBe(2);
});

it("returns null for a change with no files", () => {
  expect(reviewReach(imports, [])).toBeNull();
});
