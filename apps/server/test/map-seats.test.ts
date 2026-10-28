import type { MapChange } from "@mc/core";
import { expect, it } from "vitest";
import { runChanges } from "../src/map/seats.ts";

const scope = (modified: MapChange[], touched: Record<string, number>) => ({
  read: [],
  modified,
  touched,
  editedAt: 0,
  tests: null,
});
const ring = (
  diff: MapChange[] | null,
  modified: MapChange[],
  touched: Record<string, number>,
) => ({
  diff: () => diff,
  scope: () => scope(modified, touched),
});
const commitAt = (at: number | null) => ({
  newestRunCommit: () => (at === null ? null : { sha: "a".repeat(40), at }),
});

it("serves the branch's real diff, not the churn of its Edit and Write calls", () => {
  // a Write counted every line as added; the diff says what the branch really changed
  const churn: MapChange[] = [{ file: "a.ts", add: 120, rem: 0, source: "churn" }];
  const diff: MapChange[] = [{ file: "a.ts", add: 30, rem: 4, source: "diff" }];
  expect(runChanges("r", ring(diff, churn, { "a.ts": 50 }), commitAt(100))).toEqual(diff);
});

it("adds churn only for files edited since the last commit that the diff doesn't show yet", () => {
  const churn: MapChange[] = [
    { file: "new.ts", add: 10, rem: 0, source: "churn" },
    { file: "reverted.ts", add: 3, rem: 3, source: "churn" },
    { file: "a.ts", add: 9, rem: 9, source: "churn" },
  ];
  const diff: MapChange[] = [{ file: "a.ts", add: 2, rem: 1, source: "diff" }];
  expect(
    runChanges(
      "r",
      ring(diff, churn, { "new.ts": 200, "reverted.ts": 50, "a.ts": 300 }),
      commitAt(100),
    ),
  ).toEqual([
    { file: "a.ts", add: 2, rem: 1, source: "diff" },
    { file: "new.ts", add: 10, rem: 0, source: "churn" },
  ]);
});

it("falls back to labelled churn while the diff is unread or unavailable", () => {
  const churn: MapChange[] = [{ file: "a.ts", add: 5, rem: 1, source: "churn" }];
  expect(runChanges("r", ring(null, churn, { "a.ts": 1 }), commitAt(null))).toEqual(churn);
});
