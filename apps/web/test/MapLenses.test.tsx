import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { graph, impactFocusLinks, lensVisuals } from "../src/map/Lenses.tsx";
import { changeIntensity, historyHeat, isFixHeavy, treemapLayout } from "../src/map/MapTreemap.tsx";

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
    { path: "src/direct-import.ts", lines: 12 },
    { path: "test/isolated.test.ts", lines: 12 },
  );
  value.imports.push(
    { from: "src/isolated-consumer.ts", to: "src/isolated.ts" },
    { from: "test/isolated.test.ts", to: "src/isolated-consumer.ts" },
    { from: "src/isolated.ts", to: "src/direct-import.ts" },
  );

  const visuals = lensVisuals(value, "impact", "src/isolated.ts");
  expect(visuals["src/isolated.ts"]).toMatchObject({ seat: 0, distance: 0, dim: false });
  expect(visuals["test/isolated.test.ts"]).toMatchObject({ seat: 0, distance: 2, dim: false });
  expect(visuals["src/direct-import.ts"]).toMatchObject({ directImport: true, dim: false });
  expect(visuals["src/direct-import.ts"]?.distance).toBeUndefined();
  expect(impactFocusLinks(value, "src/isolated.ts")).toContainEqual({
    from: "src/isolated.ts",
    to: "test/isolated.test.ts",
  });

  render(<CrewMapView snapshot={value} />);
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  fireEvent.click(document.querySelector(".map-treemap-tile[title='src/isolated.ts']") as Element);
  const lens = screen.getByRole("region", { name: "Impact lens" });
  expect(within(lens).getAllByRole("button", { name: "test/isolated.test.ts" })).toHaveLength(1);
  expect(document.querySelectorAll(".map-treemap-links line")).toHaveLength(3);
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/direct-import.ts']")
      ?.hasAttribute("data-direct-import"),
  ).toBe(true);
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
  expect(lensVisuals(value, "impact", null)["test/consumer.test.ts"]).toBeUndefined();
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
  const focusedKey = screen.getByRole("note", { name: "Impact colour scale" });
  expect(focusedKey.textContent).toContain("contract.ts");
  expect(focusedKey.textContent).toContain("1 · 2 · 3 · 4+ steps away");
  expect(focusedKey.textContent).toContain("it imports");
  expect(focusedKey.textContent).toContain("Esc to clear");
  expect(focusedKey.querySelectorAll(".map-key-swatch")).toHaveLength(5);
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
  expect(document.body.textContent).toContain("changed · imports it · 2 · 3+ steps");
  expect(
    screen.getByRole("note", { name: "Impact colour scale" }).querySelectorAll(".map-key-swatch"),
  ).toHaveLength(5);
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
  const historyKey = screen.getByRole("note", { name: "History PR heat scale" });
  expect(historyKey.querySelectorAll(".map-key-swatch")).toHaveLength(5);
  expect(
    [...historyKey.querySelectorAll(".map-key-steps-history .map-key-swatch")].map((swatch) =>
      Number(swatch.getAttribute("data-opacity")),
    ),
  ).toEqual([0.16, 0.36, 0.6, 0.85]);
  expect(
    [...historyKey.querySelectorAll(".map-key-steps-history .map-key-swatch")].every(
      (swatch) => swatch.getAttribute("style") === null,
    ),
  ).toBe(true);
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

