import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
import { DEFAULT_SIZE, frameFor } from "../src/comms/spider.ts";
import { TrafficChart } from "../src/comms/TrafficChart.tsx";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow, seatRow } from "./fixtures.ts";

const rows = [
  seatRow({ id: "flight-1", index: 0, role: "FLIGHT" }),
  seatRow({ id: "guido-1", index: 1 }),
  seatRow({ id: "retro-1", index: 2 }),
];

afterEach(() => {
  vi.useRealTimers();
  hub.clear();
});

it.each([3, 6, 10])(
  "keeps FLIGHT centred and puts every seat and observed loop on its role's spoke for %i seats",
  async (seats) => {
    const live = Array.from({ length: seats }, (_, index) =>
      seatRow({
        id: index === 0 ? "flight-1" : `seat-${index}`,
        index,
        role: index === 0 ? "FLIGHT" : index % 2 ? "GUIDO" : "RETRO",
      }),
    );
    live.push(crewRow({ id: "ebull-ta", index: seats }));
    stubFetch({
      "/api/comms/links": { links: [] },
      "/api/comms/traffic": { hours: [] },
      "/api/comms/chatter": { pairs: [] },
    });
    render(<CommsGraph rows={live} flightId="flight-1" view={{ kind: "crew" }} />);
    const flight = await screen.findByRole("button", { name: /Open FLIGHT/ });
    // CAPCOM, FLIGHT and #crew are hubs; every other seat and the loop is a node, quiet or not.
    expect(document.querySelectorAll(".comms-node")).toHaveLength(seats + 3);
    expect(document.querySelectorAll(".comms-node.hub")).toHaveLength(3);
    const f = frameFor(DEFAULT_SIZE);
    expect(flight.getAttribute("transform")).toBe(
      `translate(${f.cx.toFixed(2)} ${f.cy.toFixed(2)})`,
    );
    expect(screen.getByRole("button", { name: /Open ebull-ta/i })).toBeTruthy();
    const spokes = [...document.querySelectorAll(".comms-spoke-name")].map((t) => t.textContent);
    expect(spokes).toEqual(["GUIDO", "RETRO", "LOOPS"]);
    // Names are full call signs, never a role-stripped suffix.
    expect([...document.querySelectorAll(".comms-node-name")].map((t) => t.textContent)).toContain(
      "SEAT-1",
    );
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
  expect(screen.getByRole("button", { name: /Open guido-1/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Open retro-1/i })).toBeTruthy();
  expect(document.querySelectorAll(".comms-edge-count")).toHaveLength(2);
  expect(document.querySelectorAll(".comms-edge-dot")).toHaveLength(0);
  expect(document.querySelector(".comms-traffic-stats strong")?.textContent).toBe("10");
  // Every seat sits on its spoke; there is no quiet rack.
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
  expect(screen.getByRole("button", { name: /Open guido-1/i }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open retro-1/i }).classList).toContain("selected");
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

/** Links whose guido-1 → retro-1 count is read from `count()` on every fetch. */
function stubRisingLinks(count: () => number) {
  return stubFetch({
    "/api/comms/links": () => ({
      status: 200,
      body: { links: [{ from: "guido-1", to: "retro-1", count: count() }] },
    }),
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
}

it("clears a lit edge after 1.8s even when the crew rows change identity meanwhile", async () => {
  let count = 1;
  stubRisingLinks(() => count);
  const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  count = 2;
  act(() => hub.refetchTopic("agents"));
  await vi.waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull(), {
    interval: 1,
  });
  await act(async () => {}); // run the effects that start the light's timer
  // A crew refetch hands over a new rows array (same seats) before the light times out.
  act(() => vi.advanceTimersByTime(1_000));
  graph.rerender(
    <CommsGraph
      rows={rows.map((row) => ({ ...row }))}
      flightId="flight-1"
      view={{ kind: "crew" }}
    />,
  );
  expect(document.querySelector(".comms-edge.live")).not.toBeNull();
  act(() => vi.advanceTimersByTime(800));
  expect(document.querySelector(".comms-edge.live")).toBeNull();
  expect(document.querySelector(".comms-edge-pulse")).toBeNull();
});

it("sends a particle per new message along its link, and again when the link rises again", async () => {
  // Particles skip a hidden tab; pin a visible one.
  const visible = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  onTestFinished(() => visible.mockRestore());
  let count = 1;
  stubRisingLinks(() => count);
  const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
  // The first read draws the totals; nothing travels for messages that were already there.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(document.querySelector(".comms-particle")).toBeNull();
  count = 3;
  // Count particles as they are created: on a slow runner the first can land before the second
  // (which starts a beat later) appears, so never both on screen at once.
  const created = new Set<Element>();
  const seen = new MutationObserver(() => {
    for (const el of document.querySelectorAll(".comms-particle")) created.add(el);
  });
  seen.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => seen.disconnect());
  act(() => hub.refetchTopic("agents"));
  // Two new messages: two particles, the second a beat behind the first.
  await waitFor(() => expect(created.size).toBe(2), { timeout: 3_000 });
  expect(document.querySelector(".comms-edge.live")).not.toBeNull();
  await waitFor(() => expect(document.querySelector(".comms-particle")).toBeNull(), {
    timeout: 3_000,
  });
  count = 4;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelectorAll(".comms-particle")).toHaveLength(1));
  // A crew refetch while it flies hands over the same read: no second particle.
  graph.rerender(
    <CommsGraph
      rows={rows.map((row) => ({ ...row }))}
      flightId="flight-1"
      view={{ kind: "crew" }}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(document.querySelectorAll(".comms-particle")).toHaveLength(1);
});

