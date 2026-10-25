import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";

vi.mock("../src/map/MapScene.tsx", () => ({ MapScene: () => <div>3D scene</div> }));
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(65_000));
afterEach(() => vi.restoreAllMocks());
const snapshot = (): MapSnapshot => structuredClone(mapSnapshotFixture);

it("renders fixture title, folder, counts and the run's actual context window", () => {
  render(<CrewMapView snapshot={snapshot()} indices={{ "GUIDO-1": 4 }} />);
  const card = screen.getByRole("article", { name: "GUIDO-1" });
  expect(card.textContent).toContain("Handle empty input");
  expect(card.textContent).toContain("Branch folder: src");
  expect(card.textContent).toContain("In scope 2 · modified 1 · accessing 1 now");
  expect(card.getAttribute("style")).toContain("var(--s5)");
  const meter = screen.getByRole("meter", { name: "GUIDO-1 context" });
  expect(meter.getAttribute("value")).toBe("12000");
  expect(meter.getAttribute("max")).toBe("64000");
});

it.each([
  [/Questions: 1 awaiting reply/, "Conversation lane", "Question 1 · #7 · awaiting reply"],
  [/1 refused in 10 min/, "Refused and failed calls", "Refused · Write"],
  [/Review round 1:/, "Review findings", "Fix: Return early for an empty list."],
  [/Local tests: 4 passed/, "Local tests", "Parsed Vitest summary"],
  [/CI @aaaaaaaa:/, "CI at head SHA", "Head SHA: aaaaaaaa"],
] as const)(
  "opens %s in the shared drawer, and restores focus on Escape",
  async (badge, title, detail) => {
    render(<CrewMapView snapshot={snapshot()} />);
    const button = screen.getByRole("button", { name: badge });
    expect(button.textContent).toContain("1m ago");
    fireEvent.click(button);
    const drawer = screen.getByRole("dialog", { name: title });
    expect(drawer.textContent).toContain(detail);
    expect(within(drawer).getByRole("heading", { name: title })).toBe(document.activeElement);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {});
    expect(document.activeElement).toBe(button);
  },
);

it("shows parked waiting data and marks the state in warn when the wait exceeds fifteen minutes", () => {
  const s = snapshot();
  s.seats[0].state = "parked";
  s.seats[0].since = 0;
  s.seats[0].calls = [];
  s.seats[0].badges.waiting = { kind: "parked", since: 65_000 - 900_001, reason: "Needs CAPCOM" };
  render(<CrewMapView snapshot={s} />);
  expect(screen.getByText(/Stuck ·/).className).toContain("stuck");
  fireEvent.click(within(screen.getByRole("article", { name: "GUIDO-1" })).getByRole("button"));
  fireEvent.click(screen.getByRole("button", { name: /Waiting: parked · Needs CAPCOM · 15m ago/ }));
  expect(screen.getByRole("dialog", { name: "Waiting" }).textContent).toContain("Needs CAPCOM");
});

it("filters pending questions by lane and ticket without inventing message bodies or answers", () => {
  const s = snapshot();
  s.seats[0].badges.questions.push(
    { id: 2, from: "GUIDO-1", to: "CAPCOM", ticket: 8, since: 2000 },
    { id: 3, from: "RETRO-1", to: "GUIDO-1", ticket: null, since: 2500 },
  );
  render(<CrewMapView snapshot={s} />);
  fireEvent.click(screen.getByRole("button", { name: /Questions: 3/ }));
  const drawer = screen.getByRole("dialog", { name: "Conversation lane" });
  expect(drawer.textContent).toContain("Question 1");
  expect(drawer.textContent).toContain("Question 2");
  expect(drawer.textContent).not.toContain("Question 3");
  fireEvent.change(screen.getByRole("combobox", { name: "Lane ticket" }), {
    target: { value: "8" },
  });
  expect(drawer.textContent).not.toContain("Question 1");
  expect(drawer.textContent).toContain("Question 2");
  fireEvent.change(screen.getByRole("combobox", { name: "Conversation lane" }), {
    target: { value: JSON.stringify(["GUIDO-1", "RETRO-1"]) },
  });
  expect(drawer.textContent).toContain("Question 3");
  expect(drawer.textContent).not.toContain("Question 2");
});

it("keeps only the latest ticket review and updates an open drawer from new snapshots", () => {
  const s = snapshot();
  s.findings.push({ ...s.findings[0], round: 0, summary: "Old review" });
  s.findings.push({ ...s.findings[0], ticket: 99, summary: "Other ticket" });
  const { rerender } = render(<CrewMapView snapshot={s} />);
  fireEvent.click(screen.getByRole("button", { name: /Review round 1:/ }));
  const drawer = screen.getByRole("dialog", { name: "Review findings" });
  expect(drawer.textContent).not.toContain("Old review");
  expect(drawer.textContent).not.toContain("Other ticket");
  const next = snapshot();
  next.seats[0].badges.review = {
    ticket: 7,
    round: 2,
    counts: { Critical: 0, Important: 0, Minor: 0 },
    at: 64_000,
  };
  next.findings = [];
  rerender(<CrewMapView snapshot={next} />);
  expect(drawer.textContent).toContain("Review round 2");
  expect(drawer.textContent).toContain("No findings.");
  expect(drawer.textContent).not.toContain("Empty input throws");
});

it("selects and dims cards without moving the camera; docked cards are one line until selected", () => {
  const s = snapshot();
  s.seats.push({
    ...structuredClone(s.seats[0]),
    seat: "RETRO-1",
    state: "idle",
    since: 0,
    calls: [],
  });
  render(<CrewMapView snapshot={s} />);
  const docked = screen.getByRole("article", { name: "RETRO-1" });
  expect(docked.textContent).toBe("RETRO-1idle 1m");
  const button = within(docked).getByRole("button");
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(docked.textContent).toContain("Handle empty input");
  expect(screen.getByRole("article", { name: "GUIDO-1" }).className).toContain("dim");
});

it("omits context with no reported window, and treats unparsed tests and empty CI as unknown", () => {
  const s = snapshot();
  s.seats[0].context = { total: 12000, window: null };
  s.seats[0].badges.tests = { runner: null, status: "unknown", at: 1000, editedSince: false };
  render(<CrewMapView snapshot={s} />);
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getByRole("button", { name: /Local tests: unknown/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /CI @aaaaaaaa: unknown/ }));
  expect(screen.getByRole("dialog").textContent).toContain("No checks reported at this head.");
});

it("renders untrusted reasons as inert text and replaces the badge drawer when a file is selected", () => {
  const s = snapshot();
  s.seats[0].badges.failures[0].why = '<img src=x onerror="alert(1)">';
  render(<CrewMapView snapshot={s} />);
  fireEvent.click(screen.getByRole("button", { name: /1 refused in 10 min/ }));
  const drawer = screen.getByRole("dialog");
  expect(drawer.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(drawer.querySelector("img")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "main" } });
  fireEvent.click(screen.getByRole("button", { name: "src/main.ts" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Selected file" }).textContent).toContain(
    "edit churn",
  );
});
