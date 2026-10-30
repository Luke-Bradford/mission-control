import { type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
  ConflictDetail,
  conflictFiles,
  conflictPairs,
  conflictSummary,
  graph,
  HistoryLens,
  ImpactLens,
  OwnershipLens,
  ownershipOf,
  prSeats,
  ReviewLens,
} from "../src/lenses/lenses.tsx";

afterEach(cleanup);

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

/** The Impact panel with a focus of its own, as a page that hosts it keeps one. */
function Impact({ value, seats }: { value: MapSnapshot; seats?: readonly string[] }) {
  const [focus, setFocus] = useState<string | null>(null);
  return <ImpactLens snapshot={value} focus={focus} onFocus={setFocus} seats={seats} />;
}
function History({ value, github }: { value: MapSnapshot; github?: string }) {
  const [focus, setFocus] = useState<string | null>(null);
  return <HistoryLens snapshot={value} focus={focus} onFocus={setFocus} github={github} />;
}
const impact = () => screen.getByRole("region", { name: "Impact lens" });
const noop = () => {};

it("shows Impact tallies, dependency overlap, untested changes, cycles, and a focused import trace", () => {
  render(<Impact value={snapshot()} />);
  const lens = impact();
  expect(lens.textContent).toContain("2 files changed");
  expect(lens.textContent).toContain("1 import them");
  expect(lens.textContent).toContain("Changes overlap through imports");
  expect(lens.textContent).toContain("Changed, and no test imports them");
  expect(lens.textContent).toContain("Import cycles");
  expect(lens.textContent).toContain("src/untested.ts");

  const contract = within(lens).getAllByRole("button", { name: "src/contract.ts" })[0];
  if (contract === undefined) throw new Error("expected the changed contract file");
  fireEvent.click(contract);
  expect(lens.textContent).toContain("Imported by");
  expect(lens.textContent).toContain("Tests that reach it");
  expect(lens.textContent).toContain("It imports");
  expect(lens.textContent).toContain("3depend on it");
  expect(lens.textContent).not.toContain("Further downstreamsrc/contract.ts");
  fireEvent.click(screen.getByRole("button", { name: "← All files" }));
  expect(lens.textContent).toContain("Changes overlap through imports");
});

it("traces an indirect test when focused outside the changed reach", () => {
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
  const Focused = () => {
    const [focus, setFocus] = useState<string | null>("src/isolated.ts");
    return <ImpactLens snapshot={value} focus={focus} onFocus={setFocus} />;
  };
  render(<Focused />);
  expect(within(impact()).getAllByRole("button", { name: "test/isolated.test.ts" })).toHaveLength(
    1,
  );
});

it("marks only changed code files that import another seat's changed code as Impact overlap", () => {
  const overlapText = (value: MapSnapshot) => {
    render(<Impact value={value} />);
    const text = impact().textContent ?? "";
    cleanup();
    return text;
  };
  expect(overlapText(snapshot())).toContain("INCO-1 changed src/consumer.ts which depends on");
  const sharedImporter = snapshot();
  sharedImporter.imports = [
    { from: "test/consumer.test.ts", to: "src/contract.ts" },
    { from: "test/consumer.test.ts", to: "src/consumer.ts" },
  ];
  expect(overlapText(sharedImporter)).toContain("No seat changes a dependent file.");

  const sameFile = snapshot();
  sameFile.seats[1] = {
    ...sameFile.seats[1],
    scope: { read: [], modified: [{ file: "src/contract.ts", add: 4, rem: 0, source: "diff" }] },
  };
  expect(overlapText(sameFile)).toContain("No seat changes a dependent file.");
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
  render(<Impact value={value} />);
  expect(impact().textContent).not.toContain("README.md");
  expect(impact().textContent).not.toContain("config/map.yaml");
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
  render(<Impact value={value} />);
  const heading = screen.getByRole("heading", { name: "Changed, and no test imports them" });
  expect(heading.parentElement?.textContent).not.toContain("test/consumer.test.ts");
});

