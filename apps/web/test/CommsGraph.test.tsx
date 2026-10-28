import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  "keeps FLIGHT centred, racks quiet seats and leaves observed loops off the graph for %i seats",
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
    // CAPCOM, FLIGHT and #crew are hubs; every other live seat is a node.
    expect(document.querySelectorAll(".comms-node")).toHaveLength(seats + 2);
    expect(document.querySelectorAll(".comms-node.hub")).toHaveLength(3);
    expect(flight.getAttribute("style")).toContain("left: 50%");
    expect(flight.getAttribute("style")).toContain("top: 50%");
    // With no traffic in the window, every seat waits on the quiet rack, not on the graph.
    expect(document.querySelectorAll(".comms-standby .comms-node.idle")).toHaveLength(seats - 1);
    expect(screen.queryByRole("button", { name: /Open ebull-ta/ })).toBeNull();
  },
);

it("lays out every live seat, draws static link totals, and changes scope with the page", async () => {
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
  expect(document.querySelectorAll(".comms-edge-dot")).toHaveLength(0);
  expect(document.querySelector(".comms-traffic-stats strong")?.textContent).toBe("10");
  // Seats with traffic sit on the graph, sized by it; none waits on the quiet rack.
  expect(document.querySelector(".comms-standby")).toBeNull();

  graph.rerender(
    <CommsGraph
      rows={rows}
      flightId="flight-1"
      view={{ kind: "contact", agentId: "guido-1", contactId: "retro-1" }}
    />,
  );
  await waitFor(() => expect(screen.getByText("guido-1 ↔ retro-1 · 24h")).toBeTruthy());
  expect(document.querySelectorAll(".comms-edge:not(.dim)")).toHaveLength(1);
  expect(document.querySelector(".comms-edge:not(.dim) .comms-edge-count")?.textContent).toBe("5");
  expect(screen.getByRole("button", { name: /Open guido-1/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open retro-1/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).classList).not.toContain("selected");
  expect(screen.getByRole("button", { name: /Open CAPCOM/ }).classList).not.toContain("selected");
});

it("lights an edge only when its message count increases after the initial load", async () => {
  let count = 1;
  stubFetch({
    "/api/comms/links": () => ({
      status: 200,
      body: { links: [{ from: "guido-1", to: "retro-1", count }] },
    }),
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
  expect(document.querySelector(".comms-edge.live")).toBeNull();
  count = 2;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull());
});

it("keeps selected seats lit without traffic and dims crew-paused seats", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  const graph = render(
    <CommsGraph
      rows={[
        ...rows.slice(0, 2),
        seatRow({
          id: "retro-1",
          index: 2,
          crewPause: { seats: ["retro-1"], reason: "Save tokens", at: 1, by: "operator" },
        }),
      ]}
      flightId="flight-1"
      view={{ kind: "contact", agentId: "guido-1", contactId: "retro-1" }}
    />,
  );
  const guido = await screen.findByRole("button", { name: /Open guido-1/ });
  const retro = screen.getByRole("button", { name: /Open retro-1/ });
  expect(guido.classList).toContain("selected");
  expect(retro.classList).toContain("selected");
  expect(retro.classList).toContain("inactive");
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).classList).toContain("dim");
  expect(screen.getByRole("button", { name: /Open CAPCOM/ }).classList).toContain("dim");

  graph.rerender(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "flight" }} />);
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open CAPCOM/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open guido-1/ }).classList).not.toContain("selected");

  graph.rerender(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(document.querySelectorAll(".comms-node.selected")).toHaveLength(0);
});

it("includes the current hour and every qualifying chatter pair", async () => {
  const currentHour = Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000;
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "flight-1", to: "CAPCOM", count: 1 },
        { from: "guido-1", to: "retro-1", count: 4 },
      ],
    },
    "/api/comms/traffic": {
      hours: [{ hour: currentHour, from: "guido-1", to: "retro-1", count: 4 }],
    },
    "/api/comms/chatter": {
      pairs: [
        { from: "flight-1", to: "CAPCOM", ticket: "mc#flight", rounds: 8 },
        { from: "guido-1", to: "retro-1", ticket: "mc#agents", rounds: 7 },
      ],
    },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByText(/mc#agents/);
  expect(screen.getByText(/mc#flight/)).toBeTruthy();
  expect(document.querySelectorAll(".comms-edge.watching")).toHaveLength(2);
  const hours = [...document.querySelectorAll(".comms-hour")];
  expect(hours).toHaveLength(24);
  // The newest hour is the last band, and the scale tops out at the peak.
  expect(hours.at(-1)?.textContent).toMatch(/· 4 messages · 0 with capcom$/);
  expect(hours.slice(0, -1).every((hour) => hour.textContent?.includes("· 0 messages"))).toBe(true);
  expect(
    [...document.querySelectorAll(".comms-chart-grid text")].map((tick) => tick.textContent),
  ).toEqual(["4", "2", "0"]);
  expect(document.querySelector(".comms-chart-trace")).not.toBeNull();
});

it("says so when a scope has no traffic, rather than drawing an empty trace", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 2 }] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "flight" }} />);
  expect(await screen.findByText("No messages in FLIGHT ↔ CAPCOM in the last 24h.")).toBeTruthy();
  expect(document.querySelector(".comms-chart-trace")).toBeNull();
  expect(document.querySelector(".comms-traffic-stats strong")?.textContent).toBe("0");
});

it("draws the #crew channel as a hub with its traffic", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "crew", count: 3 }] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const crew = await screen.findByRole("button", { name: "Open #crew, 3 messages in 24h" });
  expect(crew.classList).toContain("hub");
  expect(document.querySelector(".comms-edge-count")?.textContent).toBe("3");
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
  const hour = Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000;
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
  // MC's reports count as CAPCOM's, so all five land in the current hour, all with CAPCOM.
  expect(traffic.querySelector(".comms-hour:last-of-type title")?.textContent).toMatch(
    /· 5 messages · 5 with capcom$/,
  );
});
