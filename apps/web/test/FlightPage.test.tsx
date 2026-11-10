import type { FlightView } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { buildBlockers, waitOwner } from "../src/flight/page/blockers.ts";
import { decisionLine, readableText } from "../src/flight/page/decisionText.ts";
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
    expect(rows.map((r) => r.owner)).toEqual(["Operator", "CI", "#6", "Operator"]);
    for (const r of rows) expect(r.doing.length).toBeGreaterThan(8);
  });
  it("leaves out what FLIGHT owns itself", () => {
    expect(buildBlockers([item({ owner: "flight" })], undefined, run, NOW)).toEqual([]);
  });
  it("ages a stopped FLIGHT from its last wake and keeps every row in longest-wait order", () => {
    const down = { kind: "down", why: "FLIGHT is stopped." } as const;
    const asks = [item({ key: "q:1", at: NOW - HOUR })];
    const wakeAt = (lastWakeAt: number | null): FlightView => ({
      seat: null,
      decisions: [],
      wake: { lastWakeAt, wokeOn: null, nextWakeAt: null },
    });
    const older = buildBlockers(asks, wakeAt(NOW - 2 * HOUR), down, NOW);
    expect(older.map((r) => r.what)).toEqual([
      "FLIGHT is stopped",
      "Choose a cache eviction policy",
    ]);
    expect(older.map((r) => r.waitedMs)).toEqual([2 * HOUR, HOUR]);
    // woke more recently than the ask arrived: the one-hour ask waited longer, so it comes first
    const newer = buildBlockers(asks, wakeAt(NOW - 5 * MIN), down, NOW);
    expect(newer.map((r) => r.what)).toEqual([
      "Choose a cache eviction policy",
      "FLIGHT is stopped",
    ]);
    // no last wake recorded: the wait is unknown and the undated row follows every dated one
    const unknown = buildBlockers(asks, wakeAt(null), down, NOW);
    expect(unknown.map((r) => r.what)).toEqual([
      "Choose a cache eviction policy",
      "FLIGHT is stopped",
    ]);
    expect(unknown[1]?.waitedMs).toBeNull();
    expect(unknown[1]?.owner).toBe("Operator");
  });

  it("names the owner of a ticket's wait from the wait the hub wrote, never a guess", () => {
    const wait = (text: string) => waitOwner(text);
    expect(wait("shop-app#7 (PR 12 in CI)")).toEqual({ owner: "CI", tone: "ci" });
    expect(wait("PR 9 failing CI")).toEqual({ owner: "CI", tone: "ci" });
    expect(wait("shop-app#7 (PR 12 in review)").owner).toBe("Reviewer");
    expect(wait("PR 9 ready to merge").owner).toBe("Merge step");
    expect(wait("shop-app#7 (PR 12 is a draft)").owner).toBe("PR author");
    expect(wait("shop-app#7 (closed without merging)")).toEqual({
      owner: "Operator",
      tone: "operator",
    });
    expect(wait("PR 9 (not read yet)").owner).toBe("Hub");
    // only a reference: the reference itself, not "Other ticket" or an invented person
    expect(wait("mission-control#1390")).toEqual({ owner: "mission-control#1390", tone: "plain" });
    // in the blocked ticket's own repo the repo is dropped; across repos the full reference stays
    expect(waitOwner("mission-control#1572", "mission-control#1573").owner).toBe("#1572");
    expect(waitOwner("other-repo#9", "mission-control#1573").owner).toBe("other-repo#9");
    expect(waitOwner(undefined).owner).toBe("Not recorded");
  });
});

