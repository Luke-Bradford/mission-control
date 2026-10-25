import { expect, expectTypeOf, it } from "vitest";
import {
  type MapDelta,
  type MapSnapshot,
  mapDeltaFixture,
  mapSnapshotFixture,
} from "../src/index.ts";

it("parses the exported snapshot fixture against the map contract", () => {
  expectTypeOf(mapSnapshotFixture).toMatchTypeOf<MapSnapshot>();
  const snapshot: MapSnapshot = JSON.parse(JSON.stringify(mapSnapshotFixture));
  expect(snapshot.repoId).toBe("sample");
  expect(snapshot.seq).toBe(0);
  expect(snapshot.tree.map((f) => f.path)).toEqual(["src/main.ts", "src/util.ts"]);
  expect(snapshot.imports).toEqual([{ from: "src/main.ts", to: "src/util.ts" }]);
  const seat = snapshot.seats[0];
  expect(seat?.scope.modified).toEqual([{ file: "src/main.ts", add: 12, rem: 3, source: "churn" }]);
  expect(seat?.context).toEqual({ total: 12000, window: 64000 });
  expect(seat?.badges.tests).toEqual({
    runner: "vitest",
    status: "passed",
    passed: 4,
    failed: 0,
    at: 1000,
    editedSince: true,
  });
  expect(snapshot.findings[0]).toMatchObject({ ticket: 7, round: 1, severity: "Important" });
  expect(snapshot.conflicts).toEqual([]);
});

it("parses every delta kind with ordered sequence numbers after the snapshot", () => {
  expectTypeOf(mapDeltaFixture).toMatchTypeOf<MapDelta[]>();
  const deltas: MapDelta[] = JSON.parse(JSON.stringify(mapDeltaFixture));
  expect(deltas.map((d) => d.type)).toEqual([
    "call.start",
    "call.end",
    "edit",
    "state",
    "message",
    "review",
    "diff",
  ]);
  expect(deltas.map((d) => d.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(deltas[0]).toMatchObject({ writeTok: 32, files: ["src/main.ts"] });
  expect(deltas[1]).toMatchObject({ resultTok: 8, error: false, refused: false, tests: null });
});
