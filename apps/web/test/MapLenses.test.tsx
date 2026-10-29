import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { graph, impactFocusLinks, lensVisuals } from "../src/map/Lenses.tsx";
import { historyHeat, treemapLayout } from "../src/map/MapTreemap.tsx";

const scenes = vi.hoisted(
  () =>
    [] as {
      focusLinks?: { from: string; to: string; unlinked?: boolean; confidence?: number }[];
      lens?: "changes" | "impact" | "history";
      lensVisual?: Record<
        string,
        { distance?: number; hotspot?: number; fixes?: number; dim?: boolean }
      >;
      onSelect?: (path: string) => void;
    }[],
);
vi.mock("../src/map/MapScene.tsx", () => ({
  MapScene: (props: {
    focusLinks?: { from: string; to: string; unlinked?: boolean; confidence?: number }[];
    lens?: "changes" | "impact" | "history";
    lensVisual?: Record<
      string,
      { distance?: number; hotspot?: number; fixes?: number; dim?: boolean }
    >;
    onSelect?: (path: string) => void;
  }) => {
    scenes.push(props);
    return <div>3D scene</div>;
  },
}));

it("derives seed reach, history heat and focused partner confidence from the map payload", () => {
  const value = snapshot();
  const impact = lensVisuals(value, "impact", null);
  expect(impact["src/contract.ts"]).toMatchObject({ distance: 0 });
  expect(impact["src/consumer.ts"]).toMatchObject({ distance: 0, overlap: true });
  expect(impact["test/consumer.test.ts"]).toMatchObject({ distance: 1 });
  expect(impact["src/untested.ts"]).toMatchObject({ distance: 0 });

  const history = lensVisuals(value, "history", "src/contract.ts");
  expect(history["src/contract.ts"]).toMatchObject({ hotspot: 59, fixes: 22, dim: false });
  expect(history["src/untested.ts"]).toMatchObject({ confidence: 0.67, dim: false });
  expect(history["src/consumer.ts"]).toMatchObject({ hotspot: 12, fixes: 2, dim: true });
});

it("marks only changed code files that import another seat's changed code as Impact overlap", () => {
  const sharedImporter = snapshot();
  sharedImporter.imports = [
    { from: "test/consumer.test.ts", to: "src/contract.ts" },
    { from: "test/consumer.test.ts", to: "src/consumer.ts" },
  ];
  expect(lensVisuals(sharedImporter, "impact", null)["test/consumer.test.ts"]?.overlap).toBeFalsy();

  const sameFile = snapshot();
  sameFile.seats[1] = {
    ...sameFile.seats[1],
    scope: {
      read: [],
      modified: [{ file: "src/contract.ts", add: 4, rem: 0, source: "diff" }],
    },
  };
  expect(lensVisuals(sameFile, "impact", null)["src/contract.ts"]?.overlap).toBeFalsy();
});

it("traces and colours an indirect test when focused outside the changed reach", () => {
  const value = snapshot();
  value.tree.push(
    { path: "src/isolated.ts", lines: 12 },
    { path: "src/isolated-consumer.ts", lines: 12 },
    { path: "test/isolated.test.ts", lines: 12 },
  );
  value.imports.push(
    { from: "src/isolated-consumer.ts", to: "src/isolated.ts" },
    { from: "test/isolated.test.ts", to: "src/isolated-consumer.ts" },
  );

  const visuals = lensVisuals(value, "impact", "src/isolated.ts");
  expect(visuals["src/isolated.ts"]).toMatchObject({ seat: 0, distance: 0, dim: false });
  expect(visuals["test/isolated.test.ts"]).toMatchObject({ seat: 0, distance: 2, dim: false });
  expect(impactFocusLinks(value, "src/isolated.ts")).toContainEqual({
    from: "src/isolated.ts",
    to: "test/isolated.test.ts",
  });

  render(<CrewMapView snapshot={value} />);
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  fireEvent.click(document.querySelector(".map-treemap-tile[title='src/isolated.ts']") as Element);
  const lens = screen.getByRole("region", { name: "Impact lens" });
  expect(within(lens).getAllByRole("button", { name: "test/isolated.test.ts" })).toHaveLength(1);
  expect(document.querySelectorAll(".map-treemap-links line")).toHaveLength(2);
});

