import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommsGraph } from "../src/comms/CommsGraph.tsx";
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
  window.history.replaceState(null, "", "/");
});

const quiet = {
  "/api/comms/traffic": { hours: [] },
  "/api/comms/chatter": { pairs: [] },
  "/api/comms/open": { items: [] },
};

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

/** Links whose guido-1 → retro-1 count is read from `count()` on every fetch. */
function stubRisingLinks(count: () => number) {
  return stubFetch({
    "/api/comms/links": () => ({
      status: 200,
      body: { links: [{ from: "guido-1", to: "retro-1", count: count() }] },
    }),
    ...quiet,
  });
}

const seat = (name: RegExp) => screen.getByRole("button", { name });

it.each([3, 6, 10])(
  "puts FLIGHT, CAPCOM and #crew on the centre line and every seat on a rail for %i seats",
  async (seats) => {
    const live = Array.from({ length: seats }, (_, index) =>
      seatRow({
        id: index === 0 ? "flight-1" : `seat-${index}`,
        index,
        role: index === 0 ? "FLIGHT" : index % 2 ? "GUIDO" : "RETRO",
      }),
    );
    live.push(crewRow({ id: "ebull-ta", index: seats }));
    stubFetch({ "/api/comms/links": { links: [] }, ...quiet });
    render(<CommsGraph rows={live} flightId="flight-1" view={{ kind: "crew" }} />);
    await screen.findByRole("button", { name: /^FLIGHT,/i });
    expect(document.querySelectorAll(".comms-node")).toHaveLength(seats + 3);
    expect(document.querySelectorAll(".comms-node.hub")).toHaveLength(3);
    const x = (id: string) =>
      Number(
        /translate\(([\d.]+)/.exec(
          document.querySelector(`.comms-node[data-id="${id}"]`)?.getAttribute("transform") ?? "",
        )?.[1],
      );
    expect(x("flight-1")).toBe(x("CAPCOM"));
    expect(x("flight-1")).toBe(x("crew"));
    expect(x("seat-1")).not.toBe(x("flight-1"));
    expect(screen.getByRole("button", { name: /^ebull-ta,/i })).toBeTruthy();
    expect([...document.querySelectorAll(".comms-node-name")].map((t) => t.textContent)).toContain(
      "SEAT-1",
    );
  },
);

it("draws a link per pair with both directions together, and its title row has All, Open and Full screen", async () => {
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "flight-1", to: "CAPCOM", count: 5 },
        { from: "guido-1", to: "retro-1", count: 3 },
        { from: "retro-1", to: "guido-1", count: 2 },
      ],
    },
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 5 messages/i });
  expect(document.querySelectorAll(".comms-edge")).toHaveLength(2);
  expect(document.querySelector(".comms-traffic-stats strong")?.textContent).toBe("10");
  expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /^Open/i })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Tokens" })).toBeNull();
  expect(screen.getByRole("link", { name: /full screen/i }).getAttribute("href")).toBe(
    "/comms/chart",
  );
});

it("opens the chart on its own address, keeping the filter", async () => {
  window.history.replaceState(null, "", "/comms/crew?focus=seat:guido-1");
  stubFetch({ "/api/comms/links": { links: [] }, ...quiet });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const full = await screen.findByRole("link", { name: /full screen/i });
  expect(full.getAttribute("href")).toBe("/comms/chart?focus=seat%3Aguido-1");
});

it("narrows to the seat from the URL, with a chip and a Clear that drops it", async () => {
  window.history.replaceState(null, "", "/comms/crew?focus=seat:guido-1");
  stubFetch({
    "/api/comms/links": {
      links: [
        { from: "guido-1", to: "retro-1", count: 3 },
        { from: "flight-1", to: "CAPCOM", count: 2 },
      ],
    },
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const chip = await screen.findByRole("status");
  expect(chip.textContent?.toLowerCase()).toContain("guido-1");
  expect(seat(/^FLIGHT,/i).classList).toContain("dim");
  expect(seat(/^retro-1,/i).classList).not.toContain("dim");
  fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));
  await waitFor(() => expect(window.location.search).toBe(""));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(seat(/^FLIGHT,/i).classList).not.toContain("dim");
});

