import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
import { waitingByPair } from "../src/comms/useChartData.ts";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { seatRow } from "./fixtures.ts";

afterEach(() => hub.clear());

it("shows FLIGHT at the centre and a live crew map", async () => {
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "guido-1", to: "flight-1", count: 1 },
        { from: "CAPCOM", to: "flight-1", count: 1 },
      ],
    },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
  });
  render(
    <CommsGraph
      flightId="flight-1"
      view={{ kind: "crew" }}
      rows={[seatRow({ id: "flight-1", role: "FLIGHT" }), seatRow({ id: "guido-1" })]}
    />,
  );
  expect(await screen.findByRole("heading", { name: "Crew map" })).toBeTruthy();
  expect(document.querySelector(".crew-map-seat.flight[aria-label*='Running']")).toBeTruthy();
  expect(document.querySelector(".crew-map-seat[aria-label^='CAPCOM']")).toBeTruthy();
  expect(document.querySelectorAll(".crew-map-link")).toHaveLength(2);
  expect(document.querySelector(".crew-map-side li button")?.textContent).toContain(
    "no tool running",
  );
  expect(screen.getByRole("button", { name: "Open the map full screen" })).toBeTruthy();
});

it("keeps new reply debt amber when the pair also has older asks", () => {
  const waiting = waitingByPair(
    [
      {
        id: "old",
        label: "question",
        from: "guido-1",
        to: "flight-1",
        ticket: null,
        waitedMs: 24 * 60 * 60_000,
      },
      {
        id: "young",
        label: "question",
        from: "guido-1",
        to: "flight-1",
        ticket: null,
        waitedMs: 60 * 60_000,
      },
    ],
    "flight-1",
    new Set(["guido-1", "flight-1"]),
  ).get("flight-1\0guido-1");
  expect(waiting).toMatchObject({ young: 1, old: 1, youngOwed: "flight-1" });
});

it("does not call an unavailable reply queue clear", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/open": () => ({ status: 503, body: { error: "down" } }),
    "/api/comms/feed": { messages: [] },
  });
  render(
    <CommsGraph
      flightId="flight-1"
      view={{ kind: "crew" }}
      rows={[seatRow({ id: "flight-1", role: "FLIGHT" })]}
    />,
  );
  expect(await screen.findByText("Couldn't read who is waiting. Retrying.")).toBeTruthy();
  expect(screen.queryByText("Nobody owes a reply.")).toBeNull();
});

it("keeps a warm lane and sends a coloured light when the live link changes", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "flight-1", count: 1 }] },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
  });
  render(
    <CommsGraph
      flightId="flight-1"
      view={{ kind: "crew" }}
      rows={[seatRow({ id: "flight-1", role: "FLIGHT" }), seatRow({ id: "guido-1" })]}
    />,
  );
  await screen.findByRole("heading", { name: "Crew map" });
  expect(document.querySelector(".crew-map-link.warm")).toBeTruthy();

  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "flight-1", count: 2 }] },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
  });
  hub.refetchTopic("agents");
  await waitFor(() => expect(document.querySelector(".crew-map-travel")).toBeTruthy());
  expect(
    document
      .querySelector<HTMLElement>(".crew-map-travel")
      ?.style.getPropertyValue("--travel-to-y"),
  ).toMatch(/%$/);
});

it("opens the full map and keeps held states distinct from stopped seats", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
  });
  render(
    <CommsGraph
      flightId="flight-1"
      view={{ kind: "crew" }}
      rows={[
        seatRow({ id: "flight-1", role: "FLIGHT" }),
        seatRow({ id: "guido-1", hudState: "stalled" }),
        seatRow({ id: "guido-2", hudState: "stopped" }),
      ]}
    />,
  );
  const stalled = document.querySelector<HTMLButtonElement>(
    ".crew-map-seat[aria-label^='GUIDO-1, Stalled']",
  );
  expect(stalled?.className).toContain("held");
  expect(
    document.querySelector<HTMLButtonElement>(".crew-map-seat[aria-label^='GUIDO-2, Stopped']")
      ?.className,
  ).toContain("stopped");
  fireEvent.click(screen.getByRole("button", { name: "Open the map full screen" }));
  expect(document.querySelector(".crew-map-full")).toBeTruthy();
});
