import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { seatRow } from "./fixtures.ts";

afterEach(() => hub.clear());

it("shows FLIGHT at the centre and a live crew map", async () => {
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
  expect(await screen.findByRole("heading", { name: "Crew map" })).toBeTruthy();
  expect(document.querySelector(".crew-map-seat.flight[aria-label*='Running']")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open the map full screen" })).toBeTruthy();
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
  const stalled = await screen.findByRole("button", { name: /guido-1, stalled/i });
  expect(stalled.className).toContain("held");
  expect(screen.getByRole("button", { name: /guido-2, stopped/i }).className).toContain("stopped");
  fireEvent.click(screen.getByRole("button", { name: "Open the map full screen" }));
  expect(document.querySelector(".crew-map-full")).toBeTruthy();
});