it("a click on a seat opens its conversation and leaves the chart narrowed to it", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 3 }] },
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  fireEvent.click(await screen.findByRole("button", { name: /^guido-1,/i }));
  expect(window.location.pathname).toBe("/comms/agents/guido-1");
  expect(window.location.search).toBe("?focus=seat%3Aguido-1");
  fireEvent.click(screen.getByRole("button", { name: /^guido-1 ↔ retro-1,/i }));
  expect(window.location.pathname).toBe("/comms/agents/guido-1/contacts/retro-1");
  expect(window.location.search).toBe("?focus=pair%3Aguido-1%2Cretro-1");
  fireEvent.click(screen.getByRole("button", { name: /^FLIGHT,/i }));
  expect(window.location.pathname).toBe("/comms");
});

it("shows who is waiting by a dashed link and the wait in words, from the open items", async () => {
  stubFetch({
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 3 }] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/open": {
      items: [
        {
          id: "a",
          label: "question",
          from: "guido-1",
          to: "retro-1",
          ticket: "#9",
          waitedMs: 12 * 60_000,
          question: "Which branch?",
        },
        {
          id: "b",
          label: "blocker",
          from: "retro-1",
          to: "flight-1",
          ticket: null,
          waitedMs: 90_000,
        },
      ],
    },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() => expect(document.querySelectorAll(".comms-edge.waiting")).toHaveLength(2));
  expect(document.querySelector(".comms-wait-mark")?.textContent).toContain("12m");
  expect(seat(/^guido-1,/i).classList).toContain("waiting");
  expect(seat(/^guido-1,/i).getAttribute("aria-label")).toMatch(/waiting on an answer/);
  fireEvent.click(screen.getByRole("button", { name: /^Open/i }));
  expect(document.querySelectorAll(".comms-edge")).toHaveLength(2);
});

it("reads an older hub's open items, which carry no text, without failing", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/open": {
      items: [
        { id: "a", label: "question", from: "guido-1", to: "retro-1", ticket: null, waitedMs: 0 },
      ],
    },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await waitFor(() =>
    expect(document.querySelector(".comms-wait-mark")?.textContent).toContain("<1m"),
  );
});

it("lights a link only when its message count increases after the initial load", async () => {
  let count = 1;
  stubRisingLinks(() => count);
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 1 message/i });
  expect(document.querySelector(".comms-edge.live")).toBeNull();
  count = 2;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull());
});

it("clears a lit link after 1.8s even when the crew rows change identity meanwhile", async () => {
  let count = 1;
  stubRisingLinks(() => count);
  const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 1 message/i });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  count = 2;
  act(() => hub.refetchTopic("agents"));
  await vi.waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull(), {
    interval: 1,
  });
  await act(async () => {});
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
});

it("sends a dot per new message along its link, and again when the link rises again", async () => {
  let count = 1;
  stubRisingLinks(() => count);
  const graph = render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 1 message/i });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(document.querySelector(".comms-particle")).toBeNull();
  count = 3;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelectorAll(".comms-particle")).toHaveLength(2));
  expect(document.querySelector(".comms-edge.live")).not.toBeNull();
  await waitFor(() => expect(document.querySelector(".comms-particle")).toBeNull(), {
    timeout: 4_000,
  });
  count = 4;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelectorAll(".comms-particle")).toHaveLength(1));
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

it("sends a dot when a link's newest message changes though its 24h count holds", async () => {
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
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 2 messages/i });
  lastId = "comms:9";
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelectorAll(".comms-particle")).toHaveLength(1));
});