it("sends a particle when a link's newest message changes though its 24h count holds", async () => {
  // Particles skip a hidden tab; pin a visible one.
  const visible = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  onTestFinished(() => visible.mockRestore());
  let lastId = "comms:1";
  stubFetch({
    "/api/comms/links": () => ({
      status: 200,
      body: {
        links: [
          { from: "guido-1", to: "retro-1", count: 2, lastId, lastAt: 1, lastText: "Review it" },
        ],
      },
    }),
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("2"));
  lastId = "comms:9";
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelectorAll(".comms-particle")).toHaveLength(1));
});

it("claims LIVE only while the links are loaded and their last read succeeded", async () => {
  let ok = true;
  stubFetch({
    "/api/comms/links": () =>
      ok ? { status: 200, body: { links: [] } } : { status: 503, body: { error: "down" } },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(document.querySelector(".comms-graph-readout .live")).toBeNull();
  await waitFor(() => expect(document.querySelector(".comms-graph-readout .live")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".comms-chart-now.live")).not.toBeNull());
  ok = false;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelector(".comms-graph-readout .live")).toBeNull());
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
  const guido = await screen.findByRole("button", { name: /Open guido-1/i });
  const retro = screen.getByRole("button", { name: /Open retro-1/i });
  expect(guido.classList).toContain("selected");
  expect(retro.classList).toContain("selected");
  expect(retro.classList).toContain("inactive");
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).classList).toContain("dim");
  expect(screen.getByRole("button", { name: /Open CAPCOM/ }).classList).toContain("dim");

  graph.rerender(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "flight" }} />);
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open CAPCOM/ }).classList).toContain("selected");
  expect(screen.getByRole("button", { name: /Open guido-1/i }).classList).not.toContain("selected");

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
      within(traffic).getByRole("figure", { name: /5 messages in view \(FLIGHT ↔ CAPCOM\)/ }),
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

