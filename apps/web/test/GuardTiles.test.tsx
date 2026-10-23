import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Kpis } from "../src/telemetry/Kpis.tsx";
import { stubFetch } from "./fetchStub.ts";

const HITS = "/api/guard/hits?days=7";
const LOCK = "/api/test-lock";
const FREE = { holder: null, waiting: [] };

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** INCO-1 has held the lock for 83 s; two calls wait. */
function stubHeld() {
  stubFetch({
    [HITS]: { hits: [], counts: {} },
    [LOCK]: {
      holder: { runId: "inco-1:x", seatId: "inco-1", command: "pnpm -s test", since: NOW - 83_000 },
      waiting: [
        { runId: "guido-1:y", seatId: "guido-1", command: "pnpm -s test", since: NOW - 5000 },
        { runId: "guido-2:z", seatId: "guido-2", command: "pnpm -s test", since: NOW - 2000 },
      ],
    },
  });
}

const tile = (label: string): HTMLElement => screen.getByText(label).closest(".kpi") as HTMLElement;

describe("Guard tile", () => {
  it("shows the week's blocks and the top rule, linking to the Comms guard drawer", async () => {
    stubFetch({
      [HITS]: { hits: [], counts: { "git-write": 7, network: 3, secret: 2 } },
      [LOCK]: FREE,
    });
    render(<Kpis t={undefined} />);
    await screen.findByText("12");
    const t = tile("Guard");
    expect(t.textContent).toContain("blocked · most: git-write (7)");
    const link = t.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/comms#cGuard");
  });

  it("names the earlier-declared rule when counts tie", async () => {
    stubFetch({ [HITS]: { hits: [], counts: { network: 2, "git-write": 2 } }, [LOCK]: FREE });
    render(<Kpis t={undefined} />);
    await screen.findByText("blocked · most: git-write (2)");
  });

  it("reads 0 blocked this week when nothing was blocked", async () => {
    stubFetch({ [HITS]: { hits: [], counts: { "git-write": 0, network: 0 } }, [LOCK]: FREE });
    render(<Kpis t={undefined} />);
    await waitFor(() => expect(tile("Guard").textContent).toContain("blocked this week"));
    expect(tile("Guard").textContent).toContain("0");
    expect(tile("Guard").textContent).not.toContain("most:");
  });

  it("reads — while loading", () => {
    stubFetch({});
    render(<Kpis t={undefined} />);
    expect(tile("Guard").querySelector(".v")?.textContent).toBe("—");
    expect(tile("Guard").textContent).not.toContain("blocked");
  });

  it("refreshes on a guard event", async () => {
    let counts: Record<string, number> = { network: 1 };
    stubFetch({ [HITS]: () => ({ status: 200, body: { hits: [], counts } }), [LOCK]: FREE });
    render(<Kpis t={undefined} />);
    await screen.findByText("most: network (1)", { exact: false });
    counts = { network: 1, secret: 4 };
    hub.refetchTopic("guard");
    await screen.findByText("most: secret (4)", { exact: false });
  });
});

describe("Test lock tile", () => {
  it("shows who holds it, for how long, and how many wait", async () => {
    stubHeld();
    render(<Kpis t={undefined} />);
    await screen.findByText("INCO-1");
    const t = tile("Test lock");
    expect(t.querySelector(".d")?.textContent).toBe("holds it · 1:23 · 2 waiting");
  });

  it("counts the elapsed time up each second", async () => {
    stubHeld();
    render(<Kpis t={undefined} />);
    await screen.findByText("INCO-1");
    expect(tile("Test lock").querySelector(".d")?.textContent).toContain("1:23");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(tile("Test lock").querySelector(".d")?.textContent).toContain("1:24");
  });

  it("reads Free with 0 waiting when nobody holds it", async () => {
    stubFetch({ [HITS]: { hits: [], counts: {} }, [LOCK]: FREE });
    render(<Kpis t={undefined} />);
    await screen.findByText("Free");
    expect(tile("Test lock").textContent).toContain("0 waiting");
  });

  it("reads — while loading", () => {
    stubFetch({});
    render(<Kpis t={undefined} />);
    expect(tile("Test lock").querySelector(".v")?.textContent).toBe("—");
    expect(tile("Test lock").textContent).not.toContain("waiting");
  });

  it("refreshes on a guard event", async () => {
    let lock: unknown = FREE;
    stubFetch({ [HITS]: { hits: [], counts: {} }, [LOCK]: () => ({ status: 200, body: lock }) });
    render(<Kpis t={undefined} />);
    await screen.findByText("Free");
    lock = {
      holder: { runId: "a:b", seatId: "guido-1", command: "pnpm -s test", since: Date.now() },
      waiting: [],
    };
    hub.refetchTopic("guard");
    await screen.findByText("GUIDO-1");
  });
});
