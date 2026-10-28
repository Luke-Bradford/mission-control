import { mapSnapshotFixture as mapFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { areaColor, OTHER_AREA_COLOR, repoLayout } from "../src/map/layout.ts";
import {
  applyDelta,
  fileStyle,
  layoutTree,
  level,
  pickRepo,
  pinToken,
  tokenBand,
} from "../src/map/model.ts";

describe("map rules", () => {
  it("uses distinct muted area tones and configured seat order", () => {
    expect(areaColor("apps/web", ["apps/server", "apps/web"])).not.toEqual(
      areaColor("apps/server", ["apps/server", "apps/web"]),
    );
    expect(areaColor("docs", ["apps/server"])).toBe(OTHER_AREA_COLOR);
    const s: import("@mc/core").MapSnapshot = structuredClone(mapFixture);
    expect(fileStyle(s, ["src/main.ts"], "src", 3000, { "GUIDO-1": 4 }).token).toBe("--s5");
  });
  it("ports the prototype level and payload band boundaries", () => {
    expect([0, 10, 11, 50, 51, 200, 201, 500, 501].map(level)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
    expect([0, 99, 100, 999, 1000, 3999, 4000].map(tokenBand)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
  it("keeps existing positions when branch files are added and keeps large trees as individual files", () => {
    const tree = [
      { path: "src/a.ts", lines: 5 },
      { path: "src/b.ts", lines: 500000 },
    ];
    const first = layoutTree(tree);
    const extended = layoutTree([{ path: "src/new.ts", lines: 5 }], first);
    expect(extended.find((n) => n.path === "src/a.ts")?.position).toBe(
      first.find((n) => n.path === "src/a.ts")?.position,
    );
    expect(extended.find((n) => n.path === "src/new.ts")?.parent).toBe("src");
    // computed once per tree: the same tree always lays out the same way
    expect(layoutTree(structuredClone(tree))).toEqual(first);
    expect(first.every((n) => n.position.every(Number.isFinite))).toBe(true);
    const large = layoutTree(
      Array.from({ length: 2001 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 })),
    );
    const files = large.filter((n) => n.count > 0);
    expect(files).toHaveLength(2001);
    expect(files.every((node) => node.files[0] === node.path && node.count === 1)).toBe(true);
  });
  it("lays out every file as its own node, apart from its neighbours, each area its own way", () => {
    const tree = [
      ...Array.from({ length: 40 }, (_, i) => ({ path: `apps/server/src/s${i}.ts`, lines: 50 })),
      ...Array.from({ length: 30 }, (_, i) => ({ path: `apps/web/src/w${i}.tsx`, lines: 80 })),
      { path: "README.md", lines: 10 },
    ];
    const imports = [{ from: "apps/web/src/w0.tsx", to: "apps/server/src/s0.ts" }];
    const nodes = layoutTree(tree, [], false, imports);
    const files = nodes.filter((n) => n.count > 0);
    expect(files).toHaveLength(tree.length);
    expect(files.every((n) => n.files.length === 1 && n.files[0] === n.path)).toBe(true);
    expect(nodes.find((n) => n.path === "README.md")?.area).toBe("(root)");
    const at = (path: string) => nodes.find((n) => n.path === path)?.position ?? [0, 0, 0];
    // the two biggest areas fan out to opposite sides of the root
    expect(Math.sign(at("apps/server")[0])).not.toBe(Math.sign(at("apps/web")[0]));
    let closest = Number.POSITIVE_INFINITY;
    for (const a of files)
      for (const b of files)
        if (a !== b)
          closest = Math.min(
            closest,
            Math.hypot(...a.position.map((v, i) => v - (b.position[i] as number))),
          );
    expect(closest).toBeGreaterThan(0.5);
  });
  it("keeps the layout across a merge: line counts move nothing, new files land by their folder", () => {
    const tree = [
      ...Array.from({ length: 30 }, (_, i) => ({ path: `apps/server/src/s${i}.ts`, lines: 40 })),
      ...Array.from({ length: 20 }, (_, i) => ({ path: `apps/web/src/w${i}.tsx`, lines: 60 })),
    ];
    const first = repoLayout("stability", tree, []);
    // a refetch whose line counts changed reuses the same layout
    expect(
      repoLayout(
        "stability",
        tree.map((f) => ({ ...f, lines: f.lines * 3 })),
        [],
      ),
    ).toBe(first);
    const merged = [
      ...tree,
      { path: "apps/web/src/w-new.tsx", lines: 30 },
      { path: "apps/web/src/fresh/x.ts", lines: 5 },
    ];
    const next = repoLayout("stability", merged, [
      { from: "apps/web/src/w-new.tsx", to: "apps/web/src/w0.tsx" },
    ]);
    const at = (nodes: typeof first, path: string) => nodes.find((n) => n.path === path)?.position;
    let moved = 0;
    for (const node of first)
      moved = Math.max(
        moved,
        Math.hypot(
          ...node.position.map((v, i) => v - ((at(next, node.path) ?? [])[i] ?? Infinity)),
        ),
      );
    expect(moved).toBe(0);
    const folder = at(next, "apps/web/src") as [number, number, number];
    const added = at(next, "apps/web/src/w-new.tsx") as [number, number, number];
    expect(Math.hypot(...added.map((v, i) => v - (folder[i] as number)))).toBeLessThan(30);
    // navigating back to the old tree reuses its layout
    expect(repoLayout("stability", tree, [])).toBe(first);
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