it("names working seats by colour in the Impact key and counts idle seats", () => {
  const value = snapshot();
  value.seats = value.seats.map((seat) => ({ ...seat, state: "running" as const }));
  value.seats.push({
    ...structuredClone(value.seats[0]),
    seat: "IDLE-1",
    state: "idle",
    since: 0,
    calls: [],
    recent: [],
    scope: { read: [], modified: [] },
    badges: { ...value.seats[0].badges, questions: [], waiting: null },
  });
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Impact" }));

  const key = screen.getByRole("note", { name: "Impact colour scale" });
  expect(key.querySelectorAll(".map-key-seat-chip")).toHaveLength(2);
  expect(key.textContent).toContain("GUIDO-1");
  expect(key.textContent).toContain("INCO-1");
  expect(key.textContent).toContain("1 idle");
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

it("draws Changes as a coloured treemap and gives every working seat a timeline row", () => {
  const value = snapshot();
  const now = Date.now();
  value.seats[0].recent = [{ file: "src/contract.ts", at: now - 10_000 }];
  value.seats[1].recent = [{ file: "src/consumer.ts", at: now - 5_000 }];
  render(<CrewMapView snapshot={value} />);

  expect(screen.getByRole("img", { name: "Changes treemap" })).toBeTruthy();
  expect(screen.getByRole("note", { name: "Changes colour key" }).textContent).toContain(
    "read only",
  );
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/contract.ts']")
      ?.getAttribute("data-changed"),
  ).toBe("GUIDO-1");
  expect(
    document
      .querySelector(".map-treemap-tile[title='src/consumer.ts']")
      ?.getAttribute("data-changed"),
  ).toBe("INCO-1");
  expect(screen.getAllByRole("listitem", { name: /timeline for/i })).toHaveLength(2);
});

function playSnapshot() {
  const value = snapshot();
  const now = Date.now();
  value.seats[0].recent = [
    { file: "src/contract.ts", at: now - 18 * 60_000 },
    { file: "src/cycle.ts", at: now - 15 * 60_000 },
    { file: "src/untested.ts", at: now - 12 * 60_000 },
    { file: "src/consumer.ts", at: now - 40 * 60_000 },
  ];
  value.seats[1].recent = [{ file: "src/consumer.ts", at: now - 14 * 60_000 }];
  return value;
}
const tile = (path: string) =>
  document.querySelector(`.map-treemap-tile[title='${path}']`) as HTMLElement;
const playback = () => screen.getByRole("status", { name: "Playback" }).textContent;

it("restores win, play and step from the hash, replays on the treemap and timeline, and writes them back", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "#win=10,20&play=GUIDO-1&step=2");
    render(<CrewMapView snapshot={playSnapshot()} />);

    // the window is 20 to 10 minutes ago: the 40 minute old tick is outside it
    expect(screen.getByRole("button", { name: "Clear window" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(playback()).toContain("step 2 of 3");
    expect(screen.getByRole("button", { name: "■ Stop" })).toBeTruthy();
    // only the replayed seat's files so far carry a step marker; the current one is outlined
    expect(tile("src/contract.ts").querySelector(".map-treemap-mark")?.textContent).toBe("1");
    expect(tile("src/cycle.ts").querySelector(".map-treemap-mark")?.textContent).toBe("2");
    expect(tile("src/cycle.ts").hasAttribute("data-play-current")).toBe(true);
    expect(tile("src/contract.ts").hasAttribute("data-play-current")).toBe(false);
    expect(tile("src/untested.ts").querySelector(".map-treemap-mark")).toBeNull();
    expect(tile("src/untested.ts").hasAttribute("data-changed")).toBe(false);
    // the other seat's change is hidden while GUIDO-1 plays
    expect(tile("src/consumer.ts").hasAttribute("data-changed")).toBe(false);
    expect(document.querySelectorAll(".map-timeline-tick[data-current]")).toHaveLength(1);
    expect(document.querySelectorAll(".map-timeline-playhead")).toHaveLength(2);

    act(() => vi.advanceTimersByTime(400));
    expect(playback()).toContain("step 3 of 3");
    expect(tile("src/untested.ts").hasAttribute("data-play-current")).toBe(true);
    expect(tile("src/untested.ts").dataset.changed).toBe("GUIDO-1");
    expect(window.location.hash).toBe("#win=10%2C20&play=GUIDO-1&step=3");
    expect(screen.getByRole("button", { name: "↺ Reset" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear window" }));
    expect(window.location.hash).toBe("#play=GUIDO-1&step=3");
    expect(screen.getByRole("button", { name: "Clear window" }).hasAttribute("disabled")).toBe(
      true,
    );

    // widening the window to the whole hour adds the 40 minute old tick: 3 of 4, still going
    expect(playback()).toContain("step 3 of 4");
    act(() => vi.advanceTimersByTime(400));
    expect(playback()).toContain("step 4 of 4");

    // Reset ends the replay and shows every seat again
    fireEvent.click(screen.getByRole("button", { name: "↺ Reset" }));
    expect(window.location.hash).toBe("");
    expect(playback()).toBe("");
    expect(document.querySelector(".map-treemap-mark")).toBeNull();
    expect(tile("src/consumer.ts").dataset.changed).toBe("INCO-1");
  } finally {
    vi.useRealTimers();
    window.history.replaceState(null, "", window.location.pathname);
  }
});

it("plays the row picked in the timeline, not the first", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", window.location.pathname);
    render(<CrewMapView snapshot={playSnapshot()} />);
    expect(screen.getByRole("button", { name: "▶ Play GUIDO-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay INCO-1" }));
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "▶ Play INCO-1" }));
    expect(window.location.hash).toBe("#play=INCO-1&step=1");
    expect(playback()).toBe("INCO-1 step 1 of 1 · changed consumer.ts");
    expect(tile("src/consumer.ts").querySelector(".map-treemap-mark")?.textContent).toBe("1");
    expect(tile("src/contract.ts").hasAttribute("data-changed")).toBe(false);
    // a one-tick replay is already complete
    expect(screen.getByRole("button", { name: "↺ Reset" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "↺ Reset" }));
    expect(window.location.hash).toBe("");
  } finally {
    vi.useRealTimers();
    window.history.replaceState(null, "", window.location.pathname);
  }
});

