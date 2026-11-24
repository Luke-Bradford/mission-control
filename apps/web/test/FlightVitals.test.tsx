import type { FlightView } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { PAGE_TAB_LABEL, PAGE_TABS } from "../src/flight/page/FlightPage.tsx";
import {
  band,
  computeVitals,
  LOADING,
  NOT_MEASURED,
  UNMEASURED,
  type VitalInputs,
} from "../src/flight/page/vitals.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, HOUR, item, MIN, NOW } from "./fixtures.ts";
import { flightPageApi } from "./flightPageFixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

const run = { kind: "running", why: "working" } as const;
const empty: VitalInputs = {
  now: NOW,
  run,
  view: undefined,
  summary: undefined,
  attention: undefined,
  ledger: undefined,
};
const hours = (ns: number[]) =>
  ns.map((n, i) => ({ at: NOW - (ns.length - i) * HOUR, n, byReason: {} }));
const view = (over: Partial<FlightView>): FlightView => ({ seat: null, decisions: [], ...over });

describe("band", () => {
  it("is good at or under the first limit, bad over the second, watch between", () => {
    expect([band(6, 6, 12), band(7, 6, 12), band(12, 6, 12), band(13, 6, 12)]).toEqual([
      "ok",
      "warn",
      "warn",
      "crit",
    ]);
  });
});

describe("computeVitals", () => {
  it("says loading for every vital while its source has not answered", () => {
    const vitals = computeVitals({ ...empty, run: { kind: "loading" } });
    expect(vitals.every((v) => v.state === "none" && v.value === LOADING)).toBe(true);
  });

  it("says what is missing when a source has answered with nothing", () => {
    const vitals = computeVitals({
      ...empty,
      view: view({ wakeHistory: { since: 0, total: 0, idle: 0, byReason: [], perHour: [] } }),
      summary: flightSummary({ headlineAgeMin: null }),
      ledger: [],
    });
    const value = (id: string) => vitals.find((v) => v.id === id)?.value;
    expect(value("wakes")).toBe("no wakes in the last 24 hours");
    expect(value("headline")).toBe("FLIGHT has not written one");
    expect(value("pointers")).toBe("FLIGHT points at nothing");
    for (const v of vitals.filter((x) => x.state === "none"))
      expect(v.value).not.toMatch(/no data/i);
  });

  it("computes wakes an hour as the median of the last day's hours", () => {
    const wakes = (ns: number[]) =>
      computeVitals({
        ...empty,
        view: view({
          wakeHistory: { since: 0, total: 0, idle: 0, byReason: [], perHour: hours(ns) },
        }),
      }).find((v) => v.id === "wakes");
    expect(wakes([2, 3, 4])).toMatchObject({ state: "ok", value: "3 (median, last 24 hours)" });
    expect(wakes([8, 9, 30])?.state).toBe("warn");
    expect(wakes([14, 15, 16, 2])?.state).toBe("crit");
  });

  it("judges idle wakes by their share", () => {
    const idle = (n: number, total: number) =>
      computeVitals({
        ...empty,
        view: view({ wakeHistory: { since: 0, total, idle: n, byReason: [], perHour: [] } }),
      }).find((v) => v.id === "idle");
    expect(idle(1, 10)?.state).toBe("ok");
    expect(idle(4, 10)?.state).toBe("warn");
    expect(idle(6, 10)?.state).toBe("crit");
    expect(idle(0, 0)?.value).toBe("no wakes in the last 24 hours");
  });

  it("reads asks waiting on the operator with the oldest wait", () => {
    const asks = (at: number[]) =>
      computeVitals({ ...empty, attention: at.map((a, i) => item({ key: `q:${i}`, at: a })) }).find(
        (v) => v.id === "asks",
      );
    expect(asks([])).toMatchObject({ state: "ok", value: "none" });
    expect(asks([NOW - 10 * MIN])).toMatchObject({ state: "ok", value: "1, oldest 10m" });
    expect(asks([NOW - 5 * HOUR, NOW - MIN])?.state).toBe("crit");
  });

  it("counts asks as Needs you does: answered items and repeated keys are not waiting", () => {
    const answered = item({
      key: "q:old",
      at: NOW - 100 * 24 * HOUR,
      acked: true,
      brief: brief({
        choice: {
          epoch: "e",
          requestId: "r",
          optionId: "o",
          at: NOW - HOUR,
          state: "applied",
          text: "Use port 5174.",
          actor: { operator: true },
        },
      }),
    });
    const twice = item({ key: "q:same", at: NOW - 10 * MIN });
    const asks = computeVitals({ ...empty, attention: [answered] }).find((v) => v.id === "asks");
    expect(asks).toMatchObject({ state: "ok", value: "none" });
    const dup = computeVitals({ ...empty, attention: [twice, twice] }).find((v) => v.id === "asks");
    expect(dup).toMatchObject({ state: "ok", value: "1, oldest 10m" });
  });

  it("counts a pointer as unread only when it moved after FLIGHT last read it", () => {
    const ptr = (changedAt: number | null, readAt: number | null) => ({
      kind: "pr" as const,
      target: "mc#1",
      changedAt,
      change: null,
      readAt,
    });
    const entry = (pointers: ReturnType<typeof ptr>[]) =>
      ({ key: "k", pointers }) as unknown as NonNullable<VitalInputs["ledger"]>[number];
    const read = (pointers: ReturnType<typeof ptr>[]) =>
      computeVitals({ ...empty, ledger: [entry(pointers)] }).find((v) => v.id === "pointers");
    expect(read([ptr(NOW - HOUR, NOW - MIN)])).toMatchObject({ state: "ok", value: "none" });
    expect(read([ptr(NOW - 5 * HOUR, null)])).toMatchObject({
      state: "crit",
      value: "1, oldest 5h 0m",
    });
    expect(read([])).toMatchObject({ state: "none", value: "FLIGHT points at nothing" });
  });
});