it("labels traffic buckets by their start in the operator's timezone", async () => {
  stubFetch({ "/api/config": { operator: { timezone: "Asia/Kolkata" } } });
  // UTC-hour buckets start at :30 in a half-hour zone.
  const start = Date.UTC(2026, 9, 28, 0);
  const hours = Array.from({ length: 24 }, (_, index) => ({
    hour: start + index * 60 * 60 * 1000,
    total: index === 3 ? 4 : 0,
    part: 0,
  }));
  render(
    <TrafficChart
      hours={hours}
      label="Traffic"
      totalLabel="All messages"
      partLabel="With CAPCOM"
      emptyText="None"
      live
    />,
  );
  await waitFor(() =>
    expect([...document.querySelectorAll(".comms-chart-tick")].map((el) => el.textContent)).toEqual(
      ["05:30", "17:30", "now"],
    ),
  );
  expect(document.querySelectorAll(".comms-hour title")[3]?.textContent).toBe(
    "08:30 · 4 messages · 0 with capcom",
  );
  expect(document.querySelector(".comms-chart-now.live")).not.toBeNull();
});

/** Answers `prefers-reduced-motion: reduce` with `reduce`; restores matchMedia afterwards. */
function preferMotion(reduce: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

const transforms = () =>
  Object.fromEntries(
    [...document.querySelectorAll(".comms-spider-nodes > .comms-node:not(.leaving)")].map((g) => [
      g.getAttribute("aria-label")?.split(",")[0],
      g.getAttribute("transform"),
    ]),
  );

it("keeps every node where it is when a refetch brings the same crew and links", async () => {
  const restore = preferMotion(true);
  try {
    stubRisingLinks(() => 2);
    const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("2"));
    const before = transforms();
    expect(Object.keys(before)).toHaveLength(5);
    act(() => hub.refetchTopic("agents"));
    graph.rerender(
      <CommsGraph
        rows={rows.map((row) => ({ ...row }))}
        flightId="flight-1"
        view={{ kind: "crew" }}
      />,
    );
    await act(async () => {});
    expect(transforms()).toEqual(before);
  } finally {
    restore();
  }
});

it("shows presence by state and fades a seat out when it leaves, back in when it returns", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  const crew = (retro: Partial<(typeof rows)[number]> | null) => [
    ...rows.slice(0, 2),
    ...(retro === null ? [] : [seatRow({ id: "retro-1", index: 2, role: "RETRO", ...retro })]),
  ];
  const graph = render(
    <CommsGraph rows={crew({ hudState: "running" })} flightId="flight-1" view={{ kind: "crew" }} />,
  );
  const node = () => screen.queryByRole("button", { name: /Open retro-1/i });
  await waitFor(() => expect(node()?.classList).toContain("presence-running"));
  graph.rerender(
    <CommsGraph rows={crew({ hudState: "idle" })} flightId="flight-1" view={{ kind: "crew" }} />,
  );
  expect(node()?.classList).toContain("presence-idle");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Stopped and quiet all window: away. It fades out where it stood and the legend counts it.
  graph.rerender(
    <CommsGraph rows={crew({ hudState: "stopped" })} flightId="flight-1" view={{ kind: "crew" }} />,
  );
  expect(node()).toBeNull();
  expect(document.querySelectorAll(".comms-node.leaving")).toHaveLength(1);
  // "1 away" is a disclosure: closed, then open on click, listing the seat and its state.
  const away = screen.getByRole("button", { name: "1 away" });
  expect(away.getAttribute("aria-expanded")).toBe("false");
  const list = document.getElementById(away.getAttribute("aria-controls") ?? "") as HTMLElement;
  expect(list.hidden).toBe(true);
  fireEvent.click(away);
  expect(away.getAttribute("aria-expanded")).toBe("true");
  expect(list.hidden).toBe(false);
  expect(list.textContent).toMatch(/RETRO-1\s*Stopped/);
  act(() => vi.advanceTimersByTime(700));
  expect(document.querySelectorAll(".comms-node.leaving")).toHaveLength(0);

  // Gone from the crew altogether: the same fade, and nothing left to count.
  graph.rerender(<CommsGraph rows={crew(null)} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(node()).toBeNull();
  expect(screen.queryByRole("button", { name: /away/ })).toBeNull();

  graph.rerender(
    <CommsGraph rows={crew({ hudState: "running" })} flightId="flight-1" view={{ kind: "crew" }} />,
  );
  expect(node()?.classList).toContain("presence-running");
  expect(document.querySelectorAll(".comms-node.leaving")).toHaveLength(0);
});