it("splits a tile between two changers and rings it for two readers, in config colours", () => {
  const value = snapshot();
  value.seats[1].scope.modified.push({ file: "src/contract.ts", add: 180, rem: 0, source: "diff" });
  value.seats.push(
    {
      ...structuredClone(value.seats[0]),
      seat: "READ-1",
      scope: { read: ["src/cycle.ts"], modified: [] },
    },
    {
      ...structuredClone(value.seats[0]),
      seat: "READ-2",
      scope: { read: ["src/cycle.ts"], modified: [] },
    },
  );
  render(
    <CrewMapView
      snapshot={value}
      indices={{ "GUIDO-1": 4, "INCO-1": 5, "READ-1": 2, "READ-2": 6 }}
    />,
  );
  const shared = tile("src/contract.ts");
  expect(shared.dataset.changed).toBe("GUIDO-1 INCO-1");
  expect(shared.style.getPropertyValue("--tile-colour")).toBe("var(--seat-5)");
  expect(shared.style.getPropertyValue("--tile-colour-2")).toBe("var(--seat-6)");
  // 4 changed lines against 180: the first and last magnitude bands
  expect(shared.style.getPropertyValue("--tile-intensity")).toBe("0.42");
  expect(shared.style.getPropertyValue("--tile-intensity-2")).toBe("1");
  const read = tile("src/cycle.ts");
  expect(read.dataset.read).toBe("READ-1 READ-2");
  expect(read.dataset.neutral).toBe("true");
  expect(read.style.getPropertyValue("--tile-read-colour")).toBe("var(--seat-3)");
  expect(read.style.getPropertyValue("--tile-read-colour-2")).toBe("var(--seat-7)");
});

it("buckets changed lines into the mockup's four magnitude bands", () => {
  expect([1, 10, 11, 40, 41, 120, 121].map(changeIntensity)).toEqual([
    0.42, 0.42, 0.6, 0.6, 0.8, 0.8, 1,
  ]);
});

it("keeps branch-only files and recent reads visible and searchable", () => {
  const value = snapshot();
  value.seats[0].scope.modified.push({ file: "src/new.ts", add: 1, rem: 0, source: "diff" });
  value.seats[1].scope.read = [];
  value.seats[1].recent = [{ file: "src/isolated-read.ts", at: Date.now() }];
  render(<CrewMapView snapshot={value} />);
  expect(tile("src/new.ts").dataset.changed).toBe("GUIDO-1");
  // an idle path with no scope.read still colours as a read
  expect(tile("src/isolated-read.ts").dataset.read).toBe("INCO-1");
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file or folder" }), {
    target: { value: "new.ts" },
  });
  fireEvent.click(screen.getByRole("button", { name: "src/new.ts" }));
  expect(screen.getByRole("heading", { name: "src/new.ts" })).toBeTruthy();
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

it("marks files fixed often at the v3 absolute or proportional thresholds", () => {
  expect(isFixHeavy(5, 100)).toBe(true);
  expect(isFixHeavy(3, 6)).toBe(true);
  expect(isFixHeavy(4, 8)).toBe(true);
  expect(isFixHeavy(3, 7)).toBe(false);
  expect(isFixHeavy(4, 0)).toBe(false);
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
