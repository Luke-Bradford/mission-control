import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { TokensPanel } from "../src/overview/TokensPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import {
  CONFIG,
  HOUR,
  limit5h,
  limit7d,
  METRICS_VIEW,
  MIN,
  NOW,
  OVERVIEW,
  seatRow,
} from "./fixtures.ts";
import { observedContextDigest } from "./overviewDensityFixtures.ts";

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

const END = Math.floor(NOW / MIN) * MIN;
const week = (over: Parameters<typeof limit7d>[0] = {}) =>
  limit7d({ accountId: "claude-main", alertAt: 85, stopAt: 95, ...over });

function show(limits: ReturnType<typeof limit7d>[], extra: Record<string, unknown> = {}) {
  stubFetch({
    "/api/limits": limits,
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/overview": OVERVIEW,
    ...extra,
  });
  return render(<TokensPanel />);
}
const accountBlock = (container: HTMLElement, id: string) =>
  [...container.querySelectorAll<HTMLElement>(".token-account")].find(
    (block) => block.querySelector(".token-head b")?.textContent === id,
  ) as HTMLElement;
const verdict = (container: HTMLElement, id: string) =>
  accountBlock(container, id).querySelector(".token-verdict");

describe("TokensPanel verdict", () => {
  it("says On pace when the week ends under its alert line and is not forecast to stop", async () => {
    const { container } = show([week({ used: 40, projected: 70, stopForecast: null })]);
    await waitFor(() => expect(verdict(container, "claude-main")?.textContent).toBe("On pace"));
    expect(verdict(container, "claude-main")?.classList.contains("ok-t")).toBe(true);
  });

  it("says On pace when the forecast stop falls after the reset", async () => {
    const { container } = show([
      week({ used: 40, projected: 70, stopForecast: NOW + 40 * HOUR, resetAt: NOW + 30 * HOUR }),
    ]);
    await waitFor(() => expect(verdict(container, "claude-main")?.textContent).toBe("On pace"));
  });

  it("says At its stop line, and that new runs are refused, once the week has reached it", async () => {
    const { container } = show([week({ used: 95, stopAt: 95, projected: 99 })]);
    await waitFor(() =>
      expect(verdict(container, "claude-main")?.textContent).toBe(
        "At its stop line · new runs refused",
      ),
    );
    expect(verdict(container, "claude-main")?.classList.contains("crit-t")).toBe(true);
  });

  it("says when it stops about, in the operator's timezone, if the forecast stop is before the reset", async () => {
    // 15:00 UTC on the same day is 16:00 in London (BST)
    const { container } = show([
      week({ used: 80, projected: 120, stopForecast: NOW + 3 * HOUR, resetAt: NOW + 30 * HOUR }),
    ]);
    await waitFor(() =>
      expect(verdict(container, "claude-main")?.textContent).toBe("Stops about 16:00"),
    );
    expect(verdict(container, "claude-main")?.classList.contains("warn-t")).toBe(true);
  });

  it("says Too few readings to project when the week has no projection", async () => {
    const { container } = show([week({ used: 10, projected: null, stopForecast: null })]);
    await waitFor(() =>
      expect(verdict(container, "claude-main")?.textContent).toBe("Too few readings to project"),
    );
    expect(verdict(container, "claude-main")?.classList.contains("muted")).toBe(true);
    // with nothing projected there is no arrow to a figure at reset
    expect(accountBlock(container, "claude-main").textContent).not.toContain("by reset");
  });

  it("says Will pass its alert line when the projection reaches it", async () => {
    const { container } = show([week({ used: 60, projected: 90, alertAt: 85 })]);
    await waitFor(() =>
      expect(verdict(container, "claude-main")?.textContent).toBe("Will pass its alert line"),
    );
    expect(verdict(container, "claude-main")?.classList.contains("warn-t")).toBe(true);
  });

  it("shows the week used and where it ends by the reset", async () => {
    const { container } = show([week({ used: 60, projected: 90 })]);
    await waitFor(() => expect(accountBlock(container, "claude-main")).toBeTruthy());
    const head = accountBlock(container, "claude-main").querySelector(".token-head");
    expect(head?.querySelector(".token-used")?.textContent).toBe("60%");
    expect(head?.textContent).toContain("→ 90% by reset");
  });

  it("names the time of a stale week's reading", async () => {
    const { container } = show([week({ stale: true, sampledAt: NOW - 2 * HOUR })]);
    await waitFor(() =>
      expect(accountBlock(container, "claude-main").textContent).toContain("· read 11:00"),
    );
  });
});

