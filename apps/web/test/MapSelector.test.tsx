import { MAP_RECENT_MS, type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";

const scenes = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../src/map/MapScene.tsx", () => ({
  MapScene: (props: { seat: string | null; seatFocus: { seat: string } | null }) => {
    scenes.push(props);
    return (
      <div
        data-testid="scene"
        data-seat={props.seat ?? ""}
        data-seat-focus={props.seatFocus?.seat ?? ""}
      >
        3D scene
      </div>
    );
  },
}));

const quiet = (seat: string, over: Partial<MapSeat> = {}): MapSeat => ({
  ...structuredClone(mapSnapshotFixture.seats[0]),
  seat,
  calls: [],
  recent: [],
  badges: { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null },
  ...over,
});

const crew = (): MapSnapshot => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats = [
    quiet("GUIDO-1", {
      state: "running",
      scope: {
        read: ["src/main.ts", "src/util.ts", "src/main.ts"],
        modified: [
          { file: "src/main.ts", add: 12, rem: 3, source: "diff" },
          { file: "src/util.ts", add: 4, rem: 0, source: "diff" },
        ],
      },
    }),
    // idle for long, nothing changed: not working, so not listed
    quiet("GUIDO-2", { state: "idle", since: 0, scope: { read: [], modified: [] } }),
    quiet("FLIGHT", {
      state: "running",
      ticket: null,
      title: null,
      scope: { read: [], modified: [] },
    }),
  ];
  return snapshot;
};

it("lists one row per working seat: its light, call sign and what it is on, and no more", async () => {
  render(
    <CrewMapView
      snapshot={crew()}
      indices={{ "GUIDO-1": 2 }}
      names={{ "GUIDO-1": "GUIDO-1" }}
      work={{ "GUIDO-1": { ticket: 7, title: "Handle empty input", pr: 31 } }}
    />,
  );
  const list = screen.getByRole("list", { name: "Seats working in this repo" });
  const rows = within(list).getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    "GUIDO-1#7 · PR #31 · Handle empty input",
    "FLIGHTno ticket",
  ]);
  // the light is the seat's colour, the same one the stage gives it
  const light = (row: HTMLElement | undefined) =>
    row?.querySelector<HTMLElement>(".map-light")?.style.getPropertyValue("--light");
  expect(light(rows[0])).toBe("var(--seat-3)");
  expect(light(rows[1])).toBe("var(--seat-flight)");
  // nothing else on a row: no state, counts, badges or notes
  expect(rows[0]?.children).toHaveLength(3);
  expect(await screen.findByTestId("scene")).toBeTruthy();
});

it("selects and follows a seat from its row, shows its card, and lets go on a second click", () => {
  render(
    <CrewMapView
      snapshot={crew()}
      work={{ "GUIDO-1": { ticket: 7, title: "Handle empty input", pr: 31 } }}
    />,
  );
  const row = screen.getByRole("button", { name: /^GUIDO-1/ });
  fireEvent.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");
  const scene = screen.getByTestId("scene");
  expect(scene.dataset.seat).toBe("GUIDO-1");
  expect(scene.dataset.seatFocus).toBe("GUIDO-1");
  const card = screen.getByRole("complementary", { name: "Selection detail" });
  expect(within(card).getByRole("heading", { level: 3, name: "GUIDO-1" })).toBeTruthy();
  expect(card.textContent).toContain("#7 · PR #31 · Handle empty input");
  const facts = Object.fromEntries(
    [...card.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );
  expect(facts.Changed).toBe("2 files · +16 −3");
  expect(facts.Read).toBe("2 files");
  expect(facts.Now).toBe("thinking");
  fireEvent.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByTestId("scene").dataset.seat).toBe("");
  expect(card.textContent).toContain("Pick a seat to follow it");
});

