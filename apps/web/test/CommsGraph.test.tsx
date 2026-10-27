import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow, seatRow } from "./fixtures.ts";

const rows = [
  seatRow({ id: "flight-1", index: 0, role: "FLIGHT" }),
  seatRow({ id: "guido-1", index: 1 }),
  seatRow({ id: "retro-1", index: 2 }),
];

afterEach(() => hub.clear());

it.each([3, 6, 10])(
  "keeps FLIGHT centred and leaves observed loops off the crew ring for %i seats",
  async (seats) => {
    const live = Array.from({ length: seats }, (_, index) =>
      seatRow({
        id: index === 0 ? "flight-1" : `seat-${index}`,
        index,
        role: index === 0 ? "FLIGHT" : "GUIDO",
      }),
    );
    live.push(crewRow({ id: "ebull-ta" }));
    stubFetch({
      "/api/comms/links": { links: [] },
      "/api/comms/traffic": { hours: [] },
      "/api/comms/chatter": { pairs: [] },
    });
    render(<CommsGraph rows={live} flightId="flight-1" view={{ kind: "crew" }} />);
    const flight = await screen.findByRole("button", { name: /Open FLIGHT/ });
    expect(document.querySelectorAll(".comms-node")).toHaveLength(seats + 1);
    expect(flight.getAttribute("style")).toContain("left: 170px");
    expect(flight.getAttribute("style")).toContain("top: 160px");
    expect(screen.queryByRole("button", { name: /Open ebull-ta/ })).toBeNull();
  },
);

it("lays out every live seat, draws directional link totals, and changes scope with the page", async () => {
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "flight-1", to: "CAPCOM", count: 5 },
        { from: "guido-1", to: "retro-1", count: 3 },
        { from: "retro-1", to: "guido-1", count: 2 },
      ],
    },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /Open FLIGHT/ });
  expect(screen.getByRole("button", { name: /Open CAPCOM/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Open guido-1/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Open retro-1/ })).toBeTruthy();
  expect(document.querySelectorAll(".comms-edge-count")).toHaveLength(2);
  expect(screen.getByText("10")).toBeTruthy();

  graph.rerender(
    <CommsGraph
      rows={rows}
      flightId="flight-1"
      view={{ kind: "contact", agentId: "guido-1", contactId: "retro-1" }}
    />,
  );
  await waitFor(() => expect(screen.getByText("guido-1 ↔ retro-1")).toBeTruthy());
  expect(document.querySelectorAll(".comms-edge:not(.dim)")).toHaveLength(1);
  expect(document.querySelector(".comms-edge:not(.dim) .comms-edge-count")?.textContent).toBe("5");
});

it("has an explicit empty token and chatter state before token telemetry exists", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows.slice(0, 1)} flightId="flight-1" view={{ kind: "flight" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
  expect(screen.getByText("Token totals are not available yet.")).toBeTruthy();
  expect(screen.getByText("Nothing over 6 rounds in 24h.")).toBeTruthy();
});

it("resolves the configured FLIGHT seat and MC hub traffic in the open conversation", async () => {
  const hour = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / (60 * 60 * 1000)) * 60 * 60 * 1000;
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "flight-1", to: "CAPCOM", count: 1 },
        { from: "MC", to: "flight-1", count: 4 },
      ],
    },
    "/api/comms/traffic": {
      hours: [
        { hour, from: "flight-1", to: "CAPCOM", count: 1 },
        { hour, from: "MC", to: "flight-1", count: 4 },
      ],
    },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "flight" }} />);
  const traffic = await screen.findByLabelText("Comms activity");
  await waitFor(() =>
    expect(
      within(traffic).getByRole("img", { name: /5 messages in view \(FLIGHT ↔ CAPCOM\)/ }),
    ).toBeTruthy(),
  );
  const stats = traffic.querySelectorAll(".comms-traffic-stats strong");
  expect(stats[0]?.textContent).toBe("5");
  expect(stats[2]?.textContent).toBe("5");
  expect(traffic.querySelectorAll(".comms-bar i[style*='height: 56px']")).toHaveLength(1);
});
