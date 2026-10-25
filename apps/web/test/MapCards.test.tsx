import { type CommsThreadMessage, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { MapScene } from "../src/map/MapScene.tsx";
import { stubFetch } from "./fetchStub.ts";

vi.mock("../src/map/MapScene.tsx", () => ({ MapScene: vi.fn(() => <div>3D scene</div>) }));
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(65_000);
  stubFetch({ "/api/comms/GUIDO-1": { messages: [] } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const snapshot = (): MapSnapshot => structuredClone(mapSnapshotFixture);
const message = (overrides: Partial<CommsThreadMessage>): CommsThreadMessage => ({
  id: "comms:1",
  at: 1000,
  from: "GUIDO-1",
  to: "CAPCOM",
  ticket: "sample#7", // the server's canonical form, as stored in comms
  text: "Question body",
  tagged: true,
  direct: true,
  seen: false,
  ...overrides,
});

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
  fireEvent.click(
    within(screen.getByRole("article", { name: "GUIDO-1" })).getByRole("button", {
      name: /Stuck/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Waiting: parked · Needs CAPCOM · 15m ago/ }));
  expect(screen.getByRole("dialog", { name: "Waiting" }).textContent).toContain("Needs CAPCOM");
});

it("filters pending-question headers by lane and ticket", () => {
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

it("loads read-only lane messages oldest first and filters string tickets alongside pending headers", async () => {
  const fetch = stubFetch({
    "/api/comms/GUIDO-1": {
      messages: [
        message({ id: "comms:2", at: 2000, from: "CAPCOM", to: "GUIDO-1", text: "Answer body" }),
        message({}),
        message({ id: "comms:3", ticket: "sample#8", text: "Other ticket body" }),
        message({ id: "comms:4", from: "RETRO-1", to: "GUIDO-1", ticket: null, text: "Peer body" }),
        message({ id: "comms:5", from: "CAPCOM", to: "RETRO-1", text: "Unrelated body" }),
        message({ id: "comms:6", ticket: null, text: "No ticket body" }),
      ],
    },
  });
  const s = snapshot();
  s.seats[0].badges.questions.push(
    { id: 2, from: "GUIDO-1", to: "CAPCOM", ticket: 8, since: 2000 },
    { id: 3, from: "RETRO-1", to: "GUIDO-1", ticket: null, since: 2500 },
  );
  const { rerender } = render(<CrewMapView snapshot={s} />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Questions: 3/ }));
  expect(screen.getByRole("status").textContent).toContain("Loading conversation");
  const list = await screen.findByRole("list", { name: "Lane messages" });
  const drawer = screen.getByRole("dialog");
  expect(drawer.textContent).toContain("Question 1 · #7 · awaiting reply");
  expect(list.textContent).toContain("Other ticket body");
  expect(list.textContent).not.toContain("Peer body");
  expect(list.textContent).not.toContain("Unrelated body");
  fireEvent.change(screen.getByRole("combobox", { name: "Lane ticket" }), {
    target: { value: "7" },
  });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual([expect.stringContaining("Question body"), expect.stringContaining("Answer body")]);
  expect(drawer.textContent).not.toContain("Question 2");
  const next = structuredClone(s);
  next.seats[0].badges.questions = [];
  rerender(<CrewMapView snapshot={next} />);
  expect(drawer.textContent).not.toContain("awaiting reply");
  expect(drawer.textContent).toContain("No pending questions.");
  expect(list.textContent).toContain("Question body");
  expect(list.textContent).toContain("Answer body");
  fireEvent.change(screen.getByRole("combobox", { name: "Lane ticket" }), {
    target: { value: "null" },
  });
  expect(list.textContent).toContain("No ticket body");
  expect(list.textContent).not.toContain("Question body");
  fireEvent.change(screen.getByRole("combobox", { name: "Conversation lane" }), {
    target: { value: JSON.stringify(["GUIDO-1", "RETRO-1"]) },
  });
  expect(list.textContent).toContain("Peer body");
  expect(list.textContent).not.toContain("Answer body");
  fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(fetch.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
    ["/api/comms/GUIDO-1", "GET"],
  ]);
});