describe("TokensPanel five-hour window", () => {
  it("shows the 5h reading and its reset time while the window is open", async () => {
    const { container } = show([
      week({ used: 40 }),
      limit5h({ accountId: "claude-main", used: 41, resetAt: NOW + 2 * HOUR }),
    ]);
    await waitFor(() =>
      expect(accountBlock(container, "claude-main").textContent).toContain("5h 41%, resets 15:00"),
    );
  });

  it("does not show a 5h reading whose reset has passed", async () => {
    const { container } = show([
      week({ used: 40 }),
      limit5h({ accountId: "claude-main", used: 88, resetAt: NOW - MIN }),
    ]);
    await waitFor(() => expect(accountBlock(container, "claude-main")).toBeTruthy());
    expect(accountBlock(container, "claude-main").textContent).not.toContain("5h");
    expect(accountBlock(container, "claude-main").textContent).not.toContain("88%");
  });

  it("does not show a 5h reading that resets exactly now", async () => {
    const { container } = show([week(), limit5h({ accountId: "claude-main", resetAt: NOW })]);
    await waitFor(() => expect(accountBlock(container, "claude-main")).toBeTruthy());
    expect(accountBlock(container, "claude-main").textContent).not.toContain("5h");
  });
});

describe("TokensPanel accounts", () => {
  it("shows each configured account on its own, with its own week, verdict and 5h window", async () => {
    const { container } = show([
      week({ used: 60, projected: 90 }),
      limit5h({ accountId: "claude-main", used: 30 }),
      limit7d({ accountId: "codex-main", used: 20, projected: null, alertAt: 70, stopAt: 80 }),
    ]);
    await waitFor(() => expect(container.querySelectorAll(".token-account")).toHaveLength(2));
    const claude = accountBlock(container, "claude-main");
    const codex = accountBlock(container, "codex-main");
    expect(claude.querySelector(".token-used")?.textContent).toBe("60%");
    expect(codex.querySelector(".token-used")?.textContent).toBe("20%");
    expect(claude.textContent).toContain("5h 30%");
    expect(codex.textContent).not.toContain("5h");
    expect(verdict(container, "claude-main")?.textContent).toBe("Will pass its alert line");
    expect(verdict(container, "codex-main")?.textContent).toBe("Too few readings to project");
    // one burn-up plot for each, each labelled with its account
    expect(
      [...container.querySelectorAll(".burnup svg")].map(
        (svg) => svg.getAttribute("aria-label")?.split(":")[0],
      ),
    ).toEqual(["claude-main", "codex-main"]);
  });

  it("totals the last hour for an account from its own seats only, on its own scale", async () => {
    const seat = (id: string, accountId: string, minutes: [number, number][]) =>
      seatRow({ id, accountId, digest: observedContextDigest(null, null, minutes) });
    const { container } = show([week(), limit7d({ accountId: "codex-main" })], {
      "/api/crew?shape=summary": {
        rows: [
          seat("a", "claude-main", [
            [END, 1000],
            [END - 5 * MIN, 500],
          ]),
          seat("b", "claude-main", [[END, 500]]),
          seat("c", "codex-main", [[END - MIN, 90_000]]),
        ],
        firstRunToday: null,
      },
    });
    await waitFor(() => expect(container.querySelectorAll(".hourbars")).toHaveLength(2));
    const claude = accountBlock(container, "claude-main");
    const codex = accountBlock(container, "codex-main");
    expect(claude.querySelector(".plot-reading")?.textContent).toBe("last hour 2.0kpeak 1.5k/min");
    expect(codex.querySelector(".plot-reading")?.textContent).toBe("last hour 90.0kpeak 90.0k/min");
    expect(claude.querySelector(".hourbars svg")?.getAttribute("aria-label")).toBe(
      "claude-main: 2.0k tokens in the last hour, peak 1.5k a minute",
    );
    // the busiest minute fills the plot on each account's own scale
    const heights = [...claude.querySelectorAll(".hourbars rect")].map((rect) =>
      Number(rect.getAttribute("height")),
    );
    expect(heights).toHaveLength(2);
    expect(heights[0]).toBeCloseTo(100 / 3, 5);
    expect(heights[1]).toBe(100);
    expect(
      [...codex.querySelectorAll(".hourbars rect")].map((rect) =>
        Number(rect.getAttribute("height")),
      ),
    ).toEqual([100]);
    expect(claude.querySelector(".hourbars .plot-axis")?.textContent).toBe("−60m−30mnow 0/min");
  });

  it("says there is no weekly reading yet for an account without one", async () => {
    const { container } = show([]);
    await waitFor(() => expect(container.querySelectorAll(".token-account")).toHaveLength(2));
    expect(screen.getAllByText("No weekly reading yet.")).toHaveLength(2);
    expect(accountBlock(container, "claude-main").querySelector(".token-used")?.textContent).toBe(
      "—",
    );
    expect(verdict(container, "claude-main")).toBeNull();
  });

  it("says when no provider accounts are configured", async () => {
    stubFetch({
      "/api/limits": [],
      "/api/config": { ...CONFIG, accounts: [] },
      "/api/crew?shape=summary": { rows: [] },
      "/api/overview": OVERVIEW,
    });
    render(<TokensPanel />);
    expect(await screen.findByText("No provider accounts configured.")).toBeTruthy();
  });
});