it("under reduced motion: no drift loop, no particles, no fade; the new link still lights", async () => {
  const restore = preferMotion(true);
  const frames = vi.spyOn(window, "requestAnimationFrame");
  try {
    let count = 1;
    stubRisingLinks(() => count);
    const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
    count = 2;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.querySelector(".comms-particle")).toBeNull();
    expect(frames).not.toHaveBeenCalled();
    expect(document.querySelector(".comms-spider-legend .particle")).toBeNull();
    graph.rerender(
      <CommsGraph rows={rows.slice(0, 2)} flightId="flight-1" view={{ kind: "crew" }} />,
    );
    expect(document.querySelector(".comms-node.leaving")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open retro-1/i })).toBeNull();
  } finally {
    frames.mockRestore();
    restore();
  }
});

it("hovers a node or link for its counts and newest message; clicks and keys open the conversation", async () => {
  stubFetch({
    "/api/comms/links": {
      links: [
        {
          from: "guido-1",
          to: "retro-1",
          count: 3,
          lastId: "comms:4",
          lastAt: 1,
          lastText: "Fixed",
        },
        {
          from: "retro-1",
          to: "guido-1",
          count: 2,
          lastId: "comms:7",
          lastAt: 2,
          lastText: "One blocking finding left",
        },
      ],
    },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const guido = await screen.findByRole("button", { name: /Open guido-1, 5 messages/i });
  // One tab stop for the whole graph: FLIGHT, at the centre.
  expect(guido.getAttribute("tabindex")).toBe("-1");
  expect(screen.getByRole("button", { name: /Open FLIGHT/ }).getAttribute("tabindex")).toBe("0");
  fireEvent.mouseEnter(guido);
  expect(guido.getAttribute("aria-describedby")).toContain(
    screen.getByRole("tooltip").getAttribute("id"),
  );
  const tip = await screen.findByRole("tooltip");
  expect(within(tip).getByText("Sent").nextElementSibling?.textContent).toBe("3");
  expect(within(tip).getByText("Received").nextElementSibling?.textContent).toBe("2");
  expect(within(tip).getByText("One blocking finding left")).toBeTruthy();
  fireEvent.mouseLeave(guido);
  expect(screen.queryByRole("tooltip")).toBeNull();

  const edge = document.querySelector(".comms-edge") as Element;
  fireEvent.mouseEnter(edge);
  expect(within(screen.getByRole("tooltip")).getByText("GUIDO-1 ↔ RETRO-1")).toBeTruthy();
  fireEvent.click(edge);
  expect(window.location.pathname).toBe("/comms/agents/guido-1/contacts/retro-1");

  fireEvent.keyDown(screen.getByRole("button", { name: /Open retro-1/i }), { key: "Enter" });
  expect(window.location.pathname).toBe("/comms/agents/retro-1");
  fireEvent.focus(screen.getByRole("button", { name: /Open CAPCOM/ }));
  expect(within(screen.getByRole("tooltip")).getByText("No messages in 24h")).toBeTruthy();
});

it("walks the graph by keyboard: arrows between nodes, down into a node's links, up back out", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 3 }] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const flight = await screen.findByRole("button", { name: /Open FLIGHT/ });
  act(() => flight.focus());
  // Clockwise from the top: CAPCOM is next after the centre.
  fireEvent.keyDown(flight, { key: "ArrowRight" });
  const capcom = screen.getByRole("button", { name: /Open CAPCOM/ });
  expect(document.activeElement).toBe(capcom);
  expect(capcom.getAttribute("tabindex")).toBe("0");
  expect(flight.getAttribute("tabindex")).toBe("-1");
  fireEvent.keyDown(capcom, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(flight);
  const guido = screen.getByRole("button", { name: /Open guido-1/i });
  act(() => guido.focus());
  fireEvent.keyDown(guido, { key: "ArrowDown" });
  const link = screen.getByRole("button", { name: /Conversation GUIDO-1 ↔ RETRO-1, 3 messages/ });
  expect(document.activeElement).toBe(link);
  fireEvent.keyDown(link, { key: "ArrowUp" });
  expect(document.activeElement).toBe(guido);
});