describe("the FLIGHT page", () => {
  it("shows held work in its Watch list and releases it", async () => {
    const held = item({
      key: "hold:1",
      text: "Wait for CI to finish",
      hold: { reason: "CI is still running", condition: { kind: "manual" }, at: NOW } as never,
    });
    const fetch = stubFetch(
      flightPageApi("running", {
        "/api/attention/held": [held],
        "POST /api/attention/hold%3A1/hold/release": { ok: true },
      }),
    );
    render(<Flight />);
    const panel = await waitFor(() => {
      const found = document.getElementById("watchP");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(panel).getByText("Wait for CI to finish")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/attention/hold%3A1/hold/release",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("names an empty and failed Watch list", async () => {
    show("running");
    expect(await screen.findByText("Nothing is held.")).toBeTruthy();
    cleanup();
    hub.clear();
    show("running", {
      "/api/attention/held": () => ({ status: 500, body: { error: "held down" } }),
    });
    expect(await screen.findByText("Could not load Watch list: held down")).toBeTruthy();
  });

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

  it("shows a punctuated stopped sentence on the read-only page", async () => {
    show("stopped");
    const band = await screen.findByLabelText("FLIGHT status");
    await waitFor(() => expect(band.textContent).toContain("FLIGHT is stopped. Last woke"));
    expect(band.textContent).not.toContain("stopped..");
    expect(screen.queryByRole("button", { name: "Start FLIGHT" })).toBeNull();
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
      "#6",
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

  it("opens a blocker row from the keyboard to its whole text", async () => {
    show("busy");
    const first = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>("#blockers .fp-brow");
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    // A native button is in the tab order and Enter or Space press it.
    expect(first.tagName).toBe("BUTTON");
    first.focus();
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.className).toContain("open");
    expect(first.querySelector(".fp-act")?.textContent?.length).toBeGreaterThan(300);
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a decision row to its basis, one at a time", async () => {
    show("running");
    const rows = await waitFor(() => {
      const r = document.querySelectorAll<HTMLButtonElement>("#decisions .fp-drow");
      expect(r.length).toBeGreaterThan(1);
      return [...r];
    });
    fireEvent.click(rows[0] as HTMLElement);
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".fp-detail")?.textContent).toContain("Basis");
    fireEvent.click(rows[1] as HTMLElement);
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll(".fp-detail")).toHaveLength(1);
  });

  describe("a wait decision", () => {
    const wait = {
      id: 7,
      at: NOW - 5 * MIN,
      kind: "wait" as const,
      seatId: "flight-1",
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "1549:stage:clearance:1794072257157: waiting on the stage clearance",
      decision: "waiting until 2026-11-08T11:45:00.000Z",
      basis: "Clearance is due by then.",
    };

    it("reads as a lead and a clock time, with no key or ISO time", () => {
      const line = decisionLine(wait, NOW, "Europe/London");
      expect(line.lead).toBe("Wait");
      const text = `${line.lead} ${line.rest}`;
      expect(text).toContain("11:45");
      expect(text).toContain("8 Nov");
      expect(text).not.toContain("1794072257157");
      expect(text).not.toContain("T11:45:00.000Z");
      expect(text).not.toContain("stage:clearance");
    });

    it("leads with the ticket when the decision names one", () => {
      expect(decisionLine({ ...wait, ref: "shop-app#5" }, NOW, "Europe/London").lead).toBe(
        "shop-app#5",
      );
    });

    it("writes machine times inside any text as clock times", () => {
      const text = readableText(
        "report 20261106T170333Z and 2026-11-08T11:45:00.000Z and 1794072257157",
        NOW,
        "Europe/London",
      );
      expect(text).not.toMatch(/T\d{6}Z|T11:45|\d{13}/);
      expect(text).toContain("11:45");
    });

    it("names an internal message id in words, in the line and in the opened basis", async () => {
      const withId = {
        ...wait,
        id: 8,
        about: "report:inco-1: waiting on un-parked 15:41, comms:2799",
        basis: "Answered in comms:2799.",
      };
      const api = flightPageApi("running");
      api["/api/flight"] = { ...api["/api/flight"], decisions: [withId] };
      stubFetch(api);
      render(<Flight />);
      const row = await waitFor(() => {
        const r = document.querySelector<HTMLButtonElement>("#decisions .fp-drow");
        expect(r).not.toBeNull();
        return r as HTMLButtonElement;
      });
      fireEvent.click(row);
      const text = document.querySelector("#decisions")?.textContent ?? "";
      expect(text).toContain("the related message");
      expect(text).toContain("Basis");
      expect(text).not.toMatch(/comms:\d+/);
      expect(decisionLine(withId, NOW, "Europe/London").rest).not.toMatch(/comms:\d+/);
    });

    it("formats live controller references in the closed row and expanded basis", async () => {
      const report = "b07f8730c520a469751233d540086a17c03f314dc42ccf592b011e1c9ad6c9f8";
      const live = {
        ...wait,
        kind: "note" as const,
        about: "Controller clears PR1635 on head25e3622c",
        decision: "Independent review1326 passed before closing1631.",
        basis: `Immutable QA report ${report}; review1326 passed on head25e3622c.`,
      };
      const api = flightPageApi("running");
      api["/api/flight"] = { ...api["/api/flight"], decisions: [live] };
      stubFetch(api);
      render(<Flight />);
      const row = await screen.findByRole("button", { name: /Controller clears/ });
      expect(row.textContent).toContain("PR 1635");
      fireEvent.click(row);
      const text = document.querySelector("#decisions")?.textContent ?? "";
      expect(text).toContain("head 25e3622c");
      expect(text).toContain("review 1326");
      expect(text).toContain("closing #1631");
      expect(text).toContain("the review report");
      expect(text).not.toMatch(/PR1635|head25e|review1326|closing1631|\b[a-f0-9]{64}\b/);
    });

    it("renders on the page without the key or the epoch digits", async () => {
      const api = flightPageApi("running");
      api["/api/flight"] = { ...api["/api/flight"], decisions: [wait] };
      stubFetch(api);
      render(<Flight />);
      await waitFor(() => expect(document.querySelectorAll("#decisions li")).toHaveLength(1));
      await waitFor(() =>
        expect(document.querySelector("#decisions")?.textContent).toContain("11:45"),
      );
      const text = document.querySelector("#decisions")?.textContent ?? "";
      expect(text).not.toContain("1794072257157");
      expect(text).not.toContain("T11:45:00.000Z");
    });
  });
});

