import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import {
  NeedsYouTab,
  NOBODY_ELSE,
  NOTHING_DEFAULTED,
  NOTHING_HANDLING,
  NOTHING_HELD,
} from "../src/flight/NeedsYouTab.tsx";
import { needsGroups } from "../src/flight/needsGroups.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { useItem } from "../src/shell/overlays.ts";
import { stubFetch as fetchStub } from "./fetchStub.ts";
import { brief, CONFIG, HOUR, item, NOW } from "./fixtures.ts";

const stubFetch = (routes: Parameters<typeof fetchStub>[0] = {}) =>
  fetchStub({
    "/api/config": CONFIG,
    "/api/drafts": [],
    "/api/drafts/history": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/attention/held": [],
    ...routes,
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
});

const panel = (id: string) => document.getElementById(id) as HTMLElement;

describe("needsGroups", () => {
  it("puts each open item in one group: ask, default, FLIGHT's, someone else's", () => {
    const g = needsGroups([
      item({ key: "ask" }),
      item({ key: "def", defaultDueAt: NOW + HOUR }),
      item({ key: "fl", owner: "flight", flightTriage: "waiting" }),
      item({ key: "ctl", owner: "controller" }),
      item({ key: "ask" }),
    ]);
    expect(g.asks.map((i) => i.key)).toEqual(["ask"]);
    expect(g.defaulted.map((i) => i.key)).toEqual(["def"]);
    expect(g.handling.map((i) => i.key)).toEqual(["fl"]);
    expect(g.waiting.map((i) => i.key)).toEqual(["ctl"]);
  });
});

describe("Needs you tab", () => {
  it("says each group is empty when nothing is in it, and Held nothing held", async () => {
    stubFetch({ "/api/attention": [] });
    render(<NeedsYouTab />);
    await waitFor(() => expect(panel("defaultsP").textContent).toContain(NOTHING_DEFAULTED));
    expect(panel("handlingP").textContent).toContain(NOTHING_HANDLING);
    expect(panel("waitingP").textContent).toContain(NOBODY_ELSE);
    expect(panel("heldP").textContent).toContain(NOTHING_HELD);
  });

  it("shows a dash in each group until the attention list loads", () => {
    stubFetch({ "/api/attention": [] });
    render(<NeedsYouTab />);
    for (const id of ["defaultsP", "handlingP", "waitingP"]) {
      expect(panel(id).textContent).toContain("—");
    }
  });

  it("lists the asks with their full brief open, which Hide folds, never an ask with a default", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "decision:a",
          kind: "decision",
          text: "Pick a window",
          brief: brief({ assessment: "Two windows fit.", recommendation: "Take Friday" }),
        }),
        item({ key: "decision:d", text: "Defaulted ask", defaultDueAt: NOW + HOUR }),
      ],
    });
    render(<NeedsYouTab />);
    const asks = await screen.findAllByTestId("ask-row");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.textContent).toContain("Pick a window");
    expect(asks[0]?.textContent).toContain("Two windows fit.");
    fireEvent.click(within(asks[0] as HTMLElement).getByRole("button", { name: "Hide brief" }));
    expect(asks[0]?.textContent).not.toContain("Two windows fit.");
    fireEvent.click(within(asks[0] as HTMLElement).getByRole("button", { name: "Full brief" }));
    expect(asks[0]?.textContent).toContain("Two windows fit.");
  });

  it("lists what FLIGHT will do unless you object, with the recommendation and when", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "decision:d",
          text: "Defaulted ask",
          defaultDueAt: NOW + 2 * HOUR,
          brief: brief({ recommendation: "Take Friday" }),
        }),
      ],
    });
    render(<NeedsYouTab />);
    await waitFor(() =>
      expect(panel("defaultsP").textContent).toContain(
        "Recommended: Take Friday · applies in 2h 00m",
      ),
    );
    expect(panel("defaultsP").textContent).toContain("Defaulted ask");
    expect(panel("askP").textContent).not.toContain("Defaulted ask");
  });

  it("lists what FLIGHT is handling with its note, and labels items waiting on a down FLIGHT", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "h",
          text: "Handled item",
          owner: "flight",
          flightTriage: "handling",
          brief: brief({ assessment: "Rebasing the branch." }),
        }),
        item({ key: "t", kind: "tag", text: "Seat tag", owner: "flight", flightTriage: "down" }),
        item({ key: "m", text: "Mine" }),
      ],
    });
    render(<NeedsYouTab />);
    await waitFor(() => expect(panel("handlingP").textContent).toContain("Handled item"));
    expect(panel("handlingP").textContent).toContain("Rebasing the branch.");
    expect(panel("handlingP").textContent).toContain("Waiting on FLIGHT — not triaging");
    expect(panel("handlingP").textContent).not.toContain("Mine");
  });

  it("lists items another owner has, and says who", async () => {
    stubFetch({
      "/api/attention": [item({ key: "c", text: "Controller's call", owner: "controller" })],
    });
    render(<NeedsYouTab />);
    await waitFor(() => expect(panel("waitingP").textContent).toContain("Controller's call"));
    expect(panel("waitingP").textContent).toContain("With controller");
  });

  it("opens an item from any group", async () => {
    function Probe() {
      return <span data-testid="open">{useItem() ?? "none"}</span>;
    }
    stubFetch({
      "/api/attention": [item({ key: "c", text: "Controller's call", owner: "controller" })],
    });
    render(
      <>
        <Probe />
        <NeedsYouTab />
      </>,
    );
    fireEvent.click(await within(panel("waitingP")).findByRole("button", { name: "Open" }));
    expect(screen.getByTestId("open").textContent).toBe("c");
  });

  it("lists Held items under their own heading, with Release", async () => {
    stubFetch({
      "/api/attention": [],
      "/api/attention/held": [
        item({
          key: "hold:1",
          text: "Held item",
          hold: { reason: "waiting for CI", condition: { kind: "manual" }, at: NOW } as never,
        }),
      ],
    });
    render(<NeedsYouTab />);
    await waitFor(() => expect(panel("heldP").textContent).toContain("Held item"));
    expect(within(panel("heldP")).getByRole("button", { name: "Release" })).toBeTruthy();
  });

  it("sends FLIGHT not triaging to its listed items, in the asks", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "flight:not-triaging",
          kind: "blocked",
          escalationId: null,
          text: "FLIGHT is stopped: 1 waiting since 12:55.",
          notTriaging: { cause: "stopped", keys: ["t"], since: 0 },
        }),
        item({ key: "t", kind: "tag", text: "Seat tag", owner: "flight", flightTriage: "down" }),
      ],
    });
    render(<Flight />);
    expect(
      await within(panel("askP")).findByText(/FLIGHT is stopped: 1 waiting since 12:55\./),
    ).toBeTruthy();
    expect(panel("handlingP").textContent).toContain("Seat tag");
  });
});
