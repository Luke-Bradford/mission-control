import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { graph, lensVisuals } from "../src/map/Lenses.tsx";

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
  value.seats[1] = {
    ...value.seats[1],
    scope: {
      read: [],
      modified: [
        ...value.seats[1].scope.modified,
        { file: "src/contract.ts", add: 1, rem: 0, source: "diff" },
        { file: "test/consumer.test.ts", add: 1, rem: 0, source: "diff" },
      ],
    },
  };
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  expect(screen.getByRole("img", { name: "Impact reach treemap" })).toBeTruthy();
  const impact = screen.getByRole("region", { name: "Impact lens" });
  expect(impact.textContent).toContain("tests · import · depend");
  expect(impact.textContent).toContain("Test files changed separately");

  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("img", { name: "History PR heat treemap" })).toBeTruthy();
  const history = screen.getByRole("region", { name: "History lens" });
  expect(history.textContent).toContain("PRs · fixes");
  expect(document.body.textContent).toContain("hidden change coupling");
  expect(within(history).getAllByRole("button", { name: "src/contract.ts" })).toHaveLength(1);
  expect(history.textContent).not.toContain("test/consumer.test.ts");
});