describe("a ticket waiting on a ticket", () => {
  const blocked = (ref: string, waitsOn: string[]) => ({
    ref,
    title: "Waits",
    column: "In progress" as const,
    waitsOn,
    chain: [ref],
    waitedMin: 30,
  });
  const view = (b: ReturnType<typeof blocked>): FlightView => ({
    seat: null,
    decisions: [],
    blocked: [b],
  });
  const run = { kind: "running", why: "working" } as const;

  it("shows the short form for the same repo and keeps the full reference as the tag's title", () => {
    const rows = buildBlockers(
      [],
      view(blocked("mission-control#1573", ["mission-control#1572"])),
      run,
      NOW,
    );
    expect(rows[0]?.owner).toBe("#1572");
    expect(rows[0]?.ownerTitle).toBe("mission-control#1572");
  });

  it("keeps the repo across repos", () => {
    const rows = buildBlockers([], view(blocked("mission-control#1573", ["site#9"])), run, NOW);
    expect(rows[0]?.owner).toBe("site#9");
    expect(rows[0]?.ownerTitle).toBeUndefined();
  });

  it("renders the short form in the Owner column", async () => {
    const api = flightPageApi("blocked");
    api["/api/flight"] = {
      ...api["/api/flight"],
      blocked: [blocked("shop-app#8", ["shop-app#1572"])],
    };
    stubFetch(api);
    render(<Flight />);
    const tag = await waitFor(() => {
      const owners = [...document.querySelectorAll<HTMLElement>("#blockers .fp-owner")];
      const hit = owners.find((o) => o.textContent === "#1572");
      expect(hit).toBeDefined();
      return hit as HTMLElement;
    });
    expect(tag.title).toBe("shop-app#1572");
  });
});