it("shows no warnings: no questions, failures, review, tests, CI, findings or conflicts", () => {
  // the fixture's seat has a question, a refusal, a review with a finding, tests and CI
  const snapshot: MapSnapshot = {
    ...structuredClone(mapSnapshotFixture),
    conflicts: [
      { file: "src/main.ts", branches: ["a", "b"], shas: ["1".repeat(40), "2".repeat(40)] },
    ],
    conflictsUnchecked: [{ branch: "feature/7-empty-input", reason: "merge check failed" }],
  };
  snapshot.seats[0].badges.waiting = {
    kind: "parked",
    since: 0,
    reason: "Needs CAPCOM",
    stopped: false,
  };
  const { container } = render(<CrewMapView snapshot={snapshot} />);
  fireEvent.click(screen.getByRole("button", { name: /^GUIDO-1/ }));
  const seatCard = container.textContent ?? "";
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file or folder" }), {
    target: { value: "main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "src/main.ts" }));
  for (const text of [seatCard, container.textContent ?? ""])
    for (const warning of [
      /question/i,
      /refused/i,
      /review/i,
      /finding/i,
      /Empty input throws/,
      /tests?:/i,
      /\bCI\b/,
      /conflict/i,
      /not checked/i,
      /waiting on you/i,
      /stuck/i,
      /[▲◆]/,
    ])
      expect(text).not.toMatch(warning);
  expect(container.querySelector(".map-badge, .map-drawer, .map-waits, .map-conflicts")).toBeNull();
});

it("names each row for a screen reader, and takes its ticket and PR from the crew row together", () => {
  render(
    <CrewMapView
      snapshot={crew()}
      // the crew row's run is on #9 with its PR; the map's changes are on #7
      work={{ "GUIDO-1": { ticket: 9, title: "Other work", pr: 31 } }}
    />,
  );
  expect(screen.getByRole("button", { name: "GUIDO-1: #9 · PR #31 · Other work" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "FLIGHT: no ticket" })).toBeTruthy();
  // without a crew row, the map's own ticket and title, and no PR
  const { unmount } = render(<CrewMapView snapshot={crew()} />);
  expect(screen.getByRole("button", { name: "GUIDO-1: #7 · Handle empty input" })).toBeTruthy();
  unmount();
  // the card holds a ticking "Now" line, so only a short status line announces the selection
  expect(
    screen
      .getAllByRole("complementary", { name: "Selection detail" })[0]
      ?.getAttribute("aria-live"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "GUIDO-1: #9 · PR #31 · Other work" }));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Selected GUIDO-1")).toBe(
    true,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

it("lets a resting seat's path age out on an open page as the clock ticks", () => {
  vi.useFakeTimers();
  const start = Date.now();
  const snapshot = crew();
  // GUIDO-2's run ended a minute ago: no changes, only the path the hub still keeps
  snapshot.seats[1] = quiet("GUIDO-2", {
    state: "idle",
    since: start - 60_000,
    recent: [{ file: "src/main.ts", at: start - 60_000 }],
    scope: { read: [], modified: [] },
  });
  render(<CrewMapView snapshot={snapshot} />);
  expect(screen.getByRole("button", { name: /^GUIDO-2/ })).toBeTruthy();
  act(() => vi.advanceTimersByTime(MAP_RECENT_MS - 60_000 + 6000));
  expect(screen.queryByRole("button", { name: /^GUIDO-2/ })).toBeNull();
});

it("hands the scene the same props on a clock tick that changed nothing, so it rebuilds nothing", async () => {
  vi.useFakeTimers();
  render(<CrewMapView snapshot={crew()} names={{}} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const before = scenes.at(-1) as Record<string, unknown>;
  const count = scenes.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(scenes.length).toBeGreaterThan(count);
  const after = scenes.at(-1) as Record<string, unknown>;
  for (const key of Object.keys(before)) expect([key, after[key]]).toEqual([key, before[key]]);
  for (const key of Object.keys(before))
    if (typeof before[key] === "object" || typeof before[key] === "function")
      expect(Object.is(after[key], before[key]), key).toBe(true);
});
