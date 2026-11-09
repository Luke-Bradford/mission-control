import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommsRails, type RailEdgeView, type RailSeatView } from "../src/comms/CommsRails.tsx";
import type { Flows } from "../src/comms/chartTypes.ts";
import { pairFilter } from "../src/comms/commsFilter.ts";
import { CHAR_PX, type RailGroup } from "../src/comms/rails.ts";

afterEach(() => vi.useRealTimers());

const hubSeat = (id: string, name: string): RailSeatView => ({
  id,
  name,
  role: null,
  color: "var(--fg)",
  presence: "idle",
  state: null,
  since: null,
  alert: false,
  hub: true,
  sent: 0,
  received: 0,
});

function crew(n: number): { seats: RailSeatView[]; groups: RailGroup[] } {
  const seats = [
    hubSeat("CAPCOM", "CAPCOM"),
    hubSeat("flight-1", "FLIGHT"),
    hubSeat("crew", "#crew"),
  ];
  const groups: RailGroup[] = [];
  for (let i = 0; i < n; i++) {
    const id = `dev-${i + 1}`;
    seats.push({
      ...hubSeat(id, `DEV-${i + 1}`),
      hub: false,
      role: "INCO",
      presence: i % 2 ? "running" : "idle",
      state: "Idle",
    });
    groups.push({ key: `R${i}`, ids: [id], header: false });
  }
  return { seats, groups };
}

const HUBS = ["CAPCOM", "flight-1", "crew"] as const;
const noFlows: Flows = { generation: 0, list: [] };

const edge = (a: string, b: string, extra: Partial<RailEdgeView> = {}): RailEdgeView => ({
  key: `${a}\0${b}`,
  a,
  b,
  aToB: 3,
  bToA: 1,
  weight: 1,
  last: null,
  waiting: null,
  ...extra,
});

function view(n: number, over: Partial<Parameters<typeof CommsRails>[0]> = {}) {
  const { seats, groups } = crew(n);
  const props = {
    seats,
    groups,
    hubIds: HUBS,
    edges: n > 1 ? [edge("dev-1", "dev-2"), edge("dev-1", "flight-1")] : [],
    mode: "all" as const,
    filter: null,
    flows: noFlows,
    reduced: false,
    label: "Comms chart",
    full: false,
    onPickSeat: vi.fn(),
    onPickLink: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
  return { props, ...render(<CommsRails {...props} />) };
}

it.each([1, 3, 9, 20, 50])("draws every seat and the three centre-line hubs for %i seats", (n) => {
  view(n);
  expect(document.querySelectorAll(".comms-node")).toHaveLength(n + 3);
  expect(document.querySelectorAll(".comms-node.hub")).toHaveLength(3);
  for (let i = 1; i <= n; i++)
    expect(screen.getByRole("button", { name: new RegExp(`^DEV-${i},`) })).toBeTruthy();
});

it("filters to a seat by click, Enter and Space", () => {
  const { props } = view(3);
  const seat = screen.getByRole("button", { name: /^DEV-2,/ });
  fireEvent.click(seat);
  fireEvent.keyDown(seat, { key: "Enter" });
  fireEvent.keyDown(seat, { key: " " });
  expect(props.onPickSeat).toHaveBeenCalledTimes(3);
  expect(props.onPickSeat).toHaveBeenCalledWith("dev-2");
});

it("filters to a link by click and by keyboard", () => {
  const { props } = view(3);
  const link = screen.getByRole("button", { name: /^DEV-1 ↔ DEV-2,/ });
  fireEvent.click(link);
  fireEvent.keyDown(link, { key: "Enter" });
  expect(props.onPickLink).toHaveBeenCalledTimes(2);
  expect(props.onPickLink).toHaveBeenCalledWith("dev-1", "dev-2");
});

it("walks the seats with the arrow keys and holds one tab stop", () => {
  view(3);
  const stops = () =>
    [...document.querySelectorAll<HTMLElement>(".comms-node[tabindex='0']")].map((n) =>
      n.getAttribute("aria-label"),
    );
  expect(stops()).toHaveLength(1);
  const first = document.querySelector<HTMLElement>(".comms-node[tabindex='0']") as HTMLElement;
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).not.toBe(first);
  expect(document.activeElement?.classList.contains("comms-node")).toBe(true);
  expect(stops()).toHaveLength(1);
});

it("clears the filter with Escape, and says what it is narrowed to", () => {
  const { props } = view(3, { filter: { kind: "seat", id: "dev-1" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onClear).toHaveBeenCalledTimes(1);
  const chip = screen.getByRole("status");
  expect(chip.textContent).toContain("DEV-1");
  fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));
  expect(props.onClear).toHaveBeenCalledTimes(2);
});

it("does not clear on Escape when nothing is filtered", () => {
  const { props } = view(3);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onClear).not.toHaveBeenCalled();
});

it("dims what a filter leaves out but keeps every seat where it was", () => {
  const { unmount } = view(3);
  const where = [...document.querySelectorAll(".comms-node")].map((n) =>
    n.getAttribute("transform"),
  );
  unmount();
  view(3, { filter: pairFilter("dev-1", "dev-2") });
  expect(
    [...document.querySelectorAll(".comms-node")].map((n) => n.getAttribute("transform")),
  ).toEqual(where);
  expect(document.querySelector(".comms-node[data-id='dev-3']")?.classList.contains("dim")).toBe(
    true,
  );
  expect(document.querySelector(".comms-node[data-id='dev-1']")?.classList.contains("dim")).toBe(
    false,
  );
  const toFlight = [...document.querySelectorAll(".comms-edge")].find(
    (el) => el.getAttribute("data-key") === "dev-1\0flight-1",
  );
  expect(toFlight?.classList.contains("dim")).toBe(true);
});

