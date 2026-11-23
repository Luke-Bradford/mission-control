import { render, screen } from "@testing-library/react";
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
  expect(screen.getByRole("button", { name: /FLIGHT.*running/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open the map full screen" })).toBeTruthy();
});