it("shows clean, deduplicated code tables", () => {
  const value = snapshot();
  value.tree.push(
    { path: "test/history.test.ts", lines: 12 },
    { path: "apps/server/src/account-bindings.ts", lines: 12 },
  );
  value.seats[1] = {
    ...value.seats[1],
    scope: {
      read: [],
      modified: [
        ...value.seats[1].scope.modified,
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
  render(<Impact value={value} />);
  expect(impact().textContent).toContain("tests · import · depend");
  expect(impact().textContent).toContain("Test files changed separately");
  expect(
    screen
      .getAllByTitle("apps/server/src/account-bindings.ts")
      .find((element) => element.classList.contains("map-lens-file"))?.textContent,
  ).toBe("…/server/src/account-bindings.ts");
  expect(screen.queryByRole("heading", { name: "IDLE-1" })).toBeNull();
});

/** A second seat that changed src/util.ts, so the first seat's main.ts depends on its changes. */
const utilChanger = (value: MapSnapshot): MapSeat => ({
  ...structuredClone(value.seats[0] as MapSeat),
  seat: "INCO-1",
  scope: { read: [], modified: [{ file: "src/util.ts", add: 3, rem: 0, source: "diff" }] },
});

it("says 1 step for a direct import and N steps for a longer chain in the Impact overlap", () => {
  const direct: MapSnapshot = structuredClone(mapSnapshotFixture);
  direct.seats.push(utilChanger(direct));
  const { unmount } = render(<Impact value={direct} />);
  expect(impact().textContent).toContain(
    "which depends on INCO-1’s changes · 1 step: main.ts → util.ts.",
  );
  unmount();

  const chained: MapSnapshot = structuredClone(mapSnapshotFixture);
  chained.tree = [
    { path: "src/main.ts", lines: 10 },
    { path: "src/mid.ts", lines: 10 },
    { path: "src/util.ts", lines: 10 },
  ];
  chained.imports = [
    { from: "src/main.ts", to: "src/mid.ts" },
    { from: "src/mid.ts", to: "src/util.ts" },
  ];
  chained.seats.push(utilChanger(chained));
  render(<Impact value={chained} />);
  expect(impact().textContent).toContain("· 2 steps: main.ts → mid.ts → util.ts.");
});

it("treats a branching import SCC as one audit unit", () => {
  const value = snapshot();
  value.tree = value.tree.filter((file) => file.path !== "src/untested.ts");
  value.imports = [
    { from: "src/contract.ts", to: "src/consumer.ts" },
    { from: "src/consumer.ts", to: "src/contract.ts" },
    { from: "src/contract.ts", to: "src/cycle.ts" },
    { from: "src/cycle.ts", to: "src/contract.ts" },
  ];
  expect(graph(value).cycles).toEqual([["src/consumer.ts", "src/contract.ts", "src/cycle.ts"]]);
});

it("ImpactLens with seats limits sections, overlap and untested rows to those seats", () => {
  const value = snapshot();
  // a third seat with its own untested file and its own cycle, away from the PR's seat
  value.tree.push(
    { path: "src/elsewhere.ts", lines: 12 },
    { path: "src/ring-a.ts", lines: 12 },
    { path: "src/ring-b.ts", lines: 12 },
  );
  value.imports.push(
    { from: "src/ring-a.ts", to: "src/ring-b.ts" },
    { from: "src/ring-b.ts", to: "src/ring-a.ts" },
  );
  value.seats.push({
    ...structuredClone(value.seats[0]),
    seat: "OTHER-1",
    scope: {
      read: [],
      modified: [
        { file: "src/elsewhere.ts", add: 5, rem: 0, source: "diff" },
        { file: "src/ring-a.ts", add: 5, rem: 0, source: "diff" },
      ],
    },
  });

  render(<Impact value={value} />);
  expect(impact().textContent).toContain("OTHER-1");
  expect(impact().textContent).toContain("src/elsewhere.ts");
  expect(impact().textContent).toContain("what the seats’ changes reach through imports");
  cleanup();

  render(<Impact value={value} seats={["GUIDO-1"]} />);
  const scoped = impact();
  expect(within(scoped).getByRole("heading", { name: "GUIDO-1" })).toBeTruthy();
  expect(within(scoped).queryByRole("heading", { name: "INCO-1" })).toBeNull();
  expect(within(scoped).queryByRole("heading", { name: "OTHER-1" })).toBeNull();
  expect(scoped.textContent).toContain("what this PR’s changes reach through imports");
  // the untested rows are this seat's files only
  const untested = screen.getByRole("heading", { name: "Changed, and no test imports them" })
    .parentElement as HTMLElement;
  expect(untested.textContent).toContain("src/untested.ts");
  expect(untested.textContent).not.toContain("elsewhere.ts");
  // INCO-1's consumer depends on GUIDO-1's contract: that overlap names a scoped seat, so it stays
  expect(scoped.textContent).toContain("INCO-1 changed src/consumer.ts which depends on");
  // the other seat's cycle goes; the one through the PR's contract stays
  const cycles = screen.getByRole("heading", { name: "Import cycles" })
    .parentElement as HTMLElement;
  expect(cycles.textContent).toContain("contract.ts");
  expect(cycles.textContent).not.toContain("ring-a.ts");
  cleanup();

  // overlap rows between two seats outside the scope are dropped
  render(<Impact value={value} seats={["OTHER-1"]} />);
  expect(impact().textContent).not.toContain("INCO-1 changed");
  expect(
    screen.getByRole("heading", { name: "Import cycles" }).parentElement?.textContent,
  ).toContain("ring-a.ts");
});

it("finds the seats that hold a PR's branch", () => {
  const value = snapshot();
  value.seats[0] = { ...value.seats[0], changedOn: ["feature/7-a", "feature/7-b"] };
  value.seats[1] = { ...value.seats[1], changedOn: ["feature/8-c"] };
  expect(prSeats(value, "feature/7-b").map((seat) => seat.seat)).toEqual(["GUIDO-1"]);
  expect(prSeats(value, "feature/9-none")).toEqual([]);
});

it("shows History hotspots, frequent fixes, unlinked change partners, and linked recent PRs on focus", () => {
  render(<History value={snapshot()} github="Luke-Bradford/mission-control" />);
  const lens = screen.getByRole("region", { name: "History lens" });
  expect(lens.textContent).toContain("Hotspots the seats are changing");
  expect(lens.textContent).toContain("Fixed most often");
  expect(lens.textContent).toContain("Change together, no import between them");
  expect(lens.textContent).toContain("59 · 22");
  expect(lens.textContent).toContain("PRs · fixes");
  const contract = within(lens).getAllByRole("button", { name: "src/contract.ts" })[0];
  if (contract === undefined) throw new Error("expected the changed contract file");
  fireEvent.click(contract);
  expect(lens.textContent).toContain("Latest PRs");
  expect(within(lens).getByRole("link", { name: "#837" }).getAttribute("href")).toBe(
    "https://github.com/Luke-Bradford/mission-control/pull/837",
  );
  expect(lens.textContent).toContain("Changes together with");
  fireEvent.click(screen.getByRole("button", { name: "← All files" }));
  expect(lens.textContent).toContain("Hotspots");
});

it("keeps test files out of the History hotspots", () => {
  const value = snapshot();
  value.tree.push({ path: "test/history.test.ts", lines: 12 });
  value.hist.files["5"] = [20, 9, Date.UTC(2026, 9, 28), [838]];
  render(<History value={value} />);
  const lens = screen.getByRole("region", { name: "History lens" });
  const hotspots = screen.getByRole("heading", { name: "Hotspots the seats are changing" })
    .parentElement as HTMLElement;
  expect(within(hotspots).getAllByRole("button", { name: "src/contract.ts" })).toHaveLength(1);
  expect(lens.textContent).not.toContain("history.test.ts");
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
const ownership = () => screen.getByRole("region", { name: "Ownership lens" });
const hardRuleSection = () =>
  [...ownership().querySelectorAll(".map-lens-section")].find((el) =>
    el.querySelector("h3")?.textContent?.startsWith("Hard-rule files changed"),
  );

it("shows the Ownership no-data state when rules are absent", () => {
  const value = snapshot();
  (value as { rules?: MapSnapshot["rules"] }).rules = undefined;
  render(<OwnershipLens snapshot={value} onFocus={noop} />);
  expect(ownership().textContent).toContain("Ownership rules are not available");
});

it("counts the files an area owns, not every file, and the configured areas, not 'none'", () => {
  const value = ownershipSnapshot();
  render(<OwnershipLens snapshot={value} onFocus={noop} />);
  const owned = value.tree.filter((file) =>
    ["src/consumer.ts", "src/contract.ts", "lib/deep/util.ts", "lib/deep/more.ts"].includes(
      file.path,
    ),
  ).length;
  expect(owned).toBeLessThan(value.tree.length);
  const kpis = ownership().querySelector(".map-lens-kpis")?.textContent ?? "";
  expect(kpis).toContain(`${owned}of ${value.tree.length} files owned by an area`);
  expect(kpis).toContain("2areas");
  expect(ownership().textContent).toContain("none");
  expect(ownership().textContent).toContain("everything else");
  // each area's globs are listed with its row
  expect(ownership().textContent).toContain("src/consumer.ts, src/contract.ts");
  expect(ownership().textContent).toContain("lib/**");
});

it("lists the hard-rule files a seat changed in the Ownership pane", () => {
  render(<OwnershipLens snapshot={ownershipSnapshot()} onFocus={noop} />);
  const section = hardRuleSection();
  expect(section?.querySelector("h3")?.textContent).toContain("1 of 2");
  expect(section?.textContent).toContain("src/contract.ts");
  expect(section?.textContent).not.toContain("src/consumer.ts");
});

it("matches ownership globs as the server does: root `**/` globs, bare folders, folded hard-rule case", () => {
  const value = snapshot();
  value.rules = {
    areas: { "area:docs": ["docs"] },
    hardRules: ["**/CLAUDE.md", "loops/**"],
  };
  const owner = ownershipOf(value.rules);
  // a glob naming a folder covers what is inside it
  expect(owner?.areaOf("docs/guide/a.md")).toBe("area:docs");
  expect(owner?.areaOf("src/a.ts")).toBeNull();
  // `**/CLAUDE.md` includes the top-level file
  expect(owner?.isHardRule("CLAUDE.md")).toBe(true);
  // hard rules fold case, as the engine does
  expect(owner?.isHardRule("Loops/run.ts")).toBe(true);
  expect(owner?.isHardRule("src/a.ts")).toBe(false);
});

it("colours areas by their place in the rules, through a fourth area", () => {
  const owner = ownershipOf({
    areas: { "area:a": ["a/**"], "area:b": ["b/**"], "area:c": ["c/**"], "area:d": ["d/**"] },
    hardRules: [],
  });
  const colours = ["area:a", "area:b", "area:c", "area:d"].map((area) => owner?.colours[area]);
  expect(colours).toEqual(["var(--r1)", "var(--r3)", "var(--r2)", "var(--r4)"]);
  expect(new Set(colours).size).toBe(4);
});

it("names seats by call sign in Ownership and Review, and shows hard-rule lines per seat", () => {
  const names = { "GUIDO-1": "Guido", "INCO-1": "Inco" };
  render(<OwnershipLens snapshot={ownershipSnapshot()} names={names} onFocus={noop} />);
  expect(ownership().textContent).toContain("Guido");
  expect(ownership().textContent).not.toContain("GUIDO-1");
  const hard = hardRuleSection();
  expect(hard?.textContent).toContain("+3");
  expect(hard?.textContent).toContain("−1");
  expect(hard?.querySelector(".map-lens-seat-dot")).toBeTruthy();
  cleanup();

  render(<ReviewLens snapshot={reviewSnapshot()} names={names} onFocus={noop} />);
  const review = screen.getByRole("region", { name: "Review lens" });
  expect(review.textContent).toContain("Guido");
  expect(review.textContent).not.toContain("GUIDO-1");
});

it("counts hard-rule files and findings, singular and plural", () => {
  const hardRules = (value: MapSnapshot): string => {
    render(<OwnershipLens snapshot={value} onFocus={noop} />);
    const text = hardRuleSection()?.querySelector("h3")?.textContent ?? "";
    cleanup();
    return text;
  };
  // contract.ts and unowned.ts are the two hard-rule files
  expect(hardRules(ownershipSnapshot())).toContain("1 of 2");
  const one = ownershipSnapshot();
  one.tree = one.tree.filter((file) => file.path !== "src/unowned.ts");
  expect(hardRules(one)).toContain("1 of 1");

  const single = reviewSnapshot();
  single.findings = single.findings.slice(0, 1);
  render(<ReviewLens snapshot={single} onFocus={noop} />);
  expect(screen.getByRole("region", { name: "Review lens" }).textContent).toContain(
    "1 finding on 1 file",
  );
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

it("shows Review rows with their severity, line and count", () => {
  render(<ReviewLens snapshot={reviewSnapshot()} onFocus={noop} />);
  const lens = screen.getByRole("region", { name: "Review lens" });
  expect(lens.textContent).toContain("Important at src/contract.ts:12");
  expect(lens.textContent).toContain("line 12");
  expect(lens.textContent).toContain("4 findings on 2 files");
});

it("orders Review files by their highest severity, then by finding count", () => {
  render(<ReviewLens snapshot={reviewSnapshot()} onFocus={noop} />);
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
  render(<ReviewLens snapshot={value} onFocus={noop} />);
  expect(screen.getByRole("region", { name: "Review lens" }).textContent).toContain(
    "No review findings",
  );
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

it("names a conflict's tickets, seats and branch pair", () => {
  const value = conflictSnapshot();
  render(
    <ConflictDetail
      snapshot={value}
      file="src/consumer.ts"
      names={{ "GUIDO-1": "Guido", "INCO-1": "Inco" }}
    />,
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("#7");
  expect(text).toContain("feature/7-contract");
  expect(text).toContain("Guido");
  expect(text).toContain("#8");
  expect(text).toContain("feature/8-consumer");
  expect(text).toContain("Inco");
  expect(text).toContain("Inco changed it here");
  expect(conflictSummary(value)).toContain(
    "2 files that conflict between open branches · 1 branch pair",
  );
});

it("renders nothing for a file that does not conflict", () => {
  const { container } = render(
    <ConflictDetail snapshot={conflictSnapshot()} file="src/cycle.ts" />,
  );
  expect(container.textContent).toBe("");
});

it("counts a file once however many branch pairs it conflicts on, and groups the detail by file", () => {
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
  expect(conflictFiles(value.conflicts)).toBe(1);
  expect(conflictPairs(value.conflicts)).toBe(2);
  expect(conflictSummary(value)).toBe("1 file conflicts between open branches · 2 branch pairs");
  const { container } = render(<ConflictDetail snapshot={value} file="src/consumer.ts" />);
  expect(container.querySelectorAll(".map-lens-pair")).toHaveLength(2);
});

it("never says no conflicts when some branches went unchecked", () => {
  const value = snapshot();
  value.conflicts = [];
  value.conflictsUnchecked = [
    { branch: "feature/7-a", reason: "head not fetched" },
    { branch: "feature/8-b", reason: "merge check failed" },
  ];
  const text = conflictSummary(value);
  expect(text).toContain("No conflicts among the branches checked · 2 unchecked");
  expect(text).not.toContain("No merge conflicts");
  value.conflictsUnchecked = [];
  expect(conflictSummary(value)).toBe("No merge conflicts found between open branches");
});
