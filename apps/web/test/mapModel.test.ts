import { mapSnapshotFixture as mapFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  applyDelta,
  areaTone,
  fileStyle,
  layoutTree,
  level,
  pickRepo,
  pinToken,
  tokenBand,
} from "../src/map/model.ts";

describe("map rules", () => {
  it("uses distinct muted area tones and configured seat order", () => {
    expect(areaTone("apps")).not.toEqual(areaTone("docs"));
    const s: import("@mc/core").MapSnapshot = structuredClone(mapFixture);
    expect(fileStyle(s, ["src/main.ts"], "src", 3000, { "GUIDO-1": 4 }).token).toBe("--s5");
  });
  it("ports the prototype level and payload band boundaries", () => {
    expect([0, 10, 11, 50, 51, 200, 201, 500, 501].map(level)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
    expect([0, 99, 100, 999, 1000, 3999, 4000].map(tokenBand)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
  it("keeps existing positions when branch files are added and bounds large trees", () => {
    const tree = [
      { path: "src/a.ts", lines: 5 },
      { path: "src/b.ts", lines: 500000 },
    ];
    const first = layoutTree(tree);
    const next = layoutTree([...tree, { path: "src/new.ts", lines: 5 }]);
    const extended = layoutTree([{ path: "src/new.ts", lines: 5 }], first);
    expect(extended.find((n) => n.path === "src/a.ts")?.position).toBe(
      first.find((n) => n.path === "src/a.ts")?.position,
    );
    expect(next.find((n) => n.path === "src/a.ts")).toEqual(
      first.find((n) => n.path === "src/a.ts"),
    );
    expect(first.every((n) => n.position.every(Number.isFinite))).toBe(true);
    const large = layoutTree(
      Array.from({ length: 2001 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 })),
    );
    expect(large.filter((n) => n.count > 0)).toHaveLength(1);
    expect(large.find((n) => n.path === "src")?.count).toBe(2001);
  });
  it("separates findings by shape and HUD severity token from all seven seat colours", () => {
    expect(pinToken("Critical")).toBe("--crit");
    expect(pinToken("Important")).toBe("--warn");
    for (let i = 0; i < 7; i++) {
      const s: import("@mc/core").MapSnapshot = structuredClone(mapFixture);
      s.seats = Array.from({ length: 7 }, (_, j) => ({
        ...s.seats[0],
        seat: `seat-${j}`,
        scope: { read: [], modified: [] },
        calls: [],
      }));
      s.seats[i].scope.modified = [{ file: "a.ts", add: 51, rem: 0, source: "diff" }];
      expect(fileStyle(s, ["a.ts"], "src").token).toBe(`--s${i + 1}`);
      expect(fileStyle(s, ["a.ts"], "src").level).toBe(2);
    }
  });
  it("distinguishes read/write overlap and current access without claiming conflict", () => {
    const s: import("@mc/core").MapSnapshot = structuredClone(mapFixture);
    s.seats = [s.seats[0], { ...structuredClone(s.seats[0]), seat: "other" }];
    s.seats[0].scope = { read: [], modified: [{ file: "a", add: 1, rem: 2, source: "churn" }] };
    s.seats[1].scope = { read: ["a"], modified: [] };
    expect(fileStyle(s, ["a"], "src").overlap).toBe("shared");
    s.seats[1].scope.modified = [{ file: "a", add: 1, rem: 0, source: "diff" }];
    expect(fileStyle(s, ["a"], "src").overlap).toBe("write overlap");
  });
  it("applies ordered changes, ignores duplicates and requests resync on gaps", () => {
    const s: import("@mc/core").MapSnapshot = structuredClone(mapFixture);
    const d = {
      type: "diff" as const,
      seq: s.seq + 1,
      seat: s.seats[0].seat,
      file: "new.ts",
      add: 55,
      rem: 2,
    };
    const next = applyDelta(s, d, 100);
    expect(next?.seats[0].scope.modified.find((c) => c.file === "new.ts")?.source).toBe("diff");
    expect(applyDelta(s, { ...d, seq: s.seq }, 100)).toBe(s);
    expect(applyDelta(s, { ...d, seq: s.seq + 2 }, 100)).toBeNull();
    expect(s.seats[0].scope.modified.some((c) => c.file === "new.ts")).toBe(false);
  });
  it("picks the busiest repo, breaks ties by start, and retains a manual idle choice", () => {
    expect(
      pickRepo(
        ["a", "b"],
        [
          { repoId: "a", started: 1 },
          { repoId: "b", started: 2 },
        ],
        "a",
      ),
    ).toBe("b");
    expect(pickRepo(["a", "b"], [], "b")).toBe("b");
    expect(pickRepo(["a", "b"], [], "removed")).toBe("a");
  });
});
