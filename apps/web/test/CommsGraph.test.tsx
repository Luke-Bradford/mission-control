import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CommsGraph, mapSelectionPath } from "../src/comms/CommsGraph.tsx";
import { hub } from "../src/data.ts";
import { type DomHarness, installMapDom } from "./crewMapDom.ts";
import { stubFetch } from "./fetchStub.ts";
import { seatRow } from "./fixtures.ts";

let dom: DomHarness;
beforeEach(() => {
  dom = installMapDom();
});
afterEach(() => {
  hub.clear();
  dom.restore();
});

const rows = [
  seatRow({ id: "flight-1", role: "FLIGHT", index: 0 }),
  seatRow({ id: "guido-1", index: 1 }),
];
const quiet = {
  "/api/comms/feed": { messages: [] },
  "/api/comms/open": { items: [] },
  "/api/comms/metrics": { from: 0, to: 1, p95BySeat: [] },
};
const seats = () => [...document.querySelectorAll<HTMLElement>(".cm-seat")];

it("puts the crew map in the Comms column, with the message lengths beneath it", async () => {
  stubFetch(quiet);
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(await screen.findByRole("heading", { name: "Crew map" })).toBeTruthy();
  await waitFor(() => expect(seats().map((s) => s.dataset.seat)).toContain("guido-1"));
  expect(document.querySelector(".comms-right .comms-map .cm")).toBeTruthy();
  expect(await screen.findByText("No messages in the last 24h.")).toBeTruthy();
});

it("opens the map full screen and closes it again", async () => {
  stubFetch(quiet);
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open the map full screen" }));
  await waitFor(() => expect(document.querySelector(".cm.cm-is-full")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Close full screen" }));
  await waitFor(() => expect(document.querySelector(".cm.cm-is-full")).toBeNull());
});

it("opens a seat's conversation when it is clicked", async () => {
  stubFetch(quiet);
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(seats().length).toBeGreaterThan(1));
  await act(async () => {
    seats()
      .find((s) => s.dataset.seat === "guido-1")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(window.location.pathname).toBe("/comms/agents/guido-1");
});

it("draws no seat before the hub has answered, and none the hub did not send", async () => {
  stubFetch({ ...quiet, "/api/comms/feed": () => new Promise(() => undefined) });
  render(<CommsGraph rows={[]} flightId={undefined} view={{ kind: "crew" }} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(seats()).toHaveLength(0);
});

it("with an empty crew draws only the operator, not a seeded crew", async () => {
  stubFetch(quiet);
  render(<CommsGraph rows={[]} flightId={undefined} view={{ kind: "crew" }} />);
  await waitFor(() => expect(seats()).toHaveLength(1));
  expect(seats()[0]?.dataset.seat).toBe("CAPCOM");
});

it("says the hub is not answering and keeps the last picture when the feed fails", async () => {
  stubFetch(quiet);
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(seats().length).toBeGreaterThan(1));
  stubFetch({ ...quiet, "/api/comms/feed": () => ({ status: 503, body: { error: "down" } }) });
  await act(async () => {
    hub.refetchTopic("agents");
    await new Promise((r) => setTimeout(r, 20));
  });
  await waitFor(() =>
    expect(document.querySelector(".cm-alert")?.textContent).toMatch(/not answering/i),
  );
  expect(seats().length).toBeGreaterThan(1);
});

it("treats seat and operator selections as the right conversations", () => {
  expect(mapSelectionPath({ type: "seat", id: "guido-1" }, "flight-1")).toBe(
    "/comms/agents/guido-1",
  );
  expect(mapSelectionPath({ type: "seat", id: "flight-1" }, "flight-1")).toBe("/comms");
  expect(mapSelectionPath({ type: "seat", id: "CAPCOM" }, "flight-1")).toBe("/comms");
  expect(mapSelectionPath({ type: "link", a: "guido-1", b: "guido-2" }, "flight-1")).toBe(
    "/comms/agents/guido-1/contacts/guido-2",
  );
  expect(mapSelectionPath({ type: "link", a: "flight-1", b: "guido-2" }, "flight-1")).toBe(
    "/comms/agents/guido-2",
  );
  expect(mapSelectionPath({ type: "link", a: "guido-2", b: "flight-1" }, "flight-1")).toBe(
    "/comms/agents/guido-2",
  );
  expect(mapSelectionPath({ type: "link", a: "flight-1", b: "CAPCOM" }, "flight-1")).toBe("/comms");
  expect(mapSelectionPath({ type: "link", a: "CAPCOM", b: "flight-1" }, "flight-1")).toBe("/comms");
});