describe("TokensPanel verdict: the hub's own rules", () => {
  const verdict = async (limits: ReturnType<typeof limit7d>[], extra = {}) => {
    const { container } = show(limits, extra);
    await waitFor(() => expect(container.querySelector(".token-verdict")).toBeTruthy());
    return container.querySelector(".token-verdict")?.textContent;
  };

  it("keeps the stop forecast showing once past the alert line", async () => {
    const forecast = NOW + 2 * 60 * MIN;
    expect(await verdict([week({ used: 88, stopForecast: forecast })])).toMatch(/^Stops about/);
  });

  it("says past its alert line when no stop is forecast", async () => {
    expect(await verdict([week({ used: 88, stopForecast: null })])).toBe("Past its alert line");
  });

  it("does not call a fresh reading stale because a healthy collector left a note", async () => {
    const healthy = {
      collector: "usage:claude-main",
      ok: true,
      error: "no usable 5h reading",
      at: NOW,
      lastOkAt: NOW,
    };
    const text = await verdict(
      [week({ used: 10, projected: 20, stopForecast: null, sampledAt: NOW })],
      { "/api/health": [healthy] },
    );
    expect(text).toBe("On pace");
  });

  it("says a reading is from before the last reset once its reset has passed", async () => {
    expect(await verdict([week({ used: 90, resetAt: NOW - MIN })])).toBe(
      "Reading is from before the last reset",
    );
  });
});

describe("TokensPanel head", () => {
  it("links the title to Telemetry and shows today's spend", async () => {
    const { container } = show([week()], { "/api/metrics": METRICS_VIEW });
    await waitFor(() => expect(container.querySelector(".token-spend")).toBeTruthy());
    const title = within(container.querySelector("#tokensP") as HTMLElement).getByRole("link", {
      name: "Tokens",
    });
    expect(title.getAttribute("href")).toBe("/telemetry");
    expect(container.querySelector(".token-spend")?.textContent).toBe("~$24.31 today");
  });

  it("links an account to Setup accounts", async () => {
    const { container } = show([week()]);
    await waitFor(() => expect(accountBlock(container, "claude-main")).toBeTruthy());
    expect(
      accountBlock(container, "claude-main").querySelector(".token-head a")?.getAttribute("href"),
    ).toBe("/setup/accounts");
  });

  it("says Loading allowance… until the limits arrive, then says when they could not load", async () => {
    stubFetch({
      "/api/limits": () => ({ status: 500, body: { error: "down" } }),
      "/api/config": CONFIG,
      "/api/crew?shape=summary": { rows: [] },
      "/api/overview": OVERVIEW,
    });
    render(<TokensPanel />);
    expect(screen.getByText("Loading allowance…")).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain("Allowance could not load.");
    expect(screen.queryByText("Loading allowance…")).toBeNull();
  });
});