it("shows a conversation load error while retaining the pending-question header", async () => {
  stubFetch({
    "/api/comms/GUIDO-1": () => ({ status: 503, body: { error: "Comms unavailable" } }),
  });
  render(<CrewMapView snapshot={snapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: /Questions: 1/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("Comms unavailable");
  expect(screen.getByRole("dialog").textContent).toContain("Question 1 · #7 · awaiting reply");
});

it("shows an empty conversation without fabricating bodies from pending-question metadata", async () => {
  render(<CrewMapView snapshot={snapshot()} />);
  fireEvent.click(screen.getByRole("button", { name: /Questions: 1/ }));
  expect(await screen.findByText("No messages in this lane.")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("Question 1 · #7 · awaiting reply");
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

it("updates duplicate-location findings independently without duplicate React keys", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const s = snapshot();
  s.findings = [
    { ...s.findings[0], scenario: "First scenario", fix: "First fix" },
    { ...s.findings[0], scenario: "Second scenario", fix: "Second fix" },
  ];
  const { rerender } = render(<CrewMapView snapshot={s} />);
  fireEvent.click(screen.getByRole("button", { name: /Review round 1:/ }));
  const drawer = screen.getByRole("dialog");
  expect(drawer.textContent).toContain("First scenario");
  expect(drawer.textContent).toContain("Second scenario");
  const next = structuredClone(s);
  next.findings = [{ ...s.findings[1], scenario: "Updated second scenario", fix: "Surviving fix" }];
  rerender(<CrewMapView snapshot={next} />);
  expect(drawer.textContent).not.toContain("First scenario");
  expect(drawer.textContent).not.toContain("First fix");
  expect(within(drawer).getAllByText("Updated second scenario")).toHaveLength(1);
  expect(within(drawer).getAllByText("Fix: Surviving fix")).toHaveLength(1);
  expect(
    error.mock.calls.filter((args) => args.some((arg) => String(arg).includes("same key"))),
  ).toEqual([]);
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
  expect(docked.textContent).toBe("RETRO-1idle 1m⌖");
  const button = within(docked).getByRole("button", { name: /idle/ });
  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(docked.textContent).toContain("Handle empty input");
  expect(screen.getByRole("article", { name: "GUIDO-1" }).className).toContain("dim");
});

it("focuses the agents heading on close when the badge opener disappears", async () => {
  const s = snapshot();
  const { rerender } = render(<CrewMapView snapshot={s} />);
  const opener = screen.getByRole("button", { name: /1 refused in 10 min/ });
  fireEvent.click(opener);
  const next = snapshot();
  next.seats[0].badges.failures = [];
  rerender(<CrewMapView snapshot={next} />);
  expect(opener.isConnected).toBe(false);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Agents · work in flight" }),
  );
});

it("closes the badge drawer and restores fallback focus when its seat leaves the snapshot", async () => {
  const s = snapshot();
  const { rerender } = render(<CrewMapView snapshot={s} />);
  const opener = screen.getByRole("button", { name: /1 refused in 10 min/ });
  fireEvent.click(opener);
  rerender(<CrewMapView snapshot={{ ...s, seats: [] }} />);
  await act(async () => {});
  expect(opener.isConnected).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Agent no longer on this repo.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Agents · work in flight" }),
  );
  rerender(<CrewMapView snapshot={s} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("clears a removed agent selection so remaining and returning cards are unselected", () => {
  const s = snapshot();
  s.seats.push({ ...structuredClone(s.seats[0]), seat: "RETRO-1" });
  const { rerender } = render(<CrewMapView snapshot={s} />);
  fireEvent.click(screen.getByRole("button", { name: /GUIDO-1#7/ }));
  expect(screen.getByRole("article", { name: "RETRO-1" }).className).toContain("dim");
  rerender(<CrewMapView snapshot={{ ...s, seats: [s.seats[1]] }} />);
  expect(screen.getByRole("article", { name: "RETRO-1" }).className).not.toContain("dim");
  rerender(<CrewMapView snapshot={s} />);
  expect(screen.getByRole("button", { name: /GUIDO-1#7/ }).getAttribute("aria-pressed")).toBe(
    "false",
  );
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

it("shares card and orb selection with the scene, and sends zoom only from the card control", async () => {
  render(<CrewMapView snapshot={snapshot()} />);
  await screen.findByText("3D scene");
  const scene = () => vi.mocked(MapScene).mock.lastCall?.[0];
  const card = screen.getByRole("article", { name: "GUIDO-1" });
  fireEvent.click(within(card).getByRole("button", { name: /GUIDO-1#7/ }));
  expect(scene()?.agent).toBe("GUIDO-1");
  expect(scene()?.agentFocus).toBeNull();
  act(() => scene()?.onAgentSelect?.(null));
  expect(
    within(card)
      .getByRole("button", { name: /GUIDO-1#7/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Zoom to GUIDO-1" }));
  expect(scene()?.agentFocus?.seat).toBe("GUIDO-1");
  fireEvent.click(screen.getByRole("button", { name: "Home view" }));
  expect(scene()?.agentFocus).toBeNull();
  expect(scene()?.home).toBe(1);
});

it("opens an arc's exact conversation pair and ticket even without a pending question", async () => {
  const s = snapshot();
  s.seats[0].badges.questions = [];
  stubFetch({
    "/api/comms/GUIDO-1": {
      messages: [
        message({ id: "a", to: "RETRO-1", text: "Review this", ticket: "7" }),
        message({ id: "b", to: "RETRO-1", text: "Other ticket", ticket: "8" }),
        message({ id: "c", to: "CAPCOM", text: "Other lane", ticket: "7" }),
      ],
    },
  });
  render(<CrewMapView snapshot={s} />);
  await screen.findByText("3D scene");
  const opener = screen.getByRole("button", { name: "Zoom to GUIDO-1" });
  act(() =>
    vi
      .mocked(MapScene)
      .mock.lastCall?.[0].onArc?.(
        { from: "GUIDO-1", to: "RETRO-1", ticket: 7, kind: "review", at: 65000, count: 1 },
        opener,
      ),
  );
  const drawer = screen.getByRole("dialog", { name: "Conversation lane" });
  await within(drawer).findByText("Review this");
  expect(within(drawer).queryByText("Other ticket")).toBeNull();
  expect(within(drawer).queryByText("Other lane")).toBeNull();
  expect((screen.getByRole("combobox", { name: "Lane ticket" }) as HTMLSelectElement).value).toBe(
    "7",
  );
});
