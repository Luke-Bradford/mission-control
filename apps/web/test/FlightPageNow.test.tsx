import type { FlightBlocked, FlightView, StandingInstructionList } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { buildBlockers } from "../src/flight/page/blockers.ts";
import { AGE_UNKNOWN, doingLines } from "../src/flight/page/DoingNow.tsx";
import { changedSomething } from "../src/flight/page/decisionEffect.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { stubFetch } from "./fetchStub.ts";
import { HOUR, MIN, NOW } from "./fixtures.ts";
import { flightPageApi } from "./flightPageFixtures.ts";
import { flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, "", "/flight");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
  window.history.replaceState(null, "", "/");
});

const run = { kind: "running", why: "working" } as const;

const waiting = (
  n: number,
  root: string,
  chain: string[],
  wait: string,
  min: number,
): FlightBlocked => ({
  ref: `shop-app#${n}`,
  title: `Ticket ${n}`,
  column: "In progress",
  waitsOn: [wait],
  chain: [`shop-app#${n}`, ...chain, root],
  waitedMin: min,
});

describe("a blocked chain", () => {
  const rootWait = "shop-app#7 (PR 12 in CI)";
  const blocked: FlightBlocked[] = [
    waiting(8, "shop-app#7", [], rootWait, 30),
    waiting(9, "shop-app#7", ["shop-app#8"], "shop-app#8", 20),
    waiting(10, "shop-app#7", ["shop-app#9", "shop-app#8"], "shop-app#9", 10),
  ];
  const flight: FlightView = { seat: null, decisions: [], blocked };

  it("is one row that names what frees it, not one row per link", () => {
    const rows = buildBlockers([], flight, run, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.what).toBe("3 tickets wait on shop-app#7");
    expect(rows[0]?.detail).toContain("Frees when shop-app#7 (PR 12 in CI) clears");
    expect(rows[0]?.detail).toContain("shop-app#8, shop-app#9, shop-app#10");
    expect(rows[0]?.owner).toBe("CI");
    expect(rows[0]?.waitedMs).toBe(30 * MIN);
  });

  it("renders as one row in the Blockers panel", async () => {
    const api = flightPageApi("running");
    stubFetch({ ...api, "/api/flight": { ...api["/api/flight"], blocked } });
    render(<Flight />);
    const rows = await waitFor(() => {
      const r = document.querySelectorAll("#blockers .fp-brow");
      expect(r.length).toBe(1);
      return r;
    });
    expect(rows[0]?.textContent).toContain("3 tickets wait on shop-app#7");
    expect(rows[0]?.textContent).not.toContain("Waits on");
  });

  it("says in words what frees a single ticket", () => {
    const rows = buildBlockers([], { ...flight, blocked: [blocked[0] as FlightBlocked] }, run, NOW);
    expect(rows[0]?.detail).toBe("Frees when shop-app#7 (PR 12 in CI) clears.");
  });
});

describe("Recent decisions", () => {
  const d = (kind: string, decision: string) =>
    ({ kind, decision, about: "x", basis: "", id: 1, at: NOW }) as never;
  it("leaves out decisions that changed nothing", () => {
    expect(changedSomething(d("dismiss", "No open item with that key was found."))).toBe(false);
    expect(changedSomething(d("brief", "Headline Saved (111 characters)"))).toBe(false);
    expect(changedSomething(d("note", "Saved your headline (111 of 200 characters)."))).toBe(false);
    expect(changedSomething(d("note", "Tracked work:1 in your ledger."))).toBe(false);
    expect(changedSomething(d("answer", "Use 5171, the one the config already names."))).toBe(true);
  });

  it("does not list them on the page", async () => {
    const api = flightPageApi("running");
    const view = api["/api/flight"];
    stubFetch({
      ...api,
      "/api/flight": {
        ...view,
        decisions: [
          {
            ...view.decisions[0],
            id: 900,
            kind: "dismiss",
            about: "q:9",
            decision: "No open item with that key was found.",
          },
          ...view.decisions,
        ],
      },
    });
    render(<Flight />);
    await screen.findAllByText(/which port should the preview use/);
    expect(document.querySelector("#decisions")?.textContent).not.toContain("No open item");
  });
});

