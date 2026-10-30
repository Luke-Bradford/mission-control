import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { graph, impactFocusLinks, lensVisuals } from "../src/map/Lenses.tsx";
import { changeIntensity, historyHeat, isFixHeavy, treemapLayout } from "../src/map/MapTreemap.tsx";

// Clock times need the operator's timezone, which the hub would load from /api/config.
vi.mock("../src/clock.ts", async (original) => ({
  ...(await original<typeof import("../src/clock.ts")>()),
  useTz: () => "Europe/London",
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

const tileAt = (path: string) => document.querySelector<HTMLElement>(`[title='${path}']`);

it("shows the Ownership no-data state when rules are absent", () => {
  const value = snapshot();
  (value as { rules?: MapSnapshot["rules"] }).rules = undefined;
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  expect(screen.getByRole("group", { name: "Ownership treemap" })).toBeTruthy();
  const lens = screen.getByRole("region", { name: "Ownership lens" });
  expect(lens.textContent).toContain("Ownership rules are not available");
  expect(screen.getByRole("note", { name: "Ownership colour key" }).textContent).toContain(
    "unavailable",
  );
});

function ownershipSnapshot() {
  const value = snapshot();
  value.rules = {
    areas: { "area:web": ["src/consumer.ts", "src/contract.ts"], "area:core": ["lib/**"] },
    hardRules: ["src/contract.ts", "src/unowned.ts"],
  };
  value.tree = [
    ...value.tree.filter((file) => file.path !== "src/untested.ts"),
    { path: "src/unowned.ts", lines: 10 },
    { path: "lib/deep/util.ts", lines: 20 },
    { path: "lib/deep/more.ts", lines: 20 },
  ];
  return value;
}

it("colours Ownership tiles by area, hatches hard-rule files, and leaves unowned files neutral", () => {
  render(<CrewMapView snapshot={ownershipSnapshot()} />);

  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  const contract = tileAt("src/contract.ts");
  expect(contract?.getAttribute("data-area")).toBe("area:web");
  expect(contract?.hasAttribute("data-hard-rule")).toBe(true);
  expect(contract?.style.getPropertyValue("--tile-colour")).toBe("var(--r1)");
  // a glob list matches any of its globs, `**` crosses folders
  expect(tileAt("lib/deep/util.ts")?.getAttribute("data-area")).toBe("area:core");
  expect(tileAt("lib/deep/util.ts")?.style.getPropertyValue("--tile-colour")).toBe("var(--r3)");
  // a file no area owns is neutral, unless it is hard-rule
  const unowned = tileAt("src/unowned.ts");
  expect(unowned?.hasAttribute("data-area")).toBe(false);
  expect(unowned?.hasAttribute("data-hard-rule")).toBe(true);
  expect(unowned?.hasAttribute("data-neutral")).toBe(false);
  const plain = tileAt("src/cycle.ts");
  expect(plain?.hasAttribute("data-neutral")).toBe(true);
  expect(plain?.hasAttribute("data-hard-rule")).toBe(false);
  // the folder holding owned files takes its area's tint
  expect(document.querySelector(".map-treemap-folder[data-area='area:core']")).toBeTruthy();
});

it("counts the files an area owns, not every file, and the configured areas, not 'none'", () => {
  const value = ownershipSnapshot();
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  const owned = value.tree.filter((file) =>
    ["src/consumer.ts", "src/contract.ts", "lib/deep/util.ts", "lib/deep/more.ts"].includes(
      file.path,
    ),
  ).length;
  expect(owned).toBeLessThan(value.tree.length);
  const lens = screen.getByRole("region", { name: "Ownership lens" });
  const kpis = lens.querySelector(".map-lens-kpis")?.textContent ?? "";
  expect(kpis).toContain(`${owned}of ${value.tree.length} files owned by an area`);
  expect(kpis).toContain("2areas");
  expect(lens.textContent).toContain("none");
  expect(lens.textContent).toContain("everything else");
  expect(screen.getByRole("note", { name: "Ownership colour key" }).textContent).toContain(
    `${owned} of ${value.tree.length} files owned by an area · 2 hard-rule`,
  );
});

it("lists the hard-rule files a seat changed in the Ownership pane", () => {
  render(<CrewMapView snapshot={ownershipSnapshot()} />);

  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  const lens = screen.getByRole("region", { name: "Ownership lens" });
  const section = [...lens.querySelectorAll(".map-lens-section")].find((el) =>
    el.querySelector("h3")?.textContent?.startsWith("Hard-rule files changed"),
  );
  expect(section?.querySelector("h3")?.textContent).toContain("1 of 2");
  expect(section?.textContent).toContain("src/contract.ts");
  expect(section?.textContent).not.toContain("src/consumer.ts");
});

function reviewSnapshot() {
  const value = snapshot();
  const finding = (file: string, severity: "Critical" | "Important" | "Minor", line: number) => ({
    seat: "GUIDO-1",
    ticket: 7,
    round: 2,
    severity,
    file,
    line,
    summary: `${severity} at ${file}:${line}`,
    scenario: "A consumer imports the changed contract.",
    fix: "Preserve the existing shape.",
  });
  value.findings = [
    // a file with two Important findings, listed first, then a file with a Critical one
    finding("src/contract.ts", "Important", 12),
    finding("src/contract.ts", "Important", 30),
    finding("src/consumer.ts", "Minor", 1),
    finding("src/consumer.ts", "Critical", 4),
  ];
  return value;
}

it("shows Review severity colouring, the count on a file, and the rows", () => {
  render(<CrewMapView snapshot={reviewSnapshot()} />);

  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(screen.getByRole("group", { name: "Review findings treemap" })).toBeTruthy();
  const consumer = tileAt("src/consumer.ts");
  expect(consumer?.getAttribute("data-severity")).toBe("Critical");
  expect(consumer?.getAttribute("data-findings")).toBe("2");
  expect(consumer?.style.getPropertyValue("--tile-colour")).toBe("var(--rem)");
  const contract = tileAt("src/contract.ts");
  expect(contract?.getAttribute("data-severity")).toBe("Important");
  expect(contract?.style.getPropertyValue("--tile-colour")).toBe("var(--warn-mark)");
  expect(tileAt("src/cycle.ts")?.hasAttribute("data-neutral")).toBe(true);
  const lens = screen.getByRole("region", { name: "Review lens" });
  expect(lens.textContent).toContain("Important at src/contract.ts:12");
  expect(lens.textContent).toContain("line 12");
  expect(screen.getByRole("note", { name: "Review severity key" }).textContent).toContain(
    "4 findings on 2 files",
  );
});

it("orders Review files by their highest severity, then by finding count", () => {
  render(<CrewMapView snapshot={reviewSnapshot()} />);

  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const lens = screen.getByRole("region", { name: "Review lens" });
  const files = [...lens.querySelectorAll<HTMLElement>(".map-lens-file")].map((el) =>
    el.getAttribute("aria-label"),
  );
  // consumer has a Critical finding, so it leads contract's two Important ones
  expect(files).toEqual(["src/consumer.ts", "src/contract.ts"]);
});

it("says so when Review has no findings", () => {
  const value = snapshot();
  value.findings = [];
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(screen.getByRole("region", { name: "Review lens" }).textContent).toContain(
    "No review findings",
  );
  expect(tileAt("src/contract.ts")?.hasAttribute("data-neutral")).toBe(true);
});

function conflictSnapshot() {
  const value = snapshot();
  value.seats[0] = {
    ...value.seats[0],
    branches: ["feature/7-contract"],
    tickets: { "feature/7-contract": 7 },
  };
  value.seats[1] = {
    ...value.seats[1],
    branches: ["feature/8-consumer"],
    tickets: { "feature/8-consumer": 8 },
  };
  value.conflicts = [
    {
      file: "src/consumer.ts",
      branches: ["feature/7-contract", "feature/8-consumer"],
      shas: ["aaaaaaa", "bbbbbbb"],
    },
    {
      file: "src/contract.ts",
      branches: ["feature/7-contract", "feature/8-consumer"],
      shas: ["aaaaaaa", "bbbbbbb"],
    },
  ];
  return value;
}

it("outlines Conflicts files over the seats' faded changes", () => {
  render(<CrewMapView snapshot={conflictSnapshot()} />);

  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  expect(screen.getByRole("group", { name: "Conflicts treemap" })).toBeTruthy();
  const consumer = tileAt("src/consumer.ts");
  expect(consumer?.hasAttribute("data-conflict")).toBe(true);
  expect(consumer?.style.getPropertyValue("--tile-colour")).toBe("var(--seat-2)");
  // 4 changed lines is the first band, 0.42, at the Conflicts lens's 0.3 strength
  expect(Number(consumer?.style.getPropertyValue("--tile-intensity"))).toBeCloseTo(0.126, 3);
  // a changed file that does not conflict keeps its fade and no outline
  const untested = tileAt("src/untested.ts");
  expect(untested?.hasAttribute("data-conflict")).toBe(false);
  expect(untested?.hasAttribute("data-neutral")).toBe(false);
  expect(tileAt("src/cycle.ts")?.hasAttribute("data-neutral")).toBe(true);
});

it("names each conflict's tickets, seats and branch pairs", () => {
  render(
    <CrewMapView snapshot={conflictSnapshot()} names={{ "GUIDO-1": "Guido", "INCO-1": "Inco" }} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  const lens = screen.getByRole("region", { name: "Conflicts lens" });
  expect(lens.textContent).toContain("2 files that conflict between open branches · 1 branch pair");
  const first = lens.querySelectorAll(".map-lens-section")[0];
  expect(first?.textContent).toContain("#7");
  expect(first?.textContent).toContain("feature/7-contract");
  expect(first?.textContent).toContain("Guido");
  expect(first?.textContent).toContain("#8");
  expect(first?.textContent).toContain("Inco");
  expect(first?.textContent).toContain("Inco changed it here");
  expect(screen.getByRole("note", { name: "Conflicts colour key" }).textContent).toContain(
    "1 branch pair",
  );
});

it("says so when no open branches conflict", () => {
  const value = snapshot();
  value.conflicts = [];
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  expect(screen.getByRole("region", { name: "Conflicts lens" }).textContent).toContain(
    "No merge conflicts",
  );
});

it("matches ownership globs as the server does: root `**/` globs, bare folders, folded hard-rule case", () => {
  const value = snapshot();
  value.tree = [
    { path: "CLAUDE.md", lines: 5 },
    { path: "docs/guide/a.md", lines: 5 },
    { path: "Loops/run.ts", lines: 5 },
    { path: "src/a.ts", lines: 5 },
  ];
  value.rules = {
    areas: { "area:docs": ["docs"] },
    hardRules: ["**/CLAUDE.md", "loops/**"],
  };
  const visual = lensVisuals(value, "ownership", null);
  // a glob naming a folder covers what is inside it
  expect(visual["docs/guide/a.md"]?.area).toBe("area:docs");
  expect(visual["src/a.ts"]?.area).toBeUndefined();
  // `**/CLAUDE.md` includes the top-level file
  expect(visual["CLAUDE.md"]?.hardRule).toBe(true);
  // hard rules fold case, as the engine does
  expect(visual["Loops/run.ts"]?.hardRule).toBe(true);
  expect(visual["src/a.ts"]?.hardRule).toBe(false);
});

it("colours areas by their place in the rules, through a fourth area", () => {
  const value = snapshot();
  value.tree = ["a", "b", "c", "d"].map((dir) => ({ path: `${dir}/x.ts`, lines: 5 }));
  value.rules = {
    areas: { "area:a": ["a/**"], "area:b": ["b/**"], "area:c": ["c/**"], "area:d": ["d/**"] },
    hardRules: [],
  };
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  const colours = ["a", "b", "c", "d"].map((dir) =>
    tileAt(`${dir}/x.ts`)?.style.getPropertyValue("--tile-colour"),
  );
  expect(colours).toEqual(["var(--r1)", "var(--r3)", "var(--r2)", "var(--r4)"]);
  expect(new Set(colours).size).toBe(4);
  // the key and the coverage bar use the same colours
  const swatches = [...document.querySelectorAll<HTMLElement>(".map-key-area")].map((el) =>
    el.style.getPropertyValue("--map-key-area"),
  );
  expect(swatches).toEqual(colours);
});

it("describes each tile for assistive technology, in the lens's terms", () => {
  render(<CrewMapView snapshot={ownershipSnapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  expect(tileAt("src/contract.ts")?.getAttribute("aria-description")).toBe("area:web, hard-rule");
  expect(tileAt("src/unowned.ts")?.getAttribute("aria-description")).toBe("no area, hard-rule");
  cleanup();

  render(<CrewMapView snapshot={reviewSnapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(tileAt("src/consumer.ts")?.getAttribute("aria-description")).toBe(
    "2 findings, top severity Critical",
  );
  cleanup();

  render(<CrewMapView snapshot={conflictSnapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  expect(tileAt("src/consumer.ts")?.getAttribute("aria-description")).toBe(
    "conflicts between feature/7-contract, feature/8-consumer",
  );
});

it("names seats by call sign in Ownership and Review, and shows hard-rule lines per seat", () => {
  const names = { "GUIDO-1": "Guido", "INCO-1": "Inco" };
  render(<CrewMapView snapshot={ownershipSnapshot()} names={names} />);
  fireEvent.click(screen.getByRole("button", { name: "Ownership" }));
  const ownership = screen.getByRole("region", { name: "Ownership lens" });
  expect(ownership.textContent).toContain("Guido");
  expect(ownership.textContent).not.toContain("GUIDO-1");
  const hard = [...ownership.querySelectorAll(".map-lens-section")].find((el) =>
    el.querySelector("h3")?.textContent?.startsWith("Hard-rule files changed"),
  );
  expect(hard?.textContent).toContain("+3");
  expect(hard?.textContent).toContain("−1");
  expect(hard?.querySelector(".map-lens-seat-dot")).toBeTruthy();
  cleanup();

  render(<CrewMapView snapshot={reviewSnapshot()} names={names} />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const review = screen.getByRole("region", { name: "Review lens" });
  expect(review.textContent).toContain("Guido");
  expect(review.textContent).not.toContain("GUIDO-1");
});

it("counts a file once however many branch pairs it conflicts on, and groups the pane by file", () => {
  const value = conflictSnapshot();
  value.conflicts = [
    {
      file: "src/consumer.ts",
      branches: ["feature/7-contract", "feature/8-consumer"],
      shas: ["a", "b"],
    },
    {
      file: "src/consumer.ts",
      branches: ["feature/7-contract", "feature/9-other"],
      shas: ["a", "c"],
    },
  ];
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  const lens = screen.getByRole("region", { name: "Conflicts lens" });
  expect(lens.querySelector("header")?.textContent).toContain(
    "1 file conflicts between open branches · 2 branch pairs",
  );
  expect(lens.querySelectorAll(".map-lens-file")).toHaveLength(1);
  expect(lens.querySelectorAll(".map-lens-pair")).toHaveLength(2);
  expect(screen.getByRole("note", { name: "Conflicts colour key" }).textContent).toContain(
    "1 file conflicts between open branches · 2 branch pairs",
  );
});

it("never says no conflicts when some branches went unchecked", () => {
  const value = snapshot();
  value.conflicts = [];
  value.conflictsUnchecked = [
    { branch: "feature/7-a", reason: "head not fetched" },
    { branch: "feature/8-b", reason: "merge check failed" },
  ];
  render(<CrewMapView snapshot={value} />);

  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  const text = screen.getByRole("region", { name: "Conflicts lens" }).textContent ?? "";
  expect(text).toContain("No conflicts among the branches checked · 2 unchecked");
  expect(text).not.toContain("No merge conflicts");
  const key = screen.getByRole("note", { name: "Conflicts colour key" }).textContent ?? "";
  expect(key).toContain("No conflicts among the branches checked · 2 unchecked");
  expect(key).not.toContain("No merge conflicts");
});

it("gives a conflicting file that is new on its branches a tile, in Changes and Conflicts alike", () => {
  const value = conflictSnapshot();
  value.conflicts = [
    {
      file: "src/new.ts",
      branches: ["feature/7-contract", "feature/8-consumer"],
      shas: ["a", "b"],
    },
  ];
  render(<CrewMapView snapshot={value} />);
  expect(tileAt("src/new.ts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
  expect(tileAt("src/new.ts")?.hasAttribute("data-conflict")).toBe(true);
  // the lenses that do not lay out branch-only files leave it out
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(tileAt("src/new.ts")).toBeNull();
});

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
  expect(screen.getByRole("group", { name: "Impact reach treemap" })).toBeTruthy();
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
  expect(screen.getByRole("group", { name: "History PR heat treemap" })).toBeTruthy();
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

  expect(screen.getByRole("group", { name: "Changes treemap" })).toBeTruthy();
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

it("lists only working seats on the timeline, with a tick for each access and read ticks round", () => {
  const value = snapshot();
  const now = Date.now();
  value.seats[0].recent = [
    { file: "src/contract.ts", at: now - 4 * MIN },
    { file: "src/cycle.ts", at: now - 2 * MIN },
  ];
  value.seats[1].recent = [{ file: "src/consumer.ts", at: now - 3 * MIN }];
  // an idle seat that has been docked for a while is not a row
  value.seats.push({
    ...structuredClone(value.seats[0]),
    seat: "IDLE-1",
    badges: { ...value.seats[0].badges, questions: [], waiting: null },
    state: "idle",
    since: now - 20 * MIN,
    calls: [],
    recent: [],
    scope: { read: [], modified: [] },
  });
  render(<CrewMapView snapshot={value} />);
  const rows = screen.getAllByRole("listitem", { name: /timeline for/i });
  expect(rows).toHaveLength(2);
  const ticks = (row: HTMLElement) => [...row.querySelectorAll(".map-timeline-tick")];
  expect(ticks(rows[0] as HTMLElement)).toHaveLength(2);
  expect(ticks(rows[0] as HTMLElement).map((t) => t.hasAttribute("data-read"))).toEqual([
    false,
    true,
  ]);
  expect(ticks(rows[1] as HTMLElement)).toHaveLength(1);
  expect(ticks(rows[1] as HTMLElement)[0]?.hasAttribute("data-read")).toBe(false);
  expect(document.querySelector(".map-timeline-axis")?.textContent).toContain("now");
});

const MIN = 60_000;
function playSnapshot() {
  const value = snapshot();
  const now = Date.now();
  value.seats[0].recent = [
    { file: "src/contract.ts", at: now - 11 * MIN },
    { file: "src/cycle.ts", at: now - 8 * MIN },
    { file: "src/untested.ts", at: now - 5 * MIN },
  ];
  value.seats[1].recent = [{ file: "src/consumer.ts", at: now - 14 * MIN }];
  return value;
}
const tile = (path: string) =>
  document.querySelector(`.map-treemap-tile[title='${path}']`) as HTMLElement;
const mark = (path: string) => document.querySelector(`.map-treemap-mark[data-for='${path}']`);
const playback = () => document.querySelector(".map-timeline-step")?.textContent ?? null;
const announced = () => screen.getByRole("status", { name: "Playback" }).textContent;
const reset = () => window.history.replaceState(null, "", window.location.pathname);

it("restores win, play and step from the hash, frozen at its step, and writes them back", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "#foo=bar&win=12,3&play=GUIDO-1&step=2");
    render(<CrewMapView snapshot={playSnapshot()} />);

    // the window is 12 to 3 minutes ago: INCO-1's 14 minute old read of consumer is outside it
    expect(screen.getByRole("button", { name: "Clear window" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByText(/\d\d:\d\d – \d\d:\d\d selected/)).toBeTruthy();
    expect(playback()).toContain("step 2 of 3");
    // a link restores the step and waits there
    act(() => vi.advanceTimersByTime(2000));
    expect(playback()).toContain("step 2 of 3");
    expect(window.location.hash).toBe("#foo=bar&win=12,3&play=GUIDO-1&step=2");
    // only the replayed seat's files so far carry a step marker; the current one is outlined
    expect(mark("src/contract.ts")?.textContent).toBe("1");
    expect(mark("src/cycle.ts")?.textContent).toBe("2");
    expect(mark("src/cycle.ts")?.hasAttribute("data-current")).toBe(true);
    expect(mark("src/untested.ts")).toBeNull();
    expect(tile("src/cycle.ts").hasAttribute("data-play-current")).toBe(true);
    expect(tile("src/untested.ts").hasAttribute("data-changed")).toBe(false);
    expect(tile("src/consumer.ts").hasAttribute("data-changed")).toBe(false);
    expect(document.querySelectorAll(".map-timeline-tick[data-current]")).toHaveLength(1);
    expect(document.querySelectorAll(".map-timeline-playhead")).toHaveLength(2);
    // every tick is drawn, the window is an overlay
    expect(document.querySelectorAll(".map-timeline-tick")).toHaveLength(4);
    expect(document.querySelectorAll(".map-timeline-window")).toHaveLength(2);

    // a paused link offers Reset, not Stop
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    // Reset, then Play again: it runs on from step 1 to the end, other hash parts left alone
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(window.location.hash).toBe("#foo=bar&win=12,3");
    fireEvent.click(screen.getByRole("button", { name: "Play GUIDO-1" }));
    expect(window.location.hash).toBe("#foo=bar&win=12,3&play=GUIDO-1&step=1");
    act(() => vi.advanceTimersByTime(400));
    act(() => vi.advanceTimersByTime(400));
    expect(playback()).toContain("step 3 of 3");
    expect(tile("src/untested.ts").dataset.changed).toBe("GUIDO-1");
    expect(window.location.hash).toBe("#foo=bar&win=12,3&play=GUIDO-1&step=3");
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();

    // clearing the window leaves the replay's own sequence as it was
    fireEvent.click(screen.getByRole("button", { name: "Clear window" }));
    expect(window.location.hash).toBe("#foo=bar&play=GUIDO-1&step=3");
    expect(playback()).toContain("step 3 of 3");

    // Reset ends the replay and shows every seat again
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(window.location.hash).toBe("#foo=bar");
    expect(playback()).toBe("");
    expect(document.querySelector(".map-treemap-mark")).toBeNull();
    expect(tile("src/consumer.ts").dataset.changed).toBe("INCO-1");
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("follows a link opened in place, and ends a replay of a seat that is not on the timeline", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "#play=NOBODY&step=4");
    render(<CrewMapView snapshot={playSnapshot()} />);
    expect(window.location.hash).toBe("");
    expect(playback()).toBe("");
    // one click plays, not two
    fireEvent.click(screen.getByRole("button", { name: "Play GUIDO-1" }));
    expect(playback()).toContain("step 1 of 3");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    act(() => {
      window.history.replaceState(null, "", "#win=12,6");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(playback()).toBe("");
    expect(screen.getByRole("button", { name: "Clear window" }).hasAttribute("disabled")).toBe(
      false,
    );
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("plays the row picked in the timeline, not the first", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    expect(screen.getByRole("button", { name: "Play GUIDO-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay INCO-1" }));
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Play INCO-1" }));
    expect(window.location.hash).toBe("#play=INCO-1&step=1");
    expect(playback()).toMatch(/^INCO-1 step 1 of 1 · \d\d:\d\d · changed consumer\.ts$/);
    expect(mark("src/consumer.ts")?.textContent).toBe("1");
    expect(tile("src/contract.ts").hasAttribute("data-changed")).toBe(false);
    // a one-tick replay is already complete
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(window.location.hash).toBe("");
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("ends a replay when the lens changes, and shows no markers on the others", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    fireEvent.click(screen.getByRole("button", { name: "Play GUIDO-1" }));
    expect(document.querySelectorAll(".map-treemap-mark")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Impact" }));
    expect(window.location.hash).toBe("");
    expect(document.querySelector(".map-treemap-mark")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(playback()).toBe("");
    expect(document.querySelector(".map-treemap-mark")).toBeNull();
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("chooses a window by dragging the timeline, and the map drops what is outside it", () => {
  vi.useFakeTimers();
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const track = this.classList.contains("map-timeline-track");
      return {
        left: 0,
        top: 0,
        right: 1000,
        bottom: 0,
        x: 0,
        y: 0,
        width: track ? 1000 : 0,
        height: 0,
        toJSON() {},
      };
    });
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    expect(tile("src/untested.ts").dataset.changed).toBe("GUIDO-1");
    expect(tile("src/consumer.ts").dataset.changed).toBe("INCO-1");
    const list = screen.getByRole("list", { name: "Working seat timelines" });
    const trackEl = list.querySelector(".map-timeline-track") as HTMLElement;
    // a fifth to three fifths of the 15 minutes: 12 to 6 minutes ago
    fireEvent.pointerDown(trackEl, { clientX: 200, button: 0 });
    fireEvent.pointerMove(list, { clientX: 600 });
    expect(document.querySelectorAll(".map-timeline-window")).toHaveLength(2);
    fireEvent.pointerUp(list, { clientX: 600 });
    expect(window.location.hash).toBe("#win=12,6");
    expect(screen.getByText(/\d\d:\d\d – \d\d:\d\d selected/)).toBeTruthy();
    expect(tile("src/contract.ts").dataset.changed).toBe("GUIDO-1");
    expect(tile("src/untested.ts").hasAttribute("data-changed")).toBe(false);
    expect(tile("src/consumer.ts").hasAttribute("data-changed")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Clear window" }));
    expect(window.location.hash).toBe("");
    expect(tile("src/untested.ts").dataset.changed).toBe("GUIDO-1");
    expect(tile("src/consumer.ts").dataset.changed).toBe("INCO-1");

    // a bare click chooses nothing
    fireEvent.pointerDown(trackEl, { clientX: 300, button: 0 });
    fireEvent.pointerUp(list, { clientX: 300 });
    expect(window.location.hash).toBe("");
  } finally {
    rect.mockRestore();
    vi.useRealTimers();
    reset();
  }
});

it("offers nothing to replay when a linked window holds no ticks", () => {
  try {
    window.history.replaceState(null, "", "#win=2,1&play=GUIDO-1&step=2");
    render(<CrewMapView snapshot={playSnapshot()} />);
    const button = screen.getByRole("button", { name: "Nothing to replay" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(playback()).toBe("");
    // the stale replay is out of the link, the window stays
    expect(window.location.hash).toBe("#win=2,1");
  } finally {
    reset();
  }
});

it("drops a window that has scrolled out of the timeline's span", () => {
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "#win=12,6");
    render(<CrewMapView snapshot={playSnapshot()} />);
    expect(tile("src/untested.ts").hasAttribute("data-changed")).toBe(false);
    act(() => vi.advanceTimersByTime(20 * MIN));
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("button", { name: "Clear window" }).hasAttribute("disabled")).toBe(
      true,
    );
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("chooses a window from the preset buttons, and 'All' clears it", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    fireEvent.click(screen.getByRole("button", { name: "Last 5 min" }));
    expect(window.location.hash).toBe("#win=5,0");
    // only GUIDO-1's read of untested.ts, 5 minutes ago, is at the window's edge
    expect(tile("src/contract.ts").hasAttribute("data-changed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Last 10 min" }));
    expect(window.location.hash).toBe("#win=10,0");
    expect(tile("src/untested.ts").dataset.changed).toBe("GUIDO-1");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(window.location.hash).toBe("");
    expect(tile("src/contract.ts").dataset.changed).toBe("GUIDO-1");
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("announces a replay at its start and end only, not at each step", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    fireEvent.click(screen.getByRole("button", { name: "Play GUIDO-1" }));
    expect(announced()).toBe("Replaying GUIDO-1, 3 steps");
    act(() => vi.advanceTimersByTime(400));
    expect(announced()).toBe("");
    expect(playback()).toContain("step 2 of 3");
    act(() => vi.advanceTimersByTime(400));
    expect(announced()).toBe("GUIDO-1 replay finished");
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("leaves a folder whole when a seat reads the directory", () => {
  const value = snapshot();
  value.seats[1].scope.read = ["src", "src/contract.ts"];
  value.seats[1].recent = [{ file: "src", at: Date.now() }];
  value.seats[1].calls = [{ tool: "Bash", detail: "ls src", files: ["src"], since: Date.now() }];
  render(<CrewMapView snapshot={value} />);
  expect(tile("src")).toBeNull();
  for (const file of value.tree) expect(tile(file.path)).toBeTruthy();
  expect(tile("src/contract.ts").dataset.read).toBe("INCO-1");
  // and the layout never lets a path be both
  const layout = treemapLayout(
    [
      { path: "a/b/c.ts", lines: 5 },
      { path: "a/b", lines: 9 },
      { path: "d", lines: 3 },
      { path: "d/e.ts", lines: 3 },
    ],
    100,
    100,
  );
  expect(layout.tiles.map((t) => t.path).sort()).toEqual(["a/b/c.ts", "d"]);
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
  expect(shared.querySelector(".map-treemap-lines")?.textContent).toBe("+183 −1");
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
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file" }), {
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

it("names the seat, change size and import distance on every active tile", () => {
  render(<CrewMapView snapshot={snapshot()} />);
  const description = (path: string) => tile(path).getAttribute("aria-description");
  // Changes: who changed it and by how much
  expect(description("src/contract.ts")).toBe("changed by GUIDO-1, +3 −1");
  fireEvent.click(screen.getByRole("button", { name: "Impact" }));
  // Impact: the seat and how many imports away
  expect(description("src/contract.ts")).toBe("GUIDO-1, import distance 0");
  expect(description("test/consumer.test.ts")).toMatch(/^(GUIDO-1|INCO-1), import distance 1$/);
  // the distance is also drawn as text, where the tile has room
  expect(tile("test/consumer.test.ts").textContent).toContain("d1");
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(description("src/contract.ts")).toBe("59 merged PRs, 22 fixes");
});

it("makes every timeline tick a button that selects a window around it", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    const ticks = [...document.querySelectorAll(".map-timeline-tick")];
    expect(ticks.length).toBe(4);
    for (const t of ticks) expect(t.tagName).toBe("BUTTON");
    fireEvent.click(ticks[0] as HTMLElement);
    expect(window.location.hash).toMatch(/^#win=\d+(\.\d+)?,\d+(\.\d+)?$/);
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("moves, resizes and clears the timeline window with the arrow keys", () => {
  vi.useFakeTimers();
  try {
    reset();
    render(<CrewMapView snapshot={playSnapshot()} />);
    const list = screen.getByRole("list", { name: "Working seat timelines" });
    // no window yet: an arrow starts one at the end of the span
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(window.location.hash).toBe("#win=6,1");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(window.location.hash).toBe("#win=7,2");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(window.location.hash).toBe("#win=6,1");
    // shift grows or shrinks the window from its start
    fireEvent.keyDown(list, { key: "ArrowLeft", shiftKey: true });
    expect(window.location.hash).toBe("#win=7,1");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(window.location.hash).toBe("");
  } finally {
    vi.useRealTimers();
    reset();
  }
});

it("says 1 file for a one-file repository and N files otherwise", () => {
  const one = structuredClone(mapSnapshotFixture);
  one.tree = one.tree.slice(0, 1);
  const { unmount } = render(<CrewMapView snapshot={one} />);
  expect(screen.getAllByText("1 file").length).toBeGreaterThan(0);
  unmount();
  render(<CrewMapView snapshot={structuredClone(mapSnapshotFixture)} />);
  expect(screen.getAllByText(`${mapSnapshotFixture.tree.length} files`).length).toBeGreaterThan(0);
});
