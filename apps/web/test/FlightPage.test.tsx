import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { buildBlockers } from "../src/flight/page/blockers.ts";
import { NOT_RECORDED } from "../src/flight/page/StatusBand.tsx";
import { Flight } from "../src/pages/Flight.tsx";
import { stubFetch } from "./fetchStub.ts";
import { HOUR, item, MIN, NOW } from "./fixtures.ts";
import { flightPageApi, type PageState } from "./flightPageFixtures.ts";

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

function show(state: PageState, over: Record<string, unknown> = {}) {
  stubFetch(flightPageApi(state, over));
  return render(<Flight />);
}

describe("buildBlockers", () => {
  const run = { kind: "running", why: "working" } as const;
  it("sorts by time waited, longest first, with an owner and what FLIGHT is doing on each", () => {
    const flight = flightPageApi("blocked")["/api/flight"];
    const rows = buildBlockers(
      [item({ key: "q:1", at: NOW - 3 * HOUR }), item({ key: "q:2", at: NOW - 5 * MIN })],
      flight,
      run,
      NOW,
    );
    expect(rows.map((r) => r.waitedMs)).toEqual([3 * HOUR, 42 * MIN, 18 * MIN, 5 * MIN]);
    expect(rows.map((r) => r.owner)).toEqual(["Operator", "CI", "Other ticket", "Operator"]);
    for (const r of rows) expect(r.doing.length).toBeGreaterThan(8);
  });
  it("leaves out what FLIGHT owns itself", () => {
    expect(buildBlockers([item({ owner: "flight" })], undefined, run, NOW)).toEqual([]);
  });
  it("lists a stopped FLIGHT as the operator's, with no wait it cannot date, last", () => {
    const rows = buildBlockers(
      [item({ key: "q:1", at: NOW - HOUR })],
      undefined,
      { kind: "down", why: "FLIGHT is stopped." },
      NOW,
    );
    expect(rows.map((r) => r.what)).toEqual([
      "Choose a cache eviction policy",
      "FLIGHT is stopped",
    ]);
    expect(rows[1]?.waitedMs).toBeNull();
  });
});

describe("the FLIGHT page", () => {
  it("shows the four tiles with their definitions, and says Not recorded yet for cost and sessions", async () => {
    show("blocked");
    const band = await screen.findByLabelText("FLIGHT status");
    await waitFor(() => expect(band.textContent).toContain("Running"));
    const text = band.textContent ?? "";
    for (const k of ["FLIGHT", "Cost per hour", "Sessions per hour", "Context size"]) {
      expect(text).toContain(k);
    }
    expect(text.split(NOT_RECORDED)).toHaveLength(3);
    expect(text).toContain("74.2k");
    expect(text).toContain("37%");
  });

  it("shows Stopped with Start FLIGHT when the seat is not live", async () => {
    show("stopped");
    expect(await screen.findByRole("button", { name: "Start FLIGHT" })).toBeTruthy();
    expect(screen.getByLabelText("FLIGHT status").textContent).toContain("Stopped");
  });

  it("lists the blockers longest wait first, each with owner, wait and what FLIGHT is doing", async () => {
    show("blocked");
    const rows = await waitFor(() => {
      const r = document.querySelectorAll("#blockers .fp-brow");
      expect(r.length).toBe(3);
      return [...r];
    });
    expect(rows.map((r) => r.querySelector(".fp-wait")?.textContent)).toEqual([
      "3h 00m",
      "42m 00s",
      "18m 00s",
    ]);
    expect(rows.map((r) => r.querySelector(".fp-owner")?.textContent)).toEqual([
      "Operator",
      "CI",
      "Other ticket",
    ]);
    for (const r of rows)
      expect(r.querySelector(".fp-act")?.textContent?.length).toBeGreaterThan(8);
  });

  it("says Nothing is blocking FLIGHT at the top of the Blockers panel when there are none", async () => {
    show("running");
    const panel = await screen.findByRole("region", { name: /^Blockers/ });
    await waitFor(() => expect(within(panel).getByText("Nothing is blocking FLIGHT")).toBeTruthy());
    const body = panel.querySelector("#blockers");
    expect(body?.firstElementChild?.textContent).toBe("Nothing is blocking FLIGHT");
  });

  it("has no table, and the header links to the Board", async () => {
    show("blocked");
    const link = await screen.findByRole("link", { name: "Board" });
    expect(link.getAttribute("href")).toBe("/board");
    expect(document.querySelectorAll("table")).toHaveLength(0);
  });

  it("lists Doing now from the headline and the active entries, at most five", async () => {
    show("running");
    await waitFor(() => expect(document.querySelectorAll("#doing li").length).toBe(5));
    expect(document.querySelector("#doing")?.textContent).toContain("The crew is shipping");
  });

  it("lists decisions newest first with an anchor per row", async () => {
    show("running");
    await waitFor(() => expect(document.getElementById("decision-1")).not.toBeNull());
    const ids = [...document.querySelectorAll("#decisions li")].map((li) => li.id);
    expect(ids[0]).toBe("decision-1");
    expect(ids[1]).toBe("decision-2");
  });

  it("names a request that failed, not a dash", async () => {
    stubFetch({
      ...flightPageApi("running"),
      "/api/flight/summary": () => ({ status: 500, body: { error: "hub down" } }),
    });
    render(<Flight />);
    await waitFor(() =>
      expect(screen.getByText(/Could not load what FLIGHT is doing/)).toBeTruthy(),
    );
  });
});