it("shows a waiting link by dashes and its wait in words, not by colour alone", () => {
  view(3, {
    edges: [
      edge("dev-1", "dev-2", {
        waiting: { n: 2, ms: 12 * 60_000, asker: "dev-1", question: "Which branch?" },
      }),
      edge("dev-2", "dev-3"),
    ],
  });
  const waiting = document.querySelector(".comms-edge.waiting");
  expect(waiting).not.toBeNull();
  expect(waiting?.querySelector(".comms-edge-line")?.getAttribute("stroke-dasharray")).toBeTruthy();
  expect(waiting?.querySelector(".comms-wait-mark")?.textContent).toContain("12m");
  expect(waiting?.getAttribute("aria-label")).toMatch(/waiting 12m/i);
  expect(document.querySelectorAll(".comms-edge.waiting")).toHaveLength(1);
  // The recipient carries the reply ring.
  expect(
    document.querySelector(".comms-node[data-id='dev-2']")?.classList.contains("waiting"),
  ).toBe(true);
});

it("in Open, draws only the links someone is waiting on", () => {
  view(3, {
    mode: "open",
    edges: [
      edge("dev-1", "dev-2", { waiting: { n: 1, ms: 60_000, asker: "dev-1", question: null } }),
      edge("dev-2", "dev-3"),
    ],
  });
  expect(document.querySelectorAll(".comms-edge")).toHaveLength(1);
  expect(document.querySelectorAll(".comms-node")).toHaveLength(6);
});

const later: Flows = { generation: 1, list: [{ from: "dev-1", to: "dev-2", n: 2 }] };

it("sends a dot along the link for each new message, and none under reduced motion", () => {
  const first = view(3);
  first.rerender(<CommsRails {...first.props} flows={later} />);
  expect(document.querySelectorAll(".comms-particle")).toHaveLength(2);
  first.unmount();
  const second = view(3, { reduced: true });
  second.rerender(<CommsRails {...second.props} flows={later} reduced />);
  expect(document.querySelector(".comms-particle")).toBeNull();
  // The link still lights, so the message is not missed.
  expect(document.querySelector(".comms-edge.live")).not.toBeNull();
});

it("does not replay messages that were already there when the chart opened", () => {
  view(3, { flows: later });
  expect(document.querySelector(".comms-particle")).toBeNull();
});

it("drops a travelling dot when its time is up", () => {
  vi.useFakeTimers();
  const v = view(3);
  v.rerender(
    <CommsRails
      {...v.props}
      flows={{ generation: 1, list: [{ from: "dev-1", to: "dev-2", n: 1 }] }}
    />,
  );
  expect(document.querySelectorAll(".comms-particle")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(3000));
  expect(document.querySelector(".comms-particle")).toBeNull();
});

it("says so when there are no links, rather than drawing nothing", () => {
  view(1);
  expect(screen.getByText(/no direct messages/i)).toBeTruthy();
});

it("sizes the wait pill to its words, so an hours wait stays inside it", () => {
  view(3, {
    edges: [
      edge("dev-1", "dev-2", {
        waiting: { n: 1, ms: 190 * 60_000, asker: "dev-1", question: null },
      }),
    ],
  });
  const mark = document.querySelector(".comms-wait-mark");
  expect(mark?.textContent).toBe("⧖ 3h 10m");
  expect(Number(mark?.querySelector("rect")?.getAttribute("width"))).toBeGreaterThanOrEqual(
    "⧖ 3h 10m".length * CHAR_PX,
  );
});

it("keeps many waits from stacking: no two marks overlap, and the rest are counted", () => {
  const { seats, groups } = crew(9);
  const asking = seats.filter((s) => !s.hub).map((s) => s.id);
  const edges = asking.map((id, i) =>
    edge(id, "flight-1", {
      waiting: { n: 1, ms: (i + 1) * 3_600_000, asker: id, question: null },
    }),
  );
  render(
    <CommsRails
      seats={seats}
      groups={groups}
      hubIds={HUBS}
      edges={edges}
      mode="open"
      filter={null}
      flows={noFlows}
      reduced={false}
      label="Comms chart"
      full={false}
      onPickSeat={vi.fn()}
      onPickLink={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  const boxes = [...document.querySelectorAll(".comms-wait-mark")].map((g) => {
    const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/
      .exec(g.getAttribute("transform") ?? "")
      ?.slice(1)
      .map(Number) ?? [0, 0];
    const w = Number(g.querySelector("rect")?.getAttribute("width"));
    return { x0: (x ?? 0) - w / 2, x1: (x ?? 0) + w / 2, y0: (y ?? 0) - 9, y1: (y ?? 0) + 9 };
  });
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1))
      expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
  });
  const more = document.querySelector(".comms-wait-more");
  expect(boxes.length + Number(/\+(\d+)/.exec(more?.textContent ?? "")?.[1] ?? 0)).toBe(9);
});
