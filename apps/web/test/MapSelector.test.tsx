import { type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";

vi.mock("../src/map/MapScene.tsx", () => ({
  MapScene: ({
    seat,
    seatFocus,
  }: {
    seat: string | null;
    seatFocus: { seat: string; request: number } | null;
  }) => (
    <div data-testid="scene" data-seat={seat ?? ""} data-seat-focus={seatFocus?.seat ?? ""}>
      3D scene
    </div>
  ),
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
      prs={{ "GUIDO-1": 31 }}
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
  expect(light(rows[0])).toBe("var(--s3)");
  expect(light(rows[1])).toBe("var(--fg-2)");
  // nothing else on a row: no state, counts, badges or notes
  expect(rows[0]?.children).toHaveLength(3);
  expect(await screen.findByTestId("scene")).toBeTruthy();
});

it("selects and follows a seat from its row, shows its card, and lets go on a second click", () => {
  render(<CrewMapView snapshot={crew()} prs={{ "GUIDO-1": 31 }} />);
  const row = screen.getByRole("button", { name: /^GUIDO-1/ });
  fireEvent.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");
  const scene = screen.getByTestId("scene");
  expect(scene.dataset.seat).toBe("GUIDO-1");
  expect(scene.dataset.seatFocus).toBe("GUIDO-1");
  const card = screen.getByRole("complementary", { name: "Selection detail" });
  expect(within(card).getByRole("heading", { name: "GUIDO-1" })).toBeTruthy();
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