it("keeps non-code changes out of Impact code rows and untested findings", () => {
  const value = snapshot();
  value.tree.push({ path: "README.md", lines: 4 }, { path: "config/map.yaml", lines: 4 });
  value.seats[0] = {
    ...value.seats[0],
    scope: {
      read: [],
      modified: [
        ...value.seats[0].scope.modified,
        { file: "README.md", add: 1, rem: 0, source: "diff" },
        { file: "config/map.yaml", add: 1, rem: 0, source: "diff" },
      ],
    },
  };
  const visuals = lensVisuals(value, "impact", null);
  expect(visuals["README.md"]).toBeUndefined();
  expect(visuals["config/map.yaml"]).toBeUndefined();
  render(<CrewMapView snapshot={value} />);
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  expect(screen.getByRole("region", { name: "Impact lens" }).textContent).not.toContain(
    "README.md",
  );
  expect(screen.getByRole("region", { name: "Impact lens" }).textContent).not.toContain(
    "config/map.yaml",
  );
});

it("does not report a changed test file as untested code", () => {
  const value = snapshot();
  value.seats[0] = {
    ...value.seats[0],
    scope: {
      read: [],
      modified: [{ file: "test/consumer.test.ts", add: 2, rem: 0, source: "diff" }],
    },
  };
  value.seats[1] = { ...value.seats[1], scope: { read: [], modified: [] } };
  render(<CrewMapView snapshot={value} />);
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  const heading = screen.getByRole("heading", { name: "Changed, and no test imports them" });
  expect(heading.parentElement?.textContent).not.toContain("test/consumer.test.ts");
});

function snapshot(): MapSnapshot {
  const value: MapSnapshot = structuredClone(mapSnapshotFixture);
  value.tree = [
    { path: "src/contract.ts", lines: 12 },
    { path: "src/consumer.ts", lines: 12 },
    { path: "src/cycle.ts", lines: 12 },
    { path: "src/untested.ts", lines: 12 },
    { path: "test/consumer.test.ts", lines: 12 },
  ];
  value.imports = [
    { from: "src/consumer.ts", to: "src/contract.ts" },
    { from: "src/contract.ts", to: "src/cycle.ts" },
    { from: "src/cycle.ts", to: "src/contract.ts" },
    { from: "test/consumer.test.ts", to: "src/consumer.ts" },
  ];
  value.seats = [structuredClone(value.seats[0]), structuredClone(value.seats[0])];
  value.seats[0] = {
    ...value.seats[0],
    seat: "GUIDO-1",
    scope: {
      read: [],
      modified: [
        { file: "src/contract.ts", add: 3, rem: 1, source: "diff" },
        { file: "src/untested.ts", add: 2, rem: 0, source: "diff" },
      ],
    },
  };
  value.seats[1] = {
    ...value.seats[1],
    seat: "INCO-1",
    scope: {
      read: [],
      modified: [{ file: "src/consumer.ts", add: 4, rem: 0, source: "diff" }],
    },
  };
  value.hist = {
    since: Date.UTC(2026, 9, 22),
    prCount: 59,
    fixCount: 22,
    files: {
      "0": [59, 22, Date.UTC(2026, 9, 28), [837, 836]],
      "1": [12, 2, Date.UTC(2026, 9, 27), [835]],
      "3": [8, 1, Date.UTC(2026, 9, 26), [834]],
    },
    coupling: [[0, 3, 8, 0.67]],
  };
  return value;
}