it("under reduced motion: no travelling dots; the new link still lights", async () => {
  const restore = preferMotion(true);
  try {
    let count = 1;
    stubRisingLinks(() => count);
    render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
    await screen.findByRole("button", { name: /^guido-1 ↔ retro-1, 1 message/i });
    count = 2;
    act(() => hub.refetchTopic("agents"));
    await waitFor(() => expect(document.querySelector(".comms-edge.live")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.querySelector(".comms-particle")).toBeNull();
  } finally {
    restore();
  }
});

it("claims LIVE only while the links are loaded and their last read succeeded", async () => {
  let ok = true;
  stubFetch({
    "/api/comms/links": () =>
      ok ? { status: 200, body: { links: [] } } : { status: 503, body: { error: "down" } },
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(document.querySelector(".comms-graph-readout .live")).toBeNull();
  await waitFor(() => expect(document.querySelector(".comms-graph-readout .live")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".comms-chart-now.live")).not.toBeNull());
  ok = false;
  act(() => hub.refetchTopic("agents"));
  await waitFor(() => expect(document.querySelector(".comms-graph-readout .live")).toBeNull());
});

it("shows stopped and crew-paused seats set back, not hidden", async () => {
  stubFetch({ "/api/comms/links": { links: [] }, ...quiet });
  render(
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
      view={{ kind: "crew" }}
    />,
  );
  const retro = await screen.findByRole("button", { name: /^retro-1,/i });
  expect(retro.classList).toContain("presence-stopped");
  expect(retro.getAttribute("aria-label")).toContain("Crew paused");
});

it("hovers a seat or a link for its counts and newest message", async () => {
  stubFetch({
    "/api/comms/links": {
      links: [
        {
          from: "guido-1",
          to: "retro-1",
          count: 3,
          lastId: "comms:2",
          lastAt: Date.now() - 60_000,
          lastText: "Ready for review",
        },
      ],
    },
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const link = await screen.findByRole("button", { name: /^guido-1 ↔ retro-1,/i });
  fireEvent.mouseEnter(link);
  expect(within(screen.getByRole("tooltip")).getByText("Ready for review")).toBeTruthy();
  fireEvent.mouseLeave(link);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(seat(/^guido-1,/i));
  expect(within(screen.getByRole("tooltip")).getByText(/Sent 3 · received 0/)).toBeTruthy();
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
    ...quiet,
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const crew = await screen.findByRole("button", { name: /^#crew,.*received 3/i });
  expect(crew.classList).toContain("hub");
  expect(screen.getByRole("button", { name: /^#crew ↔ guido-1, 3 messages/i })).toBeTruthy();
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
      within(traffic).getByRole("group", { name: /Comms chart, 3 seats, 5 messages in 24h/ }),
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

it("shows each sender's message-length p95 and count against the limit, flagging long ones", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/metrics": {
      from: 0,
      to: 1,
      p95BySeat: [
        { seatId: "guido-1", p95: 400, n: 12 },
        { seatId: "retro-1", p95: 1100, n: 7 },
        { seatId: "flight-1", p95: 1500, n: 3 },
        { seatId: "quiet-1", p95: null, n: 0 },
      ],
    },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const panel = await screen.findByRole("region", { name: /Message length p95/ });
  expect(within(panel).getByText(/1,200 characters/)).toBeTruthy();
  const items = within(panel).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringMatching(/flight-1/i),
    expect.stringMatching(/retro-1/i),
    expect.stringMatching(/guido-1/i),
    expect.stringContaining("quiet-1"),
  ]);
  expect(items[0]?.textContent).toContain("1,500");
  expect(items[0]?.textContent).toContain("3 msg");
  expect(items[0]?.className).toContain("over");
  expect(items[1]?.className).toContain("near");
  expect(items[2]?.className).not.toMatch(/near|over/);
  expect(items[3]?.textContent).toContain("—");
});

it("says so when no sender has a message in the range", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/metrics": { from: 0, to: 1, p95BySeat: [] },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  const panel = await screen.findByRole("region", { name: /Message length p95/ });
  expect(within(panel).getByText(/No messages in the last 24h/)).toBeTruthy();
  expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
});

it("says the message lengths could not be loaded instead of loading for good", async () => {
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/metrics": () => ({ status: 500, body: { error: "boom" } }),
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(await screen.findByText(/Couldn't load message lengths/)).toBeTruthy();
  expect(screen.queryByText(/Loading message lengths/)).toBeNull();
});

it("keeps a cached empty result but marks it stale when the refresh fails", async () => {
  let fail = false;
  stubFetch({
    "/api/comms/links": { links: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/metrics": () =>
      fail
        ? { status: 500, body: { error: "boom" } }
        : { status: 200, body: { from: 0, to: 1, p95BySeat: [] } },
  });
  render(<CommsGraph rows={rows} flightId="flight-1" view={{ kind: "crew" }} />);
  expect(await screen.findByText(/No messages in the last 24h/)).toBeTruthy();
  expect(screen.queryByText(/Stale/)).toBeNull();
  fail = true;
  act(() => hub.refetchTopic("agents"));
  expect(await screen.findByText(/Stale · couldn't refresh/)).toBeTruthy();
  expect(screen.getByText(/No messages in the last 24h/)).toBeTruthy();
});
