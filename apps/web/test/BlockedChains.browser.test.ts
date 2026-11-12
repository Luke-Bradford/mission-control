// @vitest-environment node
import type { ChainNode, DependencyChain } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, HOUR, METRICS_VIEW, NOW, REPOS, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();

/** The Design section's viewports the ticket names. */
const SIZES = [
  [1920, 940],
  [1920, 1080],
  [2560, 1440],
] as const;
const THEMES = ["light", "dark"] as const;
const PANEL_MIN = 360;

const node = (ref: string, over: Partial<ChainNode> = {}): ChainNode => ({
  ref,
  title: `Change ${ref}`,
  edge: "depends",
  waitedMs: HOUR,
  alsoWaitsOn: [],
  children: [],
  ...over,
});
/** Twelve chains, a few with more than 5 dependents, so the list is longer than any panel. */
const chains: DependencyChain[] = Array.from({ length: 12 }, (_, i) => ({
  repoId: "shop-app",
  root: node(`shop-app#${100 + i}`, {
    edge: null,
    children: Array.from({ length: i % 3 === 0 ? 7 : 2 }, (_, k) =>
      node(`shop-app#${200 + i * 10 + k}`),
    ),
  }),
  state: i % 4 === 0 ? "stuck" : i % 4 === 1 ? "with-you" : "moving",
  reason: "No owner for the next step",
  owner: i % 4 === 1 ? "You" : "RETRO",
  seatId: i % 4 === 1 ? null : "retro-1",
  longestWaitMs: (40 - i) * HOUR,
  frees: ["shop-app#1"],
  stillWaiting: [],
}));

const api = {
  "/api/operator/bootstrap": { token: "fixture-token" },
  "/api/dependencies": chains,
  "/api/prs/flow": { generatedAt: NOW, repos: [] },
  "/api/config": CONFIG,
  "/api/repos": REPOS,
  "/api/metrics": METRICS_VIEW,
  "/api/settings/crew-pause": null,
  "/api/flight": {
    seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
    decisions: [],
  },
  "/api/attention": [],
  "/api/attention/held": [],
  "/api/notifications": { open: [], handledToday: [] },
  "/api/crew?shape=summary": {
    rows: Array.from({ length: 11 }, (_, i) =>
      seatRow({ id: `guido-${i + 1}`, hudState: "blocked", ticket: `shop-app#${i + 5}` }),
    ),
    firstRunToday: null,
  },
};

describeRendered("Blocked chains in a browser", () => {
  for (const theme of THEMES) {
    it(
      `keeps its 360 px floor, scrolls inside itself and adds no page overflow: ${theme}`,
      async () => {
        for (const [width, height] of SIZES) {
          const label = `${width}x${height} ${theme}`;
          const page = await renderAt({
            page: "test/flightBrowser.html",
            width,
            height,
            colorScheme: theme,
            search: `?theme=${theme}`,
            api,
          });
          try {
            await page.click("#flight-tab-crew");
            await page.boxes("#chainsP .bc-row");
            const m = await page.evaluate(() => {
              const root = document.scrollingElement ?? document.documentElement;
              const panel = document.getElementById("chainsP") as HTMLElement;
              const scroll = panel.querySelector<HTMLElement>(".bc-scroll") as HTMLElement;
              const seats = document.getElementById("wifP") as HTMLElement;
              return {
                pageOverflow: root.scrollHeight - root.clientHeight,
                sideways: root.scrollWidth - root.clientWidth,
                panelHeight: panel.getBoundingClientRect().height,
                panelClipped: panel.scrollHeight - panel.clientHeight,
                listScrolls: scroll.scrollHeight - scroll.clientHeight,
                seatsHeight: seats.getBoundingClientRect().height,
                headers: [...panel.querySelectorAll("th")].map((th) => th.textContent),
              };
            }, undefined);
            expect(m.pageOverflow, label).toBeLessThanOrEqual(0);
            expect(m.sideways, label).toBeLessThanOrEqual(0);
            expect(m.panelHeight, label).toBeGreaterThanOrEqual(PANEL_MIN - 0.5);
            expect(m.panelClipped, label).toBeLessThanOrEqual(1);
            expect(m.listScrolls, label).toBeGreaterThan(0);
            expect(m.seatsHeight, label).toBeGreaterThan(0);
            expect(m.headers, label).toEqual([
              "Work",
              "State",
              "What holds it",
              "Next owner",
              "Waited ▼",
              "Merge frees",
            ]);
            if (page.errors().length) throw new Error(page.errors().join("; "));
          } finally {
            await page.close();
          }
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 3,
    );
  }
});
