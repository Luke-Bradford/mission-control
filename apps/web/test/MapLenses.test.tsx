import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { changeIntensity, treemapLayout } from "../src/map/MapTreemap.tsx";

// Clock times need the operator's timezone, which the hub would load from /api/config.
vi.mock("../src/clock.ts", async (original) => ({
  ...(await original<typeof import("../src/clock.ts")>()),
  useTz: () => "Europe/London",
}));

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
it("gives a conflicting file that is new on its branches a tile, marked as a conflict", () => {
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
  expect(tileAt("src/new.ts")?.hasAttribute("data-conflict")).toBe(true);
});

it("names the seat and change size on every changed tile", () => {
  render(<CrewMapView snapshot={snapshot()} />);
  expect(tile("src/contract.ts").getAttribute("aria-description")).toBe(
    "changed by GUIDO-1, +3 −1",
  );
});