it("keeps a stopped seat that talked in the window, set back; shows link counts only on focus", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 2 }] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
  });
  render(
    <CommsGraph
      rows={[rows[0], rows[1], seatRow({ id: "retro-1", index: 2, role: "RETRO", paused: true })]}
      flightId="flight-1"
      view={{ kind: "crew" }}
    />,
  );
  const retro = await screen.findByRole("button", {
    name: /Open retro-1, 2 messages in 24h, Paused/i,
  });
  expect(retro.classList).toContain("presence-stopped");
  expect(screen.queryByRole("button", { name: /away/ })).toBeNull();
  // At rest the chip is not lit; hovering an end lights its links' counts.
  const edge = document.querySelector(".comms-edge") as Element;
  expect(edge.classList).not.toContain("near");
  fireEvent.mouseEnter(retro);
  expect(edge.classList).toContain("near");
});

/**
 * Takes over requestAnimationFrame so a test can run frames by hand. `origin` sets the frame
 * clock's start, which a browser needn't share with performance.now().
 */
function manualFrames(origin = performance.now()) {
  let clock = origin;
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    queue.set(next, cb);
    return next++;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    queue.delete(id);
  });
  return {
    pending: () => queue.size,
    /** Runs up to `n` frames 33ms apart; stops early once nothing asks for another. */
    run(n: number) {
      for (let i = 0; i < n && queue.size > 0; i++) {
        clock += 33;
        const due = [...queue.values()];
        queue.clear();
        act(() => {
          for (const cb of due) cb(clock);
        });
      }
    },
    cancel,
    restore() {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

it("with motion on, settles, stops asking for frames, and a same-data refetch moves nothing", async () => {
  const frames = manualFrames();
  try {
    stubRisingLinks(() => 2);
    const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("2"));
    frames.run(400);
    // At rest the loop asks for no frames at all; the drift is CSS.
    expect(frames.pending()).toBe(0);
    const before = transforms();
    act(() => hub.refetchTopic("agents"));
    graph.rerender(
      <CommsGraph
        rows={rows.map((row) => ({ ...row }))}
        flightId="flight-1"
        view={{ kind: "crew" }}
      />,
    );
    await act(async () => {});
    frames.run(400);
    expect(transforms()).toEqual(before);
    expect(frames.pending()).toBe(0);
  } finally {
    frames.restore();
  }
});

it.each([
  ["behind", -1e9],
  ["ahead", 1e9],
])("flies a particle on the frame clock when it runs %s performance.now()", async (_, origin) => {
  const frames = manualFrames(origin);
  try {
    let count = 1;
    stubRisingLinks(() => count);
    render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
    frames.run(400);
    count = 2;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(frames.pending()).toBe(1));
    // It draws within a frame or two and is still flying a third of the way through its flight.
    frames.run(2);
    expect(document.querySelectorAll(".comms-particle")).toHaveLength(1);
    frames.run(10);
    expect(document.querySelectorAll(".comms-particle")).toHaveLength(1);
    // A 1.15s flight is done well within 60 frames of 33ms, and the loop then stops.
    frames.run(60);
    expect(document.querySelector(".comms-particle")).toBeNull();
    frames.run(400);
    expect(frames.pending()).toBe(0);
  } finally {
    frames.restore();
  }
});

it("cancels its frame and drops particles in flight when it unmounts", async () => {
  const frames = manualFrames();
  try {
    let count = 1;
    stubRisingLinks(() => count);
    const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await waitFor(() => expect(document.querySelector(".comms-edge-count")?.textContent).toBe("1"));
    frames.run(400);
    count = 2;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(frames.pending()).toBe(1));
    frames.run(3);
    expect(document.querySelectorAll(".comms-particle")).toHaveLength(1);
    graph.unmount();
    expect(frames.cancel).toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
    expect(document.querySelector(".comms-particle")).toBeNull();
  } finally {
    frames.restore();
  }
});