describe("Doing now", () => {
  const summary = (over = {}) =>
    flightSummary({
      headline: "Shipping.",
      headlineAgeMin: 4,
      now: [
        { ...summaryItem(ledgerEntry({ key: "work:1", title: "Reviewing A" })), ageMin: 95 },
        {
          ...summaryItem(ledgerEntry({ key: "work:2", title: "Merged B", status: "done" })),
          ageMin: 5,
        },
        { ...summaryItem(ledgerEntry({ key: "work:3", title: "Reviewing C" })), ageMin: 2 },
      ],
      ...over,
    });

  it("gives every line an age and drops closed work", () => {
    const lines = doingLines(run, summary());
    expect(lines.map((l) => l.lead)).toEqual(["Headline", "Reviewing A", "Reviewing C"]);
    expect(lines.map((l) => l.age)).toEqual(["4m", "1h 35m", "2m"]);
  });

  it("is honest when the headline age is not known", () => {
    expect(doingLines(run, summary({ headlineAgeMin: null }))[0]?.age).toBe(AGE_UNKNOWN);
  });

  it("shows the ages on the page", async () => {
    stubFetch(flightPageApi("running", { "/api/flight/summary": summary() }));
    render(<Flight />);
    await screen.findByText("Reviewing A");
    const ages = [...document.querySelectorAll("#doing .fp-age")].map((a) => a.textContent);
    expect(ages).toEqual(["4m", "1h 35m", "2m"]);
    expect(document.querySelector("#doing")?.textContent).not.toContain("Merged B");
  });
});

describe("Standing orders", () => {
  const order = (id: number, text: string, at: number) => ({
    id,
    at,
    revokedAt: null,
    source: "saved" as const,
    seatId: null,
    by: "operator" as const,
    kind: "text" as const,
    text,
  });
  const orders: StandingInstructionList = {
    active: [order(7, "Review only. No new builds.", NOW - 5 * HOUR)],
    history: [],
    nextCursor: null,
  };
  const pause = { seats: "all", reason: "Quiet hours", at: NOW - 2 * HOUR, by: "operator" };

  it("lists each order with who set it, when, when it ends and an end action", async () => {
    stubFetch(
      flightPageApi("running", {
        "/api/flight/orders?limit=1": orders,
        "/api/settings/crew-pause": pause,
      }),
    );
    render(<Flight />);
    const panel = await screen.findByRole("region", { name: /^Standing orders/ });
    // the strip shows the first order whole in meta and end
    await waitFor(() => expect(panel.textContent).toContain("Quiet hours"));
    expect(within(panel).getAllByRole("button", { name: /Resume crew/ }).length).toBe(1);
    fireEvent.click(within(panel).getByRole("button", { name: /Show all \(2\)/ }));
    const rows = [...panel.querySelectorAll("li")];
    expect(rows.length).toBe(2);
    const order = rows[1]?.textContent ?? "";
    expect(order).toContain("Review only. No new builds.");
    expect(order).toContain("Set by operator");
    expect(order).toContain("5 h ago");
    expect(order).toContain("Ends: not set");
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: /End order/ })).toBeTruthy();
    const second = rows[0]?.textContent ?? "";
    expect(second).toContain("Crew paused");
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: /Resume crew/ }),
    ).toBeTruthy();
  });

  it("keeps the setter, time and end outside the clamped text of a long order", async () => {
    const long = "x".repeat(300);
    stubFetch(
      flightPageApi("running", {
        "/api/flight/orders?limit=1": { ...orders, active: [order(8, long, NOW - 2 * HOUR)] },
      }),
    );
    render(<Flight />);
    const panel = await screen.findByRole("region", { name: /^Standing orders/ });
    fireEvent.click(await within(panel).findByRole("button", { name: /Show all/ }));
    const li = panel.querySelector("li") as HTMLElement;
    const clamp = li.querySelector(".fp-clamp") as HTMLElement;
    expect(clamp.contains(li.querySelector(".fp-meta"))).toBe(false);
    expect(li.querySelector(".fp-meta")?.textContent).toContain("Set by operator");
    const more = within(li).getByRole("button", { name: "Show all" });
    fireEvent.click(more);
    expect(li.querySelector(".fp-clamp")).toBeNull();
    expect(within(li).getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("ends an order through the revoke route after a confirm", async () => {
    const posts: string[] = [];
    stubFetch(
      flightPageApi("running", {
        "/api/flight/orders?limit=1": orders,
        "POST /api/flight/orders/7/revoke": () => {
          posts.push("/api/flight/orders/7/revoke");
          return { status: 200, body: {} };
        },
      }),
    );
    render(<Flight />);
    fireEvent.click(await screen.findByRole("button", { name: /End order/ }));
    expect(posts).toEqual([]);
    fireEvent.click(await screen.findByRole("button", { name: /Confirm end/ }));
    await waitFor(() => expect(posts).toContain("/api/flight/orders/7/revoke"));
  });

  it("says so when nothing is in force", async () => {
    stubFetch(
      flightPageApi("running", {
        "/api/flight/orders?limit=1": { active: [], history: [], nextCursor: null },
      }),
    );
    render(<Flight />);
    const panel = await screen.findByRole("region", { name: /^Standing orders/ });
    await waitFor(() => expect(panel.textContent).toContain("No orders in force"));
  });
});