it("shows Impact tallies, dependency overlap, untested changes, cycles, and a focused import trace", async () => {
  render(<CrewMapView snapshot={snapshot()} github="Luke-Bradford/mission-control" />);
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));

  const lens = screen.getByRole("region", { name: "Impact lens" });
  expect(lens.textContent).toContain("2 files changed");
  expect(lens.textContent).toContain("1 import them");
  expect(lens.textContent).toContain("Changes overlap through imports");
  expect(lens.textContent).toContain("Changed, and no test imports them");
  expect(lens.textContent).toContain("Import cycles");
  expect(lens.textContent).toContain("src/untested.ts");

  const impactContract = within(lens).getAllByRole("button", { name: "src/contract.ts" })[0];
  if (impactContract === undefined) throw new Error("expected the changed contract file");
  fireEvent.click(impactContract);
  expect(lens.textContent).toContain("Imported by");
  expect(lens.textContent).toContain("Tests that reach it");
  expect(lens.textContent).toContain("It imports");
  expect(lens.textContent).toContain("3depend on it");
  expect(lens.textContent).not.toContain("Further downstreamsrc/contract.ts");
  expect(document.querySelectorAll(".map-treemap-links line")).not.toHaveLength(0);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(lens.textContent).toContain("Changes overlap through imports");
});

it("treats a branching import SCC as one audit unit and map clicks toggle lens focus", async () => {
  const value = snapshot();
  value.tree = value.tree.filter((file) => file.path !== "src/untested.ts");
  value.imports = [
    { from: "src/contract.ts", to: "src/consumer.ts" },
    { from: "src/consumer.ts", to: "src/contract.ts" },
    { from: "src/contract.ts", to: "src/cycle.ts" },
    { from: "src/cycle.ts", to: "src/contract.ts" },
  ];
  expect(graph(value).cycles).toEqual([["src/consumer.ts", "src/contract.ts", "src/cycle.ts"]]);
  render(<CrewMapView snapshot={snapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.click(document.querySelector(".map-treemap-tile[title='src/contract.ts']") as Element);
  expect(screen.getByRole("region", { name: "History lens" }).textContent).toContain("Latest PRs");
  fireEvent.click(screen.getByRole("button", { name: "← All files" }));
  expect(screen.getByRole("region", { name: "History lens" }).textContent).toContain("Hotspots");
});

it("shows History hotspots, frequent fixes, unlinked change partners, and linked recent PRs on focus", () => {
  render(<CrewMapView snapshot={snapshot()} github="Luke-Bradford/mission-control" />);
  fireEvent.click(screen.getByRole("button", { name: "History" }));

  const lens = screen.getByRole("region", { name: "History lens" });
  expect(lens.textContent).toContain("Hotspots the seats are changing");
  expect(lens.textContent).toContain("Fixed most often");
  expect(lens.textContent).toContain("Change together, no import between them");
  expect(lens.textContent).toContain("59 · 22");
  const historyContract = within(lens).getAllByRole("button", { name: "src/contract.ts" })[0];
  if (historyContract === undefined) throw new Error("expected the changed contract file");
  fireEvent.click(historyContract);
  expect(lens.textContent).toContain("Latest PRs");
  expect(within(lens).getByRole("link", { name: "#837" }).getAttribute("href")).toBe(
    "https://github.com/Luke-Bradford/mission-control/pull/837",
  );
  expect(lens.textContent).toContain("Changes together with");
  expect(document.querySelectorAll(".map-treemap-links line")).not.toHaveLength(0);
});

it("uses lens-specific treemaps and clean, deduplicated code tables", () => {
  const value = snapshot();
  value.tree.push(
    { path: "test/history.test.ts", lines: 12 },
    { path: "src/unrelated.ts", lines: 12 },
    { path: "apps/server/src/account-bindings.ts", lines: 12 },
  );
  value.hist.files["5"] = [20, 9, Date.UTC(2026, 9, 28), [838]];
  value.seats[1] = {
    ...value.seats[1],
    scope: {
      read: [],
      modified: [
        ...value.seats[1].scope.modified,
        { file: "src/contract.ts", add: 1, rem: 0, source: "diff" },
        { file: "test/consumer.test.ts", add: 1, rem: 0, source: "diff" },
        { file: "apps/server/src/account-bindings.ts", add: 1, rem: 0, source: "diff" },
      ],
    },
  };
  value.seats.push({
    ...structuredClone(value.seats[0]),
    seat: "IDLE-1",
    scope: { read: [], modified: [] },
  });
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  expect(screen.getByRole("img", { name: "Impact reach treemap" })).toBeTruthy();
  expect(document.body.textContent).toContain("changed → importers → dependents");
  const impact = screen.getByRole("region", { name: "Impact lens" });
  expect(impact.textContent).toContain("tests · import · depend");
  expect(impact.textContent).toContain("Test files changed separately");
  expect(impact.textContent).not.toContain("test reaches it");
  expect(
    screen
      .getAllByTitle("apps/server/src/account-bindings.ts")
      .find((element) => element.classList.contains("map-lens-file"))?.textContent,
  ).toBe("…/server/src/account-bindings.ts");
  expect(screen.queryByRole("heading", { name: "IDLE-1" })).toBeNull();
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/unrelated.ts']")
      ?.hasAttribute("data-neutral"),
  ).toBe(true);
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/consumer.ts']")
      ?.hasAttribute("data-overlap"),
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("img", { name: "History PR heat treemap" })).toBeTruthy();
  expect(document.body.textContent).toContain("1–2 PRs");
  expect(document.body.textContent).toContain("30+ PRs");
  const history = screen.getByRole("region", { name: "History lens" });
  expect(history.textContent).toContain("PRs · fixes");
  expect(document.body.textContent).toContain("hidden change coupling");
  const hotspots = screen.getByRole("heading", {
    name: "Hotspots the seats are changing",
  }).parentElement;
  expect(
    within(hotspots as HTMLElement).getAllByRole("button", { name: "src/contract.ts" }),
  ).toHaveLength(1);
  expect(history.textContent).not.toContain("history.test.ts");
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/contract.ts']")
      ?.hasAttribute("data-fix-heavy"),
  ).toBe(true);
});