describe("the FLIGHT page tabs", () => {
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

  it("opens on the control room: a row per measure with a word as well as a colour", async () => {
    stubFetch(
      flightPageApi("running", {
        "/api/flight/summary": flightSummary({ headlineAgeMin: 400 }),
      }),
    );
    render(<Flight />);
    const room = await screen.findByRole("region", { name: /How the operation is faring/ });
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/^\d+/, ""))).toEqual(
      PAGE_TABS.map((t) => PAGE_TAB_LABEL[t]),
    );
    expect(screen.getByRole("tab", { name: /Control room/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const note = room.querySelector('[data-vital="headline"]');
    expect(note?.textContent).toContain("Bad");
    expect(note?.textContent).toContain("Age of FLIGHT's own note");
    // Measures with no source yet are one line, opened to name each and say what it needs.
    const unmeasured = room.querySelector(".fp-unmeasured");
    expect(unmeasured?.querySelector("summary")?.textContent).toBe(
      `${UNMEASURED.length} measures ${NOT_MEASURED}`,
    );
    const load = within(unmeasured as HTMLElement)
      .getByText("Load balance across the crew")
      .closest("li");
    expect(load?.textContent).toContain(UNMEASURED[0]?.source);
    expect(room.textContent).not.toMatch(/no data/i);
    expect(room.querySelectorAll("li[data-vital]").length).toBeGreaterThan(5);
  });

  it("puts Doing now and Blockers above the measures", async () => {
    stubFetch(flightPageApi("blocked"));
    render(<Flight />);
    const room = await screen.findByRole("region", { name: /How the operation is faring/ });
    const blockers = document.getElementById("blockersP");
    const doing = document.getElementById("doingP");
    for (const panel of [doing, blockers])
      expect(
        panel && panel.compareDocumentPosition(room) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
  });

  it("leaves CI failures to Records, its one home", async () => {
    stubFetch(flightPageApi("blocked"));
    render(<Flight />);
    const room = await screen.findByRole("region", { name: /How the operation is faring/ });
    expect(room.querySelector('[data-vital="ci-failures"]')).toBeNull();
    expect(room.textContent).not.toContain("CI failures");
  });

  it("shows a measure on the control room and on no other tab", async () => {
    stubFetch(flightPageApi("blocked"));
    render(<Flight />);
    const room = await screen.findByRole("region", { name: /How the operation is faring/ });
    const labels = [...room.querySelectorAll(".fp-vlabel")].map((e) => e.textContent ?? "");
    expect(labels.length).toBeGreaterThan(8);
    for (const tab of ["Plan", "Watching", "Memory", "People"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(tab) }));
      await screen.findByRole("tabpanel");
      const text = screen.getByRole("tabpanel").textContent ?? "";
      for (const label of labels) expect(text).not.toContain(label);
    }
  });

  it("says People is not measured yet", async () => {
    stubFetch(flightPageApi("running"));
    render(<Flight />);
    fireEvent.click(await screen.findByRole("tab", { name: /People/ }));
    expect((await screen.findByRole("tabpanel")).textContent).toContain(NOT_MEASURED);
  });
});
