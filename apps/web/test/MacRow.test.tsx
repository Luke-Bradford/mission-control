import type { MachineSample } from "@mc/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { MacRow } from "../src/overview/MacRow.tsx";
import { stubFetch } from "./fetchStub.ts";
import { NOW, OVERVIEW, seatRow } from "./fixtures.ts";

const GIB = 2 ** 30;

function sample(over: Partial<MachineSample> = {}): MachineSample {
  return {
    at: NOW,
    cpuPct: 37.4,
    cores: 16,
    memUsedBytes: 20.5 * GIB,
    memTotalBytes: 64 * GIB,
    diskFreeBytes: 412 * GIB,
    diskTotalBytes: 1000 * GIB,
    agents: { count: 3, rssBytes: 2 * GIB, cpuPct: 80 },
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  hub.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(
  machine: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  overview: unknown = OVERVIEW,
) {
  stubFetch({
    "/api/machine": machine,
    "/api/overview": overview,
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    ...extra,
  });
  return render(<MacRow />);
}
/** The row's measures by label: "CPU" → "37%". */
const measures = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll(".mac-measure")].map((el) => [
      el.querySelector(".muted")?.textContent,
      el.querySelector("b")?.textContent,
    ]),
  );

describe("MacRow", () => {
  it("shows CPU, memory, swap, free disk and the lock from the latest sample", async () => {
    const { container } = show(
      { latest: sample({ swapUsedBytes: 1.5 * GIB }), warning: null },
      { "/api/test-lock": { holder: null, waiting: [] } },
    );
    await waitFor(() => expect(measures(container).CPU).toBe("37%"));
    expect(measures(container)).toEqual({
      CPU: "37%",
      Mem: "32%",
      Swap: "1.5 GiB",
      Disk: "412 GiB",
      Lock: "free",
    });
    expect(container.querySelector("#macP")?.getAttribute("aria-label")).toBe("This machine");
    const title = within(container.querySelector("#macP") as HTMLElement).getByRole("link", {
      name: "Mac",
    });
    expect(title.getAttribute("href")).toBe("/telemetry");
    expect(container.querySelector(".mac-warning")).toBeNull();
  });

  it("shows dashes for every reading while there is no sample, and no warning", async () => {
    const { container } = show({ latest: null, warning: null });
    await waitFor(() => expect(measures(container).Lock).toBe("free"));
    expect(measures(container)).toEqual({
      CPU: "—",
      Mem: "—",
      Swap: "—",
      Disk: "—",
      Lock: "free",
    });
    expect(container.querySelector(".mac-measure svg")).toBeNull();
    expect(container.querySelector(".mac-warning")).toBeNull();
  });

  it("shows a dash for a swap that was not measured, and for memory with no total", async () => {
    const { container } = show({
      latest: sample({ swapUsedBytes: null, memTotalBytes: 0 }),
      warning: null,
    });
    await waitFor(() => expect(measures(container).CPU).toBe("37%"));
    expect(measures(container).Swap).toBe("—");
    expect(measures(container).Mem).toBe("—");
  });

  it("says the hub is holding new work, and why, when the machine reports a warning", async () => {
    const { container } = show({
      latest: sample(),
      warning: "Memory is under 2 GB free",
    });
    const warning = await screen.findByText("Holding new work · Memory is under 2 GB free");
    expect(warning.getAttribute("role")).toBe("status");
    expect(warning.classList.contains("warn-t")).toBe(true);
    expect(container.querySelector("#macP")?.contains(warning)).toBe(true);
  });

  it("names the seat holding the test lock by its call sign", async () => {
    const { container } = show(
      { latest: sample(), warning: null },
      {
        "/api/test-lock": {
          holder: { runId: "r-1", seatId: "guido-2", command: "pnpm -s test", since: NOW - 83_000 },
          waiting: [],
        },
        "/api/crew?shape=summary": {
          rows: [seatRow({ id: "guido-2", index: 1 })],
          firstRunToday: null,
        },
      },
    );
    await waitFor(() => expect(measures(container).Lock).not.toBe("free"));
    await waitFor(() => expect(measures(container).Lock).toBe("GUIDO-2"));
  });

  it("says free for the lock when nobody holds it, and a dash before the lock has answered", async () => {
    let finish!: (response: Response) => void;
    const fetch = stubFetch({
      "/api/machine": { latest: sample(), warning: null },
      "/api/overview": OVERVIEW,
      "/api/test-lock": { holder: null, waiting: [] },
      "/api/crew?shape=summary": { rows: [] },
    });
    const original = fetch.getMockImplementation();
    if (!original) throw new Error("Missing fetch stub");
    fetch.mockImplementation((path, init) =>
      path === "/api/test-lock"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(path, init),
    );
    const { container } = render(<MacRow />);
    await waitFor(() => expect(measures(container).CPU).toBe("37%"));
    expect(measures(container).Lock).toBe("—");
    finish(
      new Response(JSON.stringify({ holder: null, waiting: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() => expect(measures(container).Lock).toBe("free"));
  });

  it("draws a thirty-minute sparkline for each measure that has history", async () => {
    const { container } = show(
      { latest: sample(), warning: null },
      {},
      { ...OVERVIEW, machine: { cpu: [10, 30, 20], mem: [40, 50, 45], diskFreeGb: 412 } },
    );
    await waitFor(() => expect(container.querySelectorAll(".mac-measure svg").length).toBe(2));
    expect(
      [...container.querySelectorAll(".mac-measure svg")].map((svg) =>
        svg.getAttribute("aria-label"),
      ),
    ).toEqual(["CPU, last 30 minutes", "Mem, last 30 minutes"]);
  });

  it("says the machine reading could not load when the first load fails", async () => {
    stubFetch({
      "/api/machine": () => ({ status: 500, body: { error: "down" } }),
      "/api/overview": OVERVIEW,
      "/api/test-lock": { holder: null, waiting: [] },
      "/api/crew?shape=summary": { rows: [] },
    });
    const { container } = render(<MacRow />);
    expect(await screen.findByText("Machine reading could not load.")).toBeTruthy();
    expect(container.querySelector(".mac-measure")).toBeNull();
  });
});