it("packs the complete hierarchy inside the viewport and anchors links to tile centres", () => {
  const layout = treemapLayout(
    [
      { path: "apps/web/src/large.ts", lines: 500 },
      { path: "apps/web/src/small.ts", lines: 5 },
      { path: "packages/core/src/index.ts", lines: 100 },
    ],
    1600,
    1000,
  );
  expect(layout.folders.some((folder) => folder.path === "apps/web/src")).toBe(true);
  for (const tile of layout.tiles) {
    expect(tile.x).toBeGreaterThanOrEqual(0);
    expect(tile.y).toBeGreaterThanOrEqual(0);
    expect(tile.x + tile.width).toBeLessThanOrEqual(1600.001);
    expect(tile.y + tile.height).toBeLessThanOrEqual(1000.001);
  }
  const large = layout.byPath.get("apps/web/src/large.ts");
  const small = layout.byPath.get("apps/web/src/small.ts");
  if (!large || !small) throw new Error("expected treemap leaves");
  expect(large.center).toEqual([large.x + large.width / 2, large.y + large.height / 2]);
  expect(small.center).toEqual([small.x + small.width / 2, small.y + small.height / 2]);
});

it("keeps every file tile positive in a mockup-sized nested repository", () => {
  const files = Array.from({ length: 753 }, (_, index) => ({
    path: `apps/server/src/area-${index % 19}/deep/nested/file-${index}.ts`,
    lines: 1 + (index % 80),
  }));
  const layout = treemapLayout(files, 1600, 1000);
  expect(layout.tiles).toHaveLength(753);
  expect(layout.tiles.every((tile) => tile.width > 0 && tile.height > 0)).toBe(true);
  expect(
    Math.max(
      ...layout.tiles.map((tile) => Math.max(tile.width / tile.height, tile.height / tile.width)),
    ),
  ).toBeLessThan(20_000);
});

it("uses fixed PR heat bands rather than scaling to the hottest file", () => {
  expect([
    historyHeat(1),
    historyHeat(2),
    historyHeat(3),
    historyHeat(9),
    historyHeat(10),
    historyHeat(29),
    historyHeat(30),
  ]).toEqual([0.16, 0.16, 0.36, 0.36, 0.6, 0.6, 0.85]);
});

it("squarifies equal root files at the 1600×1000 reference size", () => {
  const layout = treemapLayout(
    Array.from({ length: 4 }, (_, index) => ({ path: `file-${index}.ts`, lines: 10 })),
    1600,
    1000,
  );
  expect(
    Math.max(
      ...layout.tiles.map((tile) => Math.max(tile.width / tile.height, tile.height / tile.width)),
    ),
  ).toBeLessThanOrEqual(2);
});
